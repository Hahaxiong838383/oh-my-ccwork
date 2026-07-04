"""LiveKit AgentSession → ``EngineEvent`` 桥接。

M0 的目标不是把所有 provider 都封死,而是先把真实 LiveKit 会话里的关键事件
稳定翻成项目内部的引擎事件,让 ``LiveKitAdapter`` 后续统一落到契约层。
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from .base import EngineEvent

EmitEngineEvent = Callable[[EngineEvent], Awaitable[None] | None]


@dataclass(slots=True)
class LiveKitEventBridge:
    """把 LiveKit session 公共事件转换成内部 ``EngineEvent``。

    ``emit`` 可同步或异步,生产环境接 ``asyncio.Queue.put``;单测可接 list.append。
    """

    emit: EmitEngineEvent
    active_turn_id: str | None = None
    active_item_id: str | None = None

    def user_state_changed(self, event: Any) -> None:
        if str(getattr(event, "new_state", "")) != "speaking":
            return
        turn_id = self._ensure_turn_id()
        self._emit(
            "user_speech_started",
            turn_id=turn_id,
            ts=_event_ts(event),
        )

    def user_input_transcribed(self, event: Any) -> None:
        turn_id = self._ensure_turn_id()
        is_final = bool(getattr(event, "is_final", False))
        item_id = self._ensure_item_id() if is_final else None
        payload: dict[str, Any] = {
            "turn_id": turn_id,
            "text": str(getattr(event, "transcript", "")),
            "ts": _event_ts(event),
            "language": _opt_str(getattr(event, "language", None)),
            "speaker_id": _opt_str(getattr(event, "speaker_id", None)),
        }
        if item_id is not None:
            payload["item_id"] = item_id
        self._emit(
            "user_transcript_final" if is_final else "user_transcript_interim",
            **payload,
        )

    def conversation_item_added(self, event: Any) -> None:
        item = getattr(event, "item", None)
        role = str(getattr(item, "role", ""))
        if role not in {"user", "assistant"}:
            return
        text = _extract_item_text(item)
        if not text:
            return
        item_id = str(getattr(item, "id", "")) or self._ensure_item_id()
        ts = _event_ts(event)
        if role == "user":
            turn_id = self._ensure_turn_id()
            self._emit(
                "user_turn_committed",
                turn_id=turn_id,
                item_id=item_id,
                final_text=text,
                ts=ts,
            )
            self.active_turn_id = None
            self.active_item_id = None
            return
        self._emit(
            "agent_transcript_final",
            turn_id=self._ensure_turn_id(prefix="agent"),
            item_id=item_id,
            text=text,
            ts=ts,
        )

    def agent_state_changed(self, event: Any) -> None:
        new_state = str(getattr(event, "new_state", ""))
        if new_state == "speaking":
            self._emit(
                "agent_speech_started",
                turn_id=self._ensure_turn_id(prefix="agent"),
                ts=_event_ts(event),
            )
        elif new_state in {"listening", "idle"}:
            self._emit(
                "agent_speech_stopped",
                turn_id=self._ensure_turn_id(prefix="agent"),
                ts=_event_ts(event),
            )

    def overlapping_speech(self, event: Any) -> None:
        self._emit(
            "interruption",
            turn_id=self._ensure_turn_id(),
            is_interruption=True,
            heard_ms=_heard_ms(event),
            ts=_event_ts(event),
        )

    def agent_false_interruption(self, event: Any) -> None:
        self._emit(
            "false_interruption",
            turn_id=self._ensure_turn_id(),
            ts=_event_ts(event),
        )

    def _ensure_turn_id(self, *, prefix: str = "turn") -> str:
        if self.active_turn_id is None:
            self.active_turn_id = f"{prefix}-{uuid4().hex}"
        return self.active_turn_id

    def _ensure_item_id(self) -> str:
        if self.active_item_id is None:
            self.active_item_id = f"item-{uuid4().hex}"
        return self.active_item_id

    def _emit(self, kind: str, **data: Any) -> None:
        result = self.emit(EngineEvent(kind=kind, data=data))
        if asyncio.iscoroutine(result):
            asyncio.create_task(result)


def _event_ts(event: Any) -> float:
    return float(getattr(event, "created_at", 0.0) or time.time())


def _opt_str(value: Any) -> str | None:
    return str(value) if value is not None else None


def _extract_item_text(item: Any) -> str:
    text_content = getattr(item, "text_content", None)
    if text_content:
        return str(text_content)
    content = getattr(item, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            transcript = getattr(part, "transcript", None)
            if transcript:
                parts.append(str(transcript))
            elif isinstance(part, str):
                parts.append(part)
            else:
                text = getattr(part, "text", None)
                if text:
                    parts.append(str(text))
        return "".join(parts)
    return ""


def _heard_ms(event: Any) -> int:
    for attr in ("heard_ms", "audio_duration_ms", "duration_ms"):
        value = getattr(event, attr, None)
        if value is not None:
            return int(value)
    for attr in ("audio_duration", "duration"):
        value = getattr(event, attr, None)
        if value is not None:
            return int(float(value) * 1000)
    return 0


__all__ = ["LiveKitEventBridge", "EmitEngineEvent"]
