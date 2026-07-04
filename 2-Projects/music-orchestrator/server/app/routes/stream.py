"""流代理路由 (/stream)

GET /stream/{source}/{track_id}

边下边流：上游字节经 ffmpeg 剥离视频轨、只保留音频（fragmented mp4/m4a 容器，
不重新编码，`-c:a copy` 直接透传原始音频数据），一边产出给客户端一边写入缓存文件；
下载完成后原子 rename 成正式缓存，下次同一首歌直接命中缓存（Range 请求原生支持）。

已知简化（有意为之，不算 bug）：
- 首次流式请求不支持 Range（用户点播不会去 seek 一首还没下完的新歌，这个场景优先级低）；
  缓存命中后走 FileResponse，Range 原生支持。
- 两个并发请求同一首「从未缓存过」的歌时会各自触发一次下载（无 leader/follower 去重），
  对个人自用场景概率极低，不为此增加协调复杂度。
"""

import asyncio
import contextlib
import logging
from typing import AsyncIterator, Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse, StreamingResponse

from app.cache import LRUFileCache
from app.config import config
from app.sources import get_source_by_name

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["stream"])

_cache = LRUFileCache(config.cache_dir, config.cache_max_mb)

AUDIO_MEDIA_TYPE = "audio/mp4"  # 音频轨道装在 fragmented mp4(m4a) 容器里


def require_music_key(x_music_key: Optional[str] = Header(None)):
    if not config.music_key or x_music_key != config.music_key:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Music-Key")
    return x_music_key


async def _fetch_transcode_and_cache(
    direct_url: str, headers: dict[str, str], key: str
) -> AsyncIterator[bytes]:
    """核心管道：httpx 流式拉取上游字节 → ffmpeg 剥离视频只留音频 → 边 yield 边写临时缓存文件。

    完成后原子 finalize 缓存；中途失败（上游断/ffmpeg 挂/客户端断开）清理临时文件，
    不留半成品污染缓存目录。
    """
    tmp_path = _cache.tmp_path_for(key)

    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",  # 丢弃视频轨
        "-c:a",
        "copy",  # 音频不重新编码，直接透传（快、零质量损失）
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",  # 分片 mp4，支持边写边读不需回写 moov
        "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )

    async def _feed_upstream() -> None:
        try:
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                async with client.stream("GET", direct_url, headers=headers) as resp:
                    if resp.status_code >= 400:
                        raise HTTPException(
                            status_code=502, detail=f"Upstream returned {resp.status_code}"
                        )
                    async for chunk in resp.aiter_bytes():
                        if proc.stdin and not proc.stdin.is_closing():
                            proc.stdin.write(chunk)
                            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            if proc.stdin and not proc.stdin.is_closing():
                with contextlib.suppress(Exception):
                    proc.stdin.close()

    feeder = asyncio.create_task(_feed_upstream())

    tmp_file = tmp_path.open("wb")
    success = False
    try:
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            tmp_file.write(chunk)
            yield chunk
        await feeder
        rc = await proc.wait()
        success = rc == 0
    finally:
        tmp_file.close()
        feeder.cancel()
        with contextlib.suppress(Exception):
            if proc.stdin and not proc.stdin.is_closing():
                proc.stdin.close()
        with contextlib.suppress(Exception):
            proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()

        if success:
            _cache.finalize(key, tmp_path)
        else:
            _cache.discard_tmp(tmp_path)
            logger.warning(f"stream transcode failed or interrupted for key={key}")


@router.get("/{source}/{track_id}")
async def stream_audio(
    source: str,
    track_id: str,
    _: str = Depends(require_music_key),
):
    key = f"{source}:{track_id}"

    if _cache.has(key):
        _cache.touch(key)
        path = _cache.path_for(key)
        return FileResponse(path, media_type=AUDIO_MEDIA_TYPE)

    src = get_source_by_name(source)
    if src is None:
        raise HTTPException(status_code=404, detail=f"Unknown source: {source}")

    # resolve 在生成流式响应之前做：一旦 StreamingResponse 开始返回 200，
    # HTTP 状态码就无法再改——失败必须在这里就返回明确错误，不能留到流里才报错。
    try:
        direct_url = await src.resolve(track_id)
    except Exception as e:
        logger.warning(f"resolve failed: source={source} id={track_id} err={e}")
        raise HTTPException(status_code=502, detail="Failed to resolve stream url")

    headers = src.download_headers()
    return StreamingResponse(
        _fetch_transcode_and_cache(direct_url, headers, key),
        media_type=AUDIO_MEDIA_TYPE,
    )
