"""适配层:LiveKit 事件→契约映射 + Tier B/C 旁挂合成(ARCHITECTURE.md §3/§9)。"""

from voice_agent.adapters import LiveKitAdapter, SidecarTurnSynthesizer, extract_text
from voice_agent.contract.events import (
    Interruption,
    UserTranscriptFinal,
    UserTurnCommitted,
)
from voice_agent.engines.base import EngineEvent


def test_livekit_translates_committed() -> None:
    adapter = LiveKitAdapter()
    raw = EngineEvent(
        kind="user_turn_committed",
        data={"turn_id": "t1", "item_id": "i1", "final_text": "你好", "ts": 1.0},
    )
    event = adapter.translate(raw)
    assert isinstance(event, UserTurnCommitted)
    assert event.final_text == "你好"


def test_livekit_translates_interruption() -> None:
    adapter = LiveKitAdapter()
    raw = EngineEvent(
        kind="interruption",
        data={"turn_id": "t1", "is_interruption": True, "heard_ms": 500, "ts": 1.0},
    )
    event = adapter.translate(raw)
    assert isinstance(event, Interruption)
    assert event.heard_ms == 500


def test_livekit_unknown_kind_returns_none() -> None:
    adapter = LiveKitAdapter()
    assert adapter.translate(EngineEvent(kind="audio_frame", data={})) is None


def test_sidecar_synthesizes_only_on_eou() -> None:
    synth = SidecarTurnSynthesizer()
    assert (
        synth.synthesize(turn_id="t1", item_id="i1", text="x", ts=1.0, eou=False)
        is None
    )
    event = synth.synthesize(
        turn_id="t1", item_id="i1", text="说完了", ts=1.0, eou=True
    )
    assert isinstance(event, UserTurnCommitted)
    assert event.final_text == "说完了"


def test_livekit_final_carries_language_and_confidence() -> None:
    adapter = LiveKitAdapter()
    raw = EngineEvent(
        kind="user_transcript_final",
        data={
            "turn_id": "t1",
            "item_id": "i1",
            "text": "hello 世界",
            "ts": 1.0,
            "language": "zh",
            "confidence": 0.92,
        },
    )
    event = adapter.translate(raw)
    assert isinstance(event, UserTranscriptFinal)
    assert event.language == "zh"
    assert event.confidence == 0.92


def test_extract_text_handles_str_and_list() -> None:
    # 证据 #1792:conversation_item content 可能是 list
    assert extract_text("hi") == "hi"
    assert (
        extract_text([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}])
        == "ab"
    )
    assert extract_text([]) == ""
