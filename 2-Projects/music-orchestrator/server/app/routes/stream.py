"""流代理路由 (/stream)

GET /stream/{source}/{track_id}

边下边流：上游字节经 ffmpeg 剥离视频轨 + **统一重编码成 MP3**，一边产出给客户端
一边写入缓存文件；下载完成后原子 rename 成正式缓存，下次命中缓存直接 FileResponse（Range 原生支持）。

为什么重编码成 MP3 而不是 `-c:a copy` 透传（2026-07-04 真机踩坑后改）：
- B 站不同视频音轨编码不一（普通 aac / Dolby `_da2` / 其它），`-c:a copy` 进 fragmented mp4
  muxer 对某些编码会**卡死不产出分片**（实测 BV1d4411N7zD 首字节后 25s 零输出）。重编码成 MP3
  无视源编码、输出永远一致。
- MP3 渐进流是所有浏览器 `<audio>`（含 WKWebView）原生支持的最稳格式，不需要 Range/moov，
  直接边收边播。代价=音频重编码 CPU（很轻）+ 可忽略的音质损失（192k）。

已知简化（有意为之）：
- 首次流式请求不支持 Range（点播不会 seek 一首还没下完的新歌）；缓存命中后 FileResponse 支持 Range。
- 两个并发请求同一首未缓存的歌各自触发一次下载（无去重），个人自用概率极低，不为此加协调复杂度。
"""

import asyncio
import contextlib
import logging
from typing import AsyncIterator, Optional

import httpx
from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse

from app.cache import LRUFileCache
from app.config import config
from app.signing import verify_stream
from app.sources import get_source_by_name

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["stream"])

_cache = LRUFileCache(config.cache_dir, config.cache_max_mb)

AUDIO_MEDIA_TYPE = "audio/mpeg"  # 统一重编码成 MP3（渐进流，<audio> 全兼容）


def _authed(source: str, track_id: str, token: Optional[str], exp: Optional[int], x_music_key: Optional[str]) -> bool:
    """双路鉴权：header（服务端 httpx 客户端，如 voice-agent）或签名 token（浏览器 `<audio>`）。"""
    # header 路：voice-agent 服务端拉流带 X-Music-Key
    if config.music_key and x_music_key == config.music_key:
        return True
    # token 路：music_play 签发的短时 token，绑定本 source/track_id（浏览器 <audio> 用）
    if token and exp is not None:
        return verify_stream(source, track_id, exp, token)
    return False


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
        "libmp3lame",  # 统一重编码成 MP3（无视源编码，输出永远一致、可渐进流）
        "-b:a",
        "192k",
        "-f",
        "mp3",
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
    token: Optional[str] = Query(None),
    exp: Optional[int] = Query(None),
    x_music_key: Optional[str] = Header(None),
):
    if not _authed(source, track_id, token, exp, x_music_key):
        raise HTTPException(status_code=401, detail="unauthorized")

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
