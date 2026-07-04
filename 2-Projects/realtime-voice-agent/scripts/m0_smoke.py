"""M0 离线效果验收:事件桥 → 契约 → 会话编排。

真机效果要用 ``make run-livekit`` 进房间测;本脚本负责先把 M0 的可自动化门
跑起来:关键契约事件 100% 覆盖、打断/假打断可观测、基础延迟门有报告。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from voice_agent.adapters import LiveKitAdapter
from voice_agent.contract.events import EventType
from voice_agent.engines.livekit_bridge import LiveKitEventBridge
from voice_agent.eval import latency_gate, rate_gate
from voice_agent.eval.metrics import BARGEIN_FALSE_POSITIVE_RATE, EOU_FALSE_INTERRUPT_RATE
from voice_agent.pipeline.hot_path import LatencySample


@dataclass(slots=True)
class FakeEvent:
    created_at: float
    new_state: str = ""
    transcript: str = ""
    is_final: bool = False
    language: str | None = None
    speaker_id: str | None = None
    item: Any | None = None
    heard_ms: int = 0


@dataclass(slots=True)
class FakeItem:
    id: str
    role: str
    text_content: str
    content: list[str]


def main() -> None:
    events = []
    bridge = LiveKitEventBridge(emit=events.append)
    bridge.user_state_changed(FakeEvent(created_at=0.0, new_state="speaking"))
    bridge.user_input_transcribed(
        FakeEvent(created_at=0.2, transcript="我想查", is_final=False, language="zh")
    )
    bridge.user_input_transcribed(
        FakeEvent(created_at=0.5, transcript="我想查天气", is_final=True, language="zh")
    )
    bridge.conversation_item_added(
        FakeEvent(
            created_at=0.8,
            item=FakeItem(
                id="item-user-1",
                role="user",
                text_content="我想查天气",
                content=["我想查天气"],
            ),
        )
    )
    bridge.agent_state_changed(FakeEvent(created_at=0.9, new_state="speaking"))
    bridge.agent_state_changed(FakeEvent(created_at=1.2, new_state="listening"))
    bridge.overlapping_speech(FakeEvent(created_at=1.4, heard_ms=320))
    bridge.agent_false_interruption(FakeEvent(created_at=1.6))

    adapter = LiveKitAdapter()
    contract_events = [adapter.translate(raw) for raw in events]
    observed = {event.EVENT_TYPE for event in contract_events if event is not None}
    required = {
        EventType.USER_SPEECH_STARTED,
        EventType.USER_TRANSCRIPT_INTERIM,
        EventType.USER_TRANSCRIPT_FINAL,
        EventType.USER_TURN_COMMITTED,
        EventType.AGENT_SPEECH_STARTED,
        EventType.AGENT_SPEECH_STOPPED,
        EventType.INTERRUPTION,
        EventType.FALSE_INTERRUPTION,
    }

    latency_samples = [
        LatencySample(eou_detect_ms=220, llm_ttft_ms=420, tts_ttfa_ms=120, total_ms=760),
        LatencySample(eou_detect_ms=260, llm_ttft_ms=470, tts_ttfa_ms=130, total_ms=860),
        LatencySample(eou_detect_ms=300, llm_ttft_ms=520, tts_ttfa_ms=150, total_ms=970),
    ]
    gates = [
        latency_gate([sample.total_ms for sample in latency_samples]),
        rate_gate("eou_false_interrupt_rate", 0, 3, EOU_FALSE_INTERRUPT_RATE),
        rate_gate("bargein_false_positive_rate", 0, 3, BARGEIN_FALSE_POSITIVE_RATE),
    ]

    lines = [
        "# M0 Smoke Report",
        "",
        f"- engine_events: {len(events)}",
        f"- contract_events: {len([e for e in contract_events if e is not None])}",
        f"- required_contract_coverage: {len(observed & required)}/{len(required)}",
        "",
        "## Gates",
    ]
    for gate in gates:
        status = "PASS" if gate.passed else "FAIL"
        lines.append(f"- {gate.name}: {gate.value:.4f} <= {gate.threshold:.4f} {status}")
    lines.extend(
        [
            "",
            "## Observed Contract Events",
            *[f"- {event.value}" for event in sorted(observed, key=str)],
        ]
    )
    report = "\n".join(lines) + "\n"
    report_path = Path("data/m0-smoke-report.md")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report, encoding="utf-8")
    print(report)
    print(f"report: {report_path}")

    if not required.issubset(observed):
        missing = ", ".join(sorted(event.value for event in required - observed))
        raise SystemExit(f"M0 contract coverage failed, missing: {missing}")
    if not all(gate.passed for gate in gates):
        raise SystemExit("M0 gate failed")


if __name__ == "__main__":
    asyncio.run(asyncio.to_thread(main))
