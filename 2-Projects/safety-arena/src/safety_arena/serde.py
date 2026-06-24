"""Trace / ReplayResult ↔ dict 序列化。

用于 SQLite 落库(JSON)与 HTTP 响应。保持纯函数、无副作用,两端(存/取、服务端/前端)同构。
"""

from __future__ import annotations

from .models import (
    Decision,
    Emit,
    Event,
    EventKind,
    InputCase,
    ReplayResult,
    RiskLabel,
    Trace,
)


def event_to_dict(e: Event) -> dict:
    return {
        "t_ms": e.t_ms,
        "kind": e.kind.value,
        "token": e.token,
        "token_index": e.token_index,
        "risk": e.risk,
        "risk_label": e.risk_label.value if e.risk_label else None,
        "signal_source": e.signal_source,
    }


def event_from_dict(d: dict) -> Event:
    return Event(
        d["t_ms"],
        EventKind(d["kind"]),
        token=d.get("token"),
        token_index=d.get("token_index"),
        risk=d.get("risk"),
        risk_label=RiskLabel(d["risk_label"]) if d.get("risk_label") else None,
        signal_source=d.get("signal_source"),
    )


def input_to_dict(c: InputCase) -> dict:
    return {"id": c.id, "text": c.text, "label": c.label.value if c.label else None}


def input_from_dict(d: dict) -> InputCase:
    return InputCase(d["id"], d["text"], RiskLabel(d["label"]) if d.get("label") else None)


def trace_to_dict(t: Trace) -> dict:
    return {
        "trace_id": t.trace_id,
        "input": input_to_dict(t.input),
        "events": [event_to_dict(e) for e in t.events],
        "sut_meta": t.sut_meta,
    }


def trace_from_dict(d: dict) -> Trace:
    return Trace(
        trace_id=d["trace_id"],
        input=input_from_dict(d["input"]),
        events=[event_from_dict(e) for e in d["events"]],
        sut_meta=d.get("sut_meta", {}),
    )


def decision_to_dict(x: Decision) -> dict:
    return {
        "t_ms": x.t_ms,
        "action": x.action.value,
        "token_index": x.token_index,
        "risk": x.risk,
        "risk_label": x.risk_label.value if x.risk_label else None,
        "reason": x.reason,
    }


def emit_to_dict(e: Emit) -> dict:
    return {"t_ms": e.t_ms, "text": e.text, "original": e.original, "token_index": e.token_index}


def result_to_dict(r: ReplayResult) -> dict:
    return {
        "strategy": r.strategy_name,
        "trace_id": r.trace_id,
        "emitted_text": r.emitted_text,
        "emitted_original_tokens": r.emitted_original_tokens,
        "intervened": r.intervened,
        "ttft_ms": r.ttft_ms,
        "first_safe_token_ms": r.first_safe_token_ms,
        "total_ms": r.total_ms,
        "intervention_ms": r.intervention_ms,
        "leaked_tokens": r.leaked_tokens,
        "leaked_text": r.leaked_text,
        "decisions": [decision_to_dict(d) for d in r.decisions],
        "emits": [emit_to_dict(e) for e in r.emits],
    }
