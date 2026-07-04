"""配置模块 - 环境变量驱动"""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Config:
    music_key: str
    music_admin_key: str
    cache_dir: str
    cache_max_mb: int
    enabled_sources: list[str]
    bilibili_sessdata: str  # 可选：B站 SESSDATA cookie，未配置时匿名请求（见 resolve 412 风险说明）


def load_config() -> Config:
    music_key = os.getenv("MUSIC_KEY", "")
    music_admin_key = os.getenv("MUSIC_ADMIN_KEY", "")
    cache_dir = os.getenv("CACHE_DIR", "./cache")
    cache_max_mb = int(os.getenv("CACHE_MAX_MB", "5000"))
    enabled_sources_str = os.getenv("ENABLED_SOURCES", "bilibili")
    enabled_sources = [s.strip() for s in enabled_sources_str.split(",") if s.strip()]
    bilibili_sessdata = os.getenv("BILIBILI_SESSDATA", "")

    return Config(
        music_key=music_key,
        music_admin_key=music_admin_key,
        cache_dir=cache_dir,
        cache_max_mb=cache_max_mb,
        enabled_sources=enabled_sources,
        bilibili_sessdata=bilibili_sessdata,
    )


# 全局配置实例
config = load_config()
