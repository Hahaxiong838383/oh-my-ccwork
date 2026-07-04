"""适配层(每 Tier 一个)——引擎事件 → 归一化契约。

- ``LiveKitAdapter``:Tier A,turn 边界清晰,逐条映射。
- ``SidecarTurnSynthesizer``:Tier B/C,旁挂 STT + turn detector 合成 ``UserTurnCommitted``。
"""

from .base import ExperienceEngineAdapter
from .livekit_adapter import LiveKitAdapter, extract_text
from .sidecar_stt import SidecarTurnSynthesizer

__all__ = [
    "ExperienceEngineAdapter",
    "LiveKitAdapter",
    "SidecarTurnSynthesizer",
    "extract_text",
]
