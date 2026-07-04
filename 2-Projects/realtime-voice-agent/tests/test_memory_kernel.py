"""记忆内核编排不变量(ARCHITECTURE.md §6/§7):

只在 committed 写真值 / 打断不污染 / 假打断不动 / backchannel 不提交 /
低置信不进真值 / agent 回合记录。
"""

from voice_agent.contract.events import (
    AgentTranscriptFinal,
    FalseInterruption,
    Interruption,
    UserSpeechStarted,
    UserTranscriptInterim,
    UserTurnCommitted,
)
from voice_agent.contract.types import ItemId, TurnId
from voice_agent.kernel import Extractor, MemoryFact, MemoryKernel, Provenance, SourceTier


class _StubExtractor(Extractor):
    """测试桩:每个 committed 抽出一条 ``last_said`` 事实。"""

    def extract(self, committed: UserTurnCommitted) -> list[MemoryFact]:
        prov = Provenance(
            turn_id=committed.turn_id,
            item_id=committed.item_id,
            source=SourceTier.USER_STATED,
            confidence=0.9,
            ts=committed.ts,
        )
        return [MemoryFact(key="last_said", value=committed.final_text, provenance=prov)]


class _LowConfExtractor(Extractor):
    def extract(self, committed: UserTurnCommitted) -> list[MemoryFact]:
        prov = Provenance(
            turn_id=committed.turn_id,
            item_id=committed.item_id,
            source=SourceTier.LOW_CONFIDENCE,
            confidence=0.3,
            ts=committed.ts,
        )
        return [MemoryFact(key="x", value="y", provenance=prov)]


def _committed(turn: str = "t1", text: str = "我喜欢乌龟") -> UserTurnCommitted:
    return UserTurnCommitted(
        turn_id=TurnId(turn), item_id=ItemId("i1"), final_text=text, ts=1.0
    )


def test_commit_writes_truth() -> None:
    kernel = MemoryKernel(extractor=_StubExtractor())
    kernel.handle(UserSpeechStarted(turn_id=TurnId("t1"), ts=0.0))
    kernel.handle(_committed())
    assert kernel.working_set.facts().get("last_said") == "我喜欢乌龟"
    assert len(kernel.log) == 1


def test_interrupt_does_not_pollute() -> None:
    kernel = MemoryKernel(extractor=_StubExtractor())
    kernel.handle(UserSpeechStarted(turn_id=TurnId("t1"), ts=0.0))
    kernel.handle(UserTranscriptInterim(turn_id=TurnId("t1"), text="我想", ts=0.5))
    kernel.handle(
        Interruption(turn_id=TurnId("t1"), is_interruption=True, heard_ms=300, ts=0.6)
    )
    kernel.handle(_committed())  # 打断后迟到 commit
    assert len(kernel.log) == 0  # 零污染


def test_false_interruption_still_commits() -> None:
    kernel = MemoryKernel(extractor=_StubExtractor())
    kernel.handle(UserSpeechStarted(turn_id=TurnId("t1"), ts=0.0))
    kernel.handle(FalseInterruption(turn_id=TurnId("t1"), ts=0.5))  # 假打断不动 DRAFT
    kernel.handle(_committed())
    assert len(kernel.log) == 1


def test_backchannel_not_committed() -> None:
    kernel = MemoryKernel(extractor=_StubExtractor())
    kernel.handle(UserSpeechStarted(turn_id=TurnId("t1"), ts=0.0))
    kernel.handle(_committed(text="嗯"))  # backchannel 文本闸
    assert len(kernel.log) == 0


def test_low_confidence_not_committed() -> None:
    kernel = MemoryKernel(extractor=_LowConfExtractor(confidence_floor=0.6))
    kernel.handle(UserSpeechStarted(turn_id=TurnId("t1"), ts=0.0))
    kernel.handle(_committed())
    assert len(kernel.log) == 0  # 0.3 < 0.6 置信度门


def test_agent_turn_recorded() -> None:
    kernel = MemoryKernel(extractor=_StubExtractor())
    kernel.handle(
        AgentTranscriptFinal(
            turn_id=TurnId("t1"), item_id=ItemId("a1"), text="你好呀", ts=1.0
        )
    )
    assert len(kernel.log) == 1


def test_replay_rebuild_matches_live() -> None:
    kernel = MemoryKernel(extractor=_StubExtractor())
    kernel.handle(UserSpeechStarted(turn_id=TurnId("t1"), ts=0.0))
    kernel.handle(_committed(text="我喜欢火箭"))
    live = kernel.working_set.facts()
    kernel.replay_rebuild()  # 从 Event Log 重建投影
    assert kernel.working_set.facts() == live
