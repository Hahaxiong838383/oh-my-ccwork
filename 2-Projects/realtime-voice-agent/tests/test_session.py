"""会话编排:引擎 ↔ 适配器 ↔ 内核(ARCHITECTURE.md §2/§7.1)。

异步测试(``asyncio_mode=auto``,无需显式标记)。
"""

from voice_agent.adapters import LiveKitAdapter
from voice_agent.config import Settings
from voice_agent.contract.events import UserTurnCommitted
from voice_agent.engines.base import EngineEvent
from voice_agent.engines.tier_a_cascade import TierACascadeEngine
from voice_agent.kernel import Extractor, MemoryFact, MemoryKernel, Provenance, SourceTier
from voice_agent.pipeline import VoiceSession


class _StubExtractor(Extractor):
    def extract(self, committed: UserTurnCommitted) -> list[MemoryFact]:
        prov = Provenance(
            turn_id=committed.turn_id,
            item_id=committed.item_id,
            source=SourceTier.USER_STATED,
            confidence=0.9,
            ts=committed.ts,
        )
        return [MemoryFact(key="last_said", value=committed.final_text, provenance=prov)]


def _session() -> VoiceSession:
    engine = TierACascadeEngine(Settings())
    return VoiceSession(engine, LiveKitAdapter(), MemoryKernel(extractor=_StubExtractor()))


async def test_feed_commits_and_injects_context() -> None:
    session = _session()
    raw = EngineEvent(
        kind="user_turn_committed",
        data={"turn_id": "t1", "item_id": "i1", "final_text": "我喜欢火箭", "ts": 1.0},
    )
    event = await session.feed(raw)
    assert isinstance(event, UserTurnCommitted)
    assert session.kernel.working_set.facts().get("last_said") == "我喜欢火箭"


async def test_feed_unknown_event_is_noop() -> None:
    session = _session()
    assert await session.feed(EngineEvent(kind="audio_frame", data={})) is None


async def test_run_empty_stream_completes() -> None:
    # 骨架引擎事件为空流 → run 正常返回不崩(start/aclose 走通)。
    session = _session()
    await session.run()
