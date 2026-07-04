"""DRAFT 状态机 — interrupt-safe 的核心(ARCHITECTURE.md §3/§7.2)。

不变量:
- 写记忆**只在 ``user.turn_committed``**;``interim`` 永远只是 DRAFT。
- 打断 = **零成本回滚**:丢弃未提交的 DRAFT,记忆真值不受任何影响。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from ..contract.types import TurnId


class DraftState(Enum):
    DRAFTING = "drafting"  # 累积 interim,未提交
    COMMITTED = "committed"  # 唯一提交点已过
    DISCARDED = "discarded"  # 打断 / 假打断丢弃(零成本)


@dataclass
class TurnDraft:
    turn_id: TurnId
    state: DraftState = DraftState.DRAFTING
    interim_text: str = ""
    final_text: str | None = None


class DraftStore:
    """按 ``turn_id`` 维持 DRAFT。未 COMMIT 的随时可零成本丢弃(interrupt-safe)。"""

    def __init__(self) -> None:
        self._drafts: dict[TurnId, TurnDraft] = {}

    def open_turn(self, turn_id: TurnId) -> TurnDraft:
        draft = TurnDraft(turn_id=turn_id)
        self._drafts[turn_id] = draft
        return draft

    def update_interim(self, turn_id: TurnId, text: str) -> None:
        """维持 DRAFT —— **不提交**。turn 不存在则惰性开。"""
        draft = self._drafts.get(turn_id)
        if draft is None:
            draft = self.open_turn(turn_id)
        if draft.state is DraftState.DRAFTING:
            draft.interim_text = text

    def commit(self, turn_id: TurnId, final_text: str) -> TurnDraft | None:
        """唯一提交点。未见 ``speech_started`` 也可提交(EOU 有效,惰性开 turn);
        但已 ``COMMITTED``(重复)或 ``DISCARDED``(打断)的返回 ``None`` 一并丢弃。"""
        draft = self._drafts.get(turn_id)
        if draft is None:
            draft = self.open_turn(turn_id)
        if draft.state is not DraftState.DRAFTING:
            return None
        draft.state = DraftState.COMMITTED
        draft.final_text = final_text
        return draft

    def discard(self, turn_id: TurnId) -> None:
        """丢弃 DRAFT(打断 / 假打断)——零成本回滚。已提交的不动。"""
        draft = self._drafts.get(turn_id)
        if draft is not None and draft.state is DraftState.DRAFTING:
            draft.state = DraftState.DISCARDED

    def get(self, turn_id: TurnId) -> TurnDraft | None:
        return self._drafts.get(turn_id)

    def is_committable(self, turn_id: TurnId) -> bool:
        draft = self._drafts.get(turn_id)
        return draft is not None and draft.state is DraftState.DRAFTING
