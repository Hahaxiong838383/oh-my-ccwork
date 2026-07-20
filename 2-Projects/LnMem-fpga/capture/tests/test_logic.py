"""逻辑层测试（不依赖摄像头/麦克风/mediapipe）。跑法:
  cd capture && .venv/bin/python -m pytest tests/ -q
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import contract
from events import EventLog, LeaveSeatDetector, SpeechEdge
from health import HealthSentinel
from validate_annotation import validate


# ---------- contract ----------

def test_context_shape_and_onehot():
    c = contract.build_context("speech_start", 5.0, True, 0.5, 60.0, 14.5)
    assert len(c) == contract.CONTEXT_DIM
    assert c[contract.EVENT_IDX["speech_start"]] == 1.0
    assert sum(c[:8]) == 1.0  # one-hot 唯一
    assert c[10] == 1.0 and c[9] == 0.0 and c[13] == 0.0  # 死维恒0


def test_dt_encode_monotonic_and_clip():
    e = contract.encode_dt_last_event
    assert e(0) == 0.0
    assert e(10) < e(100) < e(600)
    assert e(600) == 1.0 and e(1e9) == 1.0


def test_frame_record_roundtrip():
    r = contract.FrameRecord(1000, 0, [0.1, 0.2, 0.3, 0.4], [1, 2, 3], True,
                             [0.0] * 64, [0.0] * 16, True, 0.8, True)
    d = json.loads(r.to_json())
    assert d["contract_version"] == 1 and len(d["feat"]) == 64


# ---------- events ----------

def _elog(tmp_path):
    return EventLog(tmp_path / "events.jsonl")


def test_speech_edge(tmp_path):
    log = _elog(tmp_path)
    se = SpeechEdge(log)
    se.update(1000, False)
    se.update(2000, True)   # start
    se.update(3000, True)
    se.update(4000, False)  # end
    log.close()
    lines = [json.loads(x) for x in open(tmp_path / "events.jsonl")]
    assert [e["type"] for e in lines] == ["speech_start", "speech_end"]
    assert log.last_event_type == "speech_end"


def test_leave_seat_requires_presence_then_absence(tmp_path):
    log = _elog(tmp_path)
    det = LeaveSeatDetector(log, absent_s=3.0, present_s=60.0)
    t = 0
    for _ in range(70):  # 70s 在场
        det.update(t, True); t += 1000
    for _ in range(4):   # 4s 消失 → 触发一次
        det.update(t, False); t += 1000
    for _ in range(10):  # 继续消失不重复触发
        det.update(t, False); t += 1000
    log.close()
    types = [json.loads(x)["type"] for x in open(tmp_path / "events.jsonl")]
    assert types.count("leave_seat") == 1


def test_leave_seat_short_presence_no_fire(tmp_path):
    log = _elog(tmp_path)
    det = LeaveSeatDetector(log, absent_s=3.0, present_s=60.0)
    t = 0
    for _ in range(10):  # 仅 10s 在场
        det.update(t, True); t += 1000
    for _ in range(10):
        det.update(t, False); t += 1000
    log.close()
    assert Path(tmp_path / "events.jsonl").read_text() == ""


# ---------- health ----------

def test_sentinel_dead_dim_whitelist(tmp_path):
    s = HealthSentinel(tmp_path / "h.json", feat_dim=2, ctx_dim=3,
                       dead_ctx_whitelist=[2], report_every_s=0.0)
    import random
    for _ in range(100):
        s.update([random.random(), random.random()],
                 [random.random(), 0.5, 0.0])  # ctx1 恒0.5(非白名单死维) ctx2 白名单
    warns = s.maybe_report()
    assert any("ctx[1]" in w for w in warns)
    assert not any("ctx[2]" in w for w in warns)


# ---------- validator ----------

def _mk_session():
    frames = [{"ts_mono_ms": 10_000 + i * 100} for i in range(600)]  # 10s..70s
    events = [{"id": "ev_000001", "ts_mono_ms": 30_000, "type": "speech_start"}]
    meta = {"date": "2026-07-20", "camera": "index0", "machine": "air",
            "mono_at_start_ms": 10_000, "epoch_at_start": 1_000_000.0}
    return frames, events, meta


def test_validator_pass():
    frames, events, meta = _mk_session()
    ann = [{"video_id": "s1", "segments": [{
        "t0": 17.0, "t1": 20.0, "intent": "I3", "anchor_mode": "event_ts",
        "anchor_event_id": "ev_000001", "annotated_at": 1_000_100.0}]}]
    assert validate(ann, frames, events, meta) == []


def test_validator_rejects_out_of_range_and_bad_anchor():
    frames, events, meta = _mk_session()
    ann = [{"video_id": "s1", "segments": [
        {"t0": 500.0, "t1": 502.0, "intent": "I3", "anchor_mode": "event_ts",
         "anchor_event_id": "ev_000001", "annotated_at": 1_000_600.0},   # A1 越界
        {"t0": 17.0, "t1": 20.0, "intent": "I3", "anchor_mode": "event_ts",
         "anchor_event_id": "ev_999999", "annotated_at": 1_000_100.0},   # A2 事件不存在
        {"t0": 17.0, "t1": 20.0, "intent": "I3", "anchor_mode": "event_ts",
         "anchor_event_id": "ev_000001", "annotated_at": 1_000_010.0},   # A3 先标后发生
    ]}]
    rejects = validate(ann, frames, events, meta)
    reasons = " | ".join(r for _, r in rejects)
    assert "A1" in reasons and "A2" in reasons and "A3" in reasons
