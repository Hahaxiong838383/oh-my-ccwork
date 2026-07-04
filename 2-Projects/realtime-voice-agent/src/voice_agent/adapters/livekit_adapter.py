"""Tier A 适配器:LiveKit 事件 → 归一化契约(ARCHITECTURE.md §3/§7.1;附录 C.2/F.3)。

LiveKit 自带语义 turn detector,turn 边界清晰,直接逐条映射。
M0 只需把 LiveKit ``AgentSession`` 回调封成 ``EngineEvent(kind, data)`` 喂进来——
本适配器是纯函数,可脱离 SDK 单测。

M0 接线图(LiveKit 真实事件 → kind,事件名/属性核对 E3,附录 F.3):
- ``user_state_changed``(new_state=speaking)                  → ``user_speech_started``
- ``user_input_transcribed``(transcript/is_final/language/    → ``user_transcript_interim``
  speaker_id)                                                   / ``user_transcript_final``
- ``conversation_item_added``(role=user;item.id;item.content  → ``user_turn_committed``
  可能是 list,用 ``extract_text`` 提取,证据 #1792)
- ``conversation_item_added``(role=assistant)                 → ``agent_transcript_final``
- ``overlapping_speech``(is_interruption=true)                → ``interruption``
- ``agent_false_interruption``                                → ``false_interruption``
- ``agent_state_changed``(new_state=speaking)                 → ``agent_speech_started``

``data`` 约定字段(M0 桥接时填):
- ``turn_id``/``item_id``/``text``/``final_text``/``ts``/``speaker_id``/``language``/``confidence``
- ``is_interruption``/``heard_ms``
"""

from __future__ import annotations

from typing import Any

from ..contract.events import (
    AgentSpeechStarted,
    AgentSpeechStopped,
    AgentTranscriptFinal,
    ContractEvent,
    FalseInterruption,
    Interruption,
    UserSpeechStarted,
    UserTranscriptFinal,
    UserTranscriptInterim,
    UserTurnCommitted,
)
from ..contract.types import ItemId, SpeakerId, TurnId
from ..engines.base import EngineEvent
from .base import ExperienceEngineAdapter


def extract_text(content: object) -> str:
    """LiveKit ``conversation_item`` 文本提取。

    证据 #1792:``content`` 可能是 ``[{'type':'text','text':'...'}]`` 而非字符串。
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            str(c.get("text", "")) if isinstance(c, dict) else str(c) for c in content
        )
    return str(getattr(content, "text", content))


def _opt_str(value: Any) -> str | None:
    return str(value) if value is not None else None


def _opt_float(value: Any) -> float | None:
    return float(value) if value is not None else None


class LiveKitAdapter(ExperienceEngineAdapter):
    def translate(self, raw: EngineEvent) -> ContractEvent | None:
        d: dict[str, Any] = raw.data
        turn_id = TurnId(str(d["turn_id"])) if "turn_id" in d else None

        if raw.kind == "user_speech_started" and turn_id is not None:
            return UserSpeechStarted(turn_id=turn_id, ts=float(d["ts"]))

        if raw.kind == "user_transcript_interim" and turn_id is not None:
            return UserTranscriptInterim(
                turn_id=turn_id,
                text=str(d["text"]),
                ts=float(d["ts"]),
                language=_opt_str(d.get("language")),
            )

        if raw.kind == "user_transcript_final" and turn_id is not None:
            sid = d.get("speaker_id")
            return UserTranscriptFinal(
                turn_id=turn_id,
                item_id=ItemId(str(d["item_id"])),
                text=str(d["text"]),
                ts=float(d["ts"]),
                speaker_id=SpeakerId(str(sid)) if sid is not None else None,
                language=_opt_str(d.get("language")),
                confidence=_opt_float(d.get("confidence")),
            )

        if raw.kind == "user_turn_committed" and turn_id is not None:
            return UserTurnCommitted(
                turn_id=turn_id,
                item_id=ItemId(str(d["item_id"])),
                final_text=str(d["final_text"]),
                ts=float(d["ts"]),
            )

        if raw.kind == "interruption" and turn_id is not None:
            return Interruption(
                turn_id=turn_id,
                is_interruption=bool(d.get("is_interruption", True)),
                heard_ms=int(d.get("heard_ms", 0)),
                ts=float(d["ts"]),
            )

        if raw.kind == "false_interruption" and turn_id is not None:
            return FalseInterruption(turn_id=turn_id, ts=float(d["ts"]))

        if raw.kind == "agent_speech_started" and turn_id is not None:
            return AgentSpeechStarted(turn_id=turn_id, ts=float(d["ts"]))

        if raw.kind == "agent_speech_stopped" and turn_id is not None:
            return AgentSpeechStopped(turn_id=turn_id, ts=float(d["ts"]))

        if raw.kind == "agent_transcript_final" and turn_id is not None:
            return AgentTranscriptFinal(
                turn_id=turn_id,
                item_id=ItemId(str(d["item_id"])),
                text=str(d["text"]),
                ts=float(d["ts"]),
            )

        return None  # 未知 kind / 纯音频帧 → 不进契约


__all__ = ["LiveKitAdapter", "extract_text"]
