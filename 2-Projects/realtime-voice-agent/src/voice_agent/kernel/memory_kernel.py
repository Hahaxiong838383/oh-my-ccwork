"""记忆内核门面(ARCHITECTURE.md §6/§7)——消费归一化契约,编排 CQRS。

唯一提交点 = ``UserTurnCommitted``;``interim`` 永远 DRAFT;打断 = 零成本回滚。
失败模式(§6)全部落在这条编排上:幂等去重 / 迟到 final 对账 /
backchannel 三闸 / 打断不污染。**跨体验引擎零改动复用**。
"""

from __future__ import annotations

from ..contract.events import (
    AgentTranscriptFinal,
    ContractEvent,
    FalseInterruption,
    Interruption,
    UserSpeechStarted,
    UserTranscriptFinal,
    UserTranscriptInterim,
    UserTurnCommitted,
)
from ..contract.types import CONFIDENCE_FLOOR_DEFAULT, Confidence
from .arbitration import SourceArbiter
from .draft import DraftStore
from .event_log import EventLog, make_idempotency_key
from .extraction import Extractor
from .model import AgentTurn, MemoryFact
from .projections import NullVectorIndex, VectorIndex, WorkingSet


class MemoryKernel:
    """归一化契约事件的消费者。只在 committed + 抽取完成时写真值。"""

    def __init__(
        self,
        *,
        log: EventLog | None = None,
        draft_store: DraftStore | None = None,
        working_set: WorkingSet | None = None,
        arbiter: SourceArbiter | None = None,
        extractor: Extractor | None = None,
        vector_index: VectorIndex | None = None,
        confidence_floor: Confidence = CONFIDENCE_FLOOR_DEFAULT,
    ) -> None:
        self.log: EventLog = log or EventLog()
        self.drafts: DraftStore = draft_store or DraftStore()
        self.working_set: WorkingSet = working_set or WorkingSet()
        self.arbiter: SourceArbiter = arbiter or SourceArbiter()
        self.extractor: Extractor = extractor or Extractor(confidence_floor)
        self.vector_index: VectorIndex = vector_index or NullVectorIndex()

    def handle(self, event: ContractEvent) -> None:
        """归一化契约事件入口。按类型 dispatch,只在 committed 写真值。"""
        if isinstance(event, UserSpeechStarted):
            self.drafts.open_turn(event.turn_id)
        elif isinstance(event, UserTranscriptInterim):
            self.drafts.update_interim(event.turn_id, event.text)  # DRAFT,不提交
        elif isinstance(event, UserTranscriptFinal):
            # COMMIT 候选;对账靠 item_id / turn_id,真正提交等 turn_committed。
            pass
        elif isinstance(event, UserTurnCommitted):
            self._commit_user_turn(event)
        elif isinstance(event, Interruption):
            self.drafts.discard(event.turn_id)  # 零成本回滚,记忆不动
        elif isinstance(event, FalseInterruption):
            pass  # 假打断 → 不动记忆
        elif isinstance(event, AgentTranscriptFinal):
            self._record_agent_turn(event)
        else:
            # AgentSpeechStarted / AgentSpeechStopped:状态机推进,记忆不写。
            pass

    def _commit_user_turn(self, event: UserTurnCommitted) -> None:
        draft = self.drafts.commit(event.turn_id, event.final_text)
        if draft is None:
            return  # 该 turn 已被打断丢弃 → 迟到 commit 一并丢弃
        # backchannel 文本闸:纯应答词不进抽取。
        if self.extractor.is_backchannel(event.final_text):
            return
        for fact in self.extractor.extract(event):
            self._commit_fact(fact)

    def _commit_fact(self, fact: MemoryFact) -> None:
        # 置信度门:低于 floor 的不进真值(进 low-confidence,骨架略)。
        if fact.provenance.confidence < self.extractor.floor():
            return
        existing = self.working_set.get_fact(fact.key)
        winner = self.arbiter.arbitrate(existing, fact)
        key = make_idempotency_key(
            winner.provenance.turn_id, f"{winner.key}={winner.value}"
        )
        record = self.log.append(winner, key, winner.provenance.ts)
        if record is not None:  # 非幂等重复
            self.working_set.apply(record)
            self.vector_index.index(record)

    def _record_agent_turn(self, event: AgentTranscriptFinal) -> None:
        turn = AgentTurn(
            turn_id=event.turn_id,
            item_id=event.item_id,
            text=event.text,
            ts=event.ts,
        )
        key = make_idempotency_key(event.turn_id, f"agent:{event.item_id}")
        record = self.log.append(turn, key, event.ts)
        if record is not None:
            self.working_set.apply(record)

    def context(self) -> str:
        """注入热路径的当前上下文。"""
        return self.working_set.context()

    def replay_rebuild(self) -> None:
        """从 Event Log 重建投影(审计 / 灾后恢复)。"""
        self.working_set.rebuild_from(self.log.replay())
