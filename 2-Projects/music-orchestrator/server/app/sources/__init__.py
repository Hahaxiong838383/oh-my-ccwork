"""Source 注册中心"""

import logging
from typing import Optional

from app.config import config
from app.sources.base import Source
from app.sources.bilibili import BilibiliSource
from app.sources.netease import NeteaseSource
from app.sources.ytmusic import YTMusicSource

logger = logging.getLogger(__name__)

# 全局实例映射
_source_instances: dict[str, Source] = {}


def _create_source(name: str) -> Optional[Source]:
    name = name.lower()
    if name == "bilibili":
        return BilibiliSource()
    if name == "ytmusic":
        return YTMusicSource()
    if name == "netease":
        return NeteaseSource()
    return None


def get_enabled_sources() -> list[Source]:
    """根据 ENABLED_SOURCES 配置返回已实例化的 Source 列表。"""
    enabled = []
    for name in config.enabled_sources:
        if name not in _source_instances:
            inst = _create_source(name)
            if inst is not None:
                _source_instances[name] = inst
            else:
                logger.warning(f"Unknown source in ENABLED_SOURCES: {name}")
        if name in _source_instances:
            enabled.append(_source_instances[name])
    return enabled


def get_source_by_name(name: str) -> Optional[Source]:
    name = name.lower()
    if name not in _source_instances:
        inst = _create_source(name)
        if inst is not None:
            _source_instances[name] = inst
    return _source_instances.get(name)
