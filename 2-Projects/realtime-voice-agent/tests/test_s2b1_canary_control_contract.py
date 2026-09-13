"""S2B1 canary.say 机器合同锁(python 侧)。

rust 侧 control.rs 用 include_str! 引用同一份 fixture 并断言常量一致;
本文件验 fixture 自身完备与示例自洽。两侧引用同一文件 = 任何一侧漂移先红。
改字段先与 codex 冻结,再同步改 fixture + 两侧断言。
"""

import json
from pathlib import Path

import pytest

FIXTURE = Path(__file__).parent / "fixtures" / "s2b1_canary_control_contract.json"


@pytest.fixture(scope="module")
def contract():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_top_level_complete(contract):
    assert contract["topic"] == "control"
    for key in ("inbound", "ack", "metrics", "env", "examples"):
        assert key in contract, f"fixture 缺顶层键 {key}"


def test_inbound_schema(contract):
    ib = contract["inbound"]
    assert ib["type"] == "canary.say"
    assert ib["src"] == "android"
    assert ib["idempotency_key"] == ["trace_id", "type", "seq"]
    assert set(ib["payload_required"]) == {"test_id", "text"}
    assert ib["text_min_chars"] == 1
    assert ib["text_max_chars"] == 300
    assert ib["stale_ts_skew_ms"] == 120_000


def test_ack_reasons_frozen(contract):
    ack = contract["ack"]
    assert ack["type"] == "canary.say.ack"
    assert ack["src"] == "worker"
    assert set(ack["payload_fields"]) == {"accepted", "already_done", "reason"}
    # 顺序也冻结(rust CANARY_REASONS 按此顺序断言)
    assert ack["reasons"] == [
        "ok",
        "already_done",
        "disabled",
        "stale_trace",
        "invalid_text",
        "already_running",
    ]


def test_metrics_fields_frozen(contract):
    m = contract["metrics"]
    assert m["type"] == "canary.say.metrics"
    assert m["src"] == "worker"
    assert set(m["payload_fields"]) == {
        "test_id",
        "audio_duration_ms",
        "underrun_count",
        "underrun_ms",
        "buffered_audio_ms",
        "first_underrun_ms",
        "played_frames",
        "final",
        "completed",
    }
    assert m["frame_ms"] == 10
    assert set(m["sentinel_negative_one"]) == {"buffered_audio_ms", "first_underrun_ms"}


def test_examples_conform_to_schema(contract):
    ex = contract["examples"]
    say = ex["say"]
    assert say["type"] == contract["inbound"]["type"]
    assert say["src"] == "android"
    assert set(contract["inbound"]["payload_required"]) <= set(say["payload"])
    assert 1 <= len(say["payload"]["text"]) <= 300

    first, repeat = ex["ack_first"], ex["ack_repeat"]
    for a in (first, repeat):
        assert a["type"] == contract["ack"]["type"]
        assert a["src"] == "worker"
        assert set(a["payload"]) == set(contract["ack"]["payload_fields"])
        assert a["payload"]["reason"] in contract["ack"]["reasons"]
    assert first["payload"] == {"accepted": True, "already_done": False, "reason": "ok"}
    assert repeat["payload"] == {
        "accepted": True,
        "already_done": True,
        "reason": "already_done",
    }
    # 幂等语义:同 (trace_id, seq) 两个 ack
    assert (first["trace_id"], first["seq"]) == (repeat["trace_id"], repeat["seq"])

    mf = ex["metrics_final"]
    assert mf["type"] == contract["metrics"]["type"]
    assert set(mf["payload"]) == set(contract["metrics"]["payload_fields"])
    p = mf["payload"]
    assert p["final"] is True
    assert p["audio_duration_ms"] == p["played_frames"] * contract["metrics"]["frame_ms"]
    # S2B1 验收线:长句 ≥5000ms 且零欠载(示例本身要过验收标准)
    assert p["audio_duration_ms"] >= 5000
    assert p["underrun_count"] == 0 and p["underrun_ms"] == 0


def test_env_gate_documented(contract):
    env = contract["env"]
    assert "CANARY_SAY_ENABLED" in env
    assert "CANARY_SAY_IDENTITY_ALLOW" in env
    assert "fail-closed" in env["CANARY_SAY_IDENTITY_ALLOW"]
