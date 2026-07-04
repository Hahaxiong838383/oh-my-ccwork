"""管理接口路由 (/admin)"""

import logging
import time
from typing import Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from app.cache import LRUFileCache
from app.config import config
from app.sources import get_enabled_sources, get_source_by_name

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])

# 简单运行期健康计数器（每个 source 记录最近 N 次调用）
HEALTH_WINDOW = 20
_source_health: Dict[str, list[bool]] = {}  # True=success
_source_last_fail: Dict[str, Optional[float]] = {}

_start_time = time.time()

_cache = LRUFileCache(config.cache_dir, config.cache_max_mb)


def require_admin_key(x_music_admin_key: Optional[str] = Header(None)):
    if not config.music_admin_key or x_music_admin_key != config.music_admin_key:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Music-Admin-Key")
    return x_music_admin_key


def _record_call(source_name: str, success: bool):
    lst = _source_health.setdefault(source_name, [])
    lst.append(success)
    if len(lst) > HEALTH_WINDOW:
        lst.pop(0)
    if not success:
        _source_last_fail[source_name] = time.time()


def _get_ok_rate(source_name: str) -> float:
    lst = _source_health.get(source_name, [])
    if not lst:
        return 1.0
    return sum(1 for x in lst if x) / len(lst)


def _get_last_fail(source_name: str) -> Optional[float]:
    return _source_last_fail.get(source_name)


@router.get("/report")
async def admin_report(_: str = Depends(require_admin_key)):
    import yt_dlp  # type: ignore

    cache_size = 0
    item_count = 0
    for f in _cache.cache_dir.iterdir():
        if f.is_file():
            try:
                cache_size += f.stat().st_size
                item_count += 1
            except Exception:
                pass

    sources = get_enabled_sources()
    health = {}
    for s in sources:
        ok_rate = round(_get_ok_rate(s.name), 3)
        last_fail = _get_last_fail(s.name)
        health[s.name] = {
            "ok_rate": ok_rate,
            "last_fail_at": last_fail,
        }

    try:
        ydl_ver = yt_dlp.version.__version__  # type: ignore
    except Exception:
        ydl_ver = "unknown"

    return {
        "cache_size_mb": round(cache_size / (1024 * 1024), 2),
        "cache_item_count": item_count,
        "source_health": health,
        "yt_dlp_version": ydl_ver,
        "uptime_sec": int(time.time() - _start_time),
    }


class PruneRequest(BaseModel):
    target_mb: Optional[int] = None


@router.post("/prune-cache")
async def prune_cache(req: PruneRequest, _: str = Depends(require_admin_key)):
    pruned, freed = _cache.prune(req.target_mb)
    return {"pruned_items": pruned, "freed_mb": freed}


@router.post("/check-sources")
async def check_sources(_: str = Depends(require_admin_key)):
    sources = get_enabled_sources()
    result = {}
    for src in sources:
        try:
            # 极简探活：搜索一个常见词
            items = await src.search("周杰伦", 1)
            result[src.name] = "ok" if items else "degraded"
            _record_call(src.name, True)
        except Exception as e:
            logger.warning(f"check-sources {src.name} failed: {e}")
            result[src.name] = "down"
            _record_call(src.name, False)
    return result


# 供内部使用的包装（让 tools/stream 也能记录健康）
def record_source_call(source_name: str, success: bool):
    _record_call(source_name, success)
