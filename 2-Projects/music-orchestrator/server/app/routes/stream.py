"""流代理路由 (/stream)

GET /stream/{source}/{track_id}

MVP 简化说明：
- 先完整下载到缓存文件，再用 FileResponse 返回。
- 不做边下边传的真流式（已知简化，后续可改成 StreamingResponse + chunk 转发）。
- 使用 Starlette 内置的 FileResponse，它原生支持 Range 请求。
"""

import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse

from app.cache import LRUFileCache
from app.config import config
from app.sources import get_source_by_name

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["stream"])

_cache = LRUFileCache(config.cache_dir, config.cache_max_mb)


def require_music_key(x_music_key: Optional[str] = Header(None)):
    if not config.music_key or x_music_key != config.music_key:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Music-Key")
    return x_music_key


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
        return FileResponse(path, media_type="audio/mpeg")

    # 解析直链
    src = get_source_by_name(source)
    if src is None:
        raise HTTPException(status_code=404, detail=f"Unknown source: {source}")

    try:
        direct_url = await src.resolve(track_id)
    except Exception as e:
        logger.warning(f"resolve failed: source={source} id={track_id} err={e}")
        raise HTTPException(status_code=502, detail="Failed to resolve stream url")

    # 下载到缓存
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            resp = await client.get(direct_url)
            if resp.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Upstream returned {resp.status_code}")
            content = resp.content
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Upstream timeout")
    except Exception as e:
        logger.warning(f"download failed: {e}")
        raise HTTPException(status_code=502, detail="Download failed")

    # 写入缓存
    try:
        _cache.write_file(key, content)
    except Exception as e:
        logger.warning(f"cache write failed: {e}")

    path = _cache.path_for(key)
    # 写入后可能被 prune 删掉，兜底
    if not path.exists():
        # 直接返回内存（极少情况）
        from fastapi.responses import Response
        return Response(content=content, media_type="audio/mpeg")

    return FileResponse(path, media_type="audio/mpeg")
