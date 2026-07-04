"""体验引擎层(可插拔 / 变)。

三档同一组契约事件(经各自 ``adapters`` 归一化),记忆内核零改动复用:
- Tier A Cascade ★MVP / Tier B 托管 Realtime / Tier C 自托管双流。
"""

from .base import EngineEvent, ExperienceEngine, Tier
from .factory import build_engine
from .tier_a_cascade import TierACascadeEngine
from .tier_b_realtime import TierBRealtimeEngine
from .tier_c_duplex import TierCDuplexEngine

__all__ = [
    "Tier",
    "EngineEvent",
    "ExperienceEngine",
    "build_engine",
    "TierACascadeEngine",
    "TierBRealtimeEngine",
    "TierCDuplexEngine",
]
