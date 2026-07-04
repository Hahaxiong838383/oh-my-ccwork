"""DRAFT 状态机:interrupt-safe 零成本回滚(ARCHITECTURE.md §7.2)。"""

from voice_agent.contract.types import TurnId
from voice_agent.kernel.draft import DraftState, DraftStore


def test_interrupt_zero_cost_rollback() -> None:
    store = DraftStore()
    turn = TurnId("t1")
    store.open_turn(turn)
    store.update_interim(turn, "我想说")
    store.discard(turn)  # 真打断
    draft = store.get(turn)
    assert draft is not None
    assert draft.state is DraftState.DISCARDED


def test_commit_from_drafting() -> None:
    store = DraftStore()
    turn = TurnId("t1")
    store.open_turn(turn)
    committed = store.commit(turn, "我说完了")
    assert committed is not None
    assert committed.state is DraftState.COMMITTED
    assert committed.final_text == "我说完了"


def test_commit_after_discard_returns_none() -> None:
    store = DraftStore()
    turn = TurnId("t1")
    store.open_turn(turn)
    store.discard(turn)
    assert store.commit(turn, "迟到的提交") is None  # 打断后迟到 commit 丢弃


def test_commit_without_speech_started_lazy_opens() -> None:
    store = DraftStore()
    committed = store.commit(TurnId("t9"), "没有 speech_started 也是有效 EOU")
    assert committed is not None
    assert committed.state is DraftState.COMMITTED


def test_interim_keeps_drafting() -> None:
    store = DraftStore()
    turn = TurnId("t1")
    store.open_turn(turn)
    store.update_interim(turn, "half")
    assert store.is_committable(turn)
