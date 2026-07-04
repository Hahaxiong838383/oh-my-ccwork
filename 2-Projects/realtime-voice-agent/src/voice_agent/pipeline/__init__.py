"""冷热路径编排(ARCHITECTURE.md §5)。

- ``VoiceSession``:引擎 ↔ 适配器 ↔ 内核 的会话编排。
- ``ColdPathProcessor``:冷路径异步边界(不阻塞热路径回包)。
- ``LatencySample``:热路径延迟分段埋点。
"""

from .cold_path import ColdPathProcessor
from .hot_path import LatencySample
from .session import VoiceSession

__all__ = ["VoiceSession", "ColdPathProcessor", "LatencySample"]
