"""M0 LiveKit 事件桥:真实 SDK 事件形状 → EngineEvent。"""

from dataclasses import dataclass
from typing import Any

from voice_agent.engines.livekit_bridge import LiveKitEventBridge


@dataclass(slots=True)
class _Event:
    created_at: float = 1.0
    new_state: str = ""
    transcript: str = ""
    is_final: bool = False
    language: str | None = None
    speaker_id: str | None = None
    item: Any | None = None
    heard_ms: int = 0


@dataclass(slots=True)
class _Item:
    id: str
    role: str
    text_content: str
    content: list[str]


def test_bridge_emits_user_turn_flow() -> None:
    out = []
    bridge = LiveKitEventBridge(emit=out.append)
    bridge.user_state_changed(_Event(new_state="speaking"))
    bridge.user_input_transcribed(_Event(transcript="你好", is_final=False))
    bridge.user_input_transcribed(_Event(transcript="你好世界", is_final=True))
    bridge.conversation_item_added(
        _Event(item=_Item(id="i1", role="user", text_content="你好世界", content=[]))
    )

    assert [event.kind for event in out] == [
        "user_speech_started",
        "user_transcript_interim",
        "user_transcript_final",
        "user_turn_committed",
    ]
    assert out[-1].data["item_id"] == "i1"
    assert out[-1].data["final_text"] == "你好世界"


def test_bridge_emits_interruption_and_false_interruption() -> None:
    out = []
    bridge = LiveKitEventBridge(emit=out.append)
    bridge.overlapping_speech(_Event(heard_ms=250))
    bridge.agent_false_interruption(_Event())

    assert [event.kind for event in out] == ["interruption", "false_interruption"]
    assert out[0].data["heard_ms"] == 250


def test_bridge_extracts_assistant_text() -> None:
    out = []
    bridge = LiveKitEventBridge(emit=out.append)
    bridge.conversation_item_added(
        _Event(item=_Item(id="a1", role="assistant", text_content="", content=["好呀"]))
    )

    assert out[0].kind == "agent_transcript_final"
    assert out[0].data["text"] == "好呀"
