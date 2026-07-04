"""体验引擎工厂 — 按配置选 Tier(fail-fast)。"""

from __future__ import annotations

from typing import assert_never

from ..config import Settings
from .base import ExperienceEngine, Tier
from .tier_a_cascade import TierACascadeEngine
from .tier_b_realtime import TierBRealtimeEngine
from .tier_c_duplex import TierCDuplexEngine


def build_engine(settings: Settings) -> ExperienceEngine:
    """按 ``settings.voice_engine`` 构造体验引擎;非法值 → ``ValueError`` 立即失败。"""
    tier = Tier(settings.voice_engine)  # 非法字符串 fail-fast(输入验证红线)
    if tier is Tier.A_CASCADE:
        return TierACascadeEngine(settings)
    if tier is Tier.B_REALTIME:
        return TierBRealtimeEngine(settings)
    if tier is Tier.C_DUPLEX:
        return TierCDuplexEngine(settings)
    assert_never(tier)


__all__ = ["build_engine"]
