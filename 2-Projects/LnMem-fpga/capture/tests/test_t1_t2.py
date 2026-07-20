"""T1 面板 + T2 自动标注 测试（无硬件依赖）。"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from autolabel import build_segments
from panel import PanelServer, PanelState, rule_expr_emoji

CAPTURE_DIR = Path(__file__).parent.parent


# ---------- T1 panel ----------

def test_rule_expr_emoji():
    assert rule_expr_emoji({}, False)[0] == "🫥"
    assert rule_expr_emoji({"jawOpen": 0.6}, True)[0] == "😮"
    assert rule_expr_emoji({"smile": 0.5}, True)[0] == "😊"
    assert rule_expr_emoji({"browDown": 0.5}, True)[0] == "🤨"
    assert rule_expr_emoji({}, True)[0] == "😐"


def test_panel_server_status_and_html():
    st = PanelState()
    st.update(face=True, speaking=False, emoji="😊", frames=42)
    st.push_event(12.3, "speech_start")
    srv = PanelServer(st, port=0)  # 随机端口
    srv.start()
    assert srv.ready.wait(3) and srv.actual_port
    base = f"http://127.0.0.1:{srv.actual_port}"
    s = json.loads(urllib.request.urlopen(f"{base}/status", timeout=3).read())
    assert s["face"] is True and s["frames"] == 42
    assert s["events"][0]["type"] == "speech_start"
    html = urllib.request.urlopen(f"{base}/", timeout=3).read().decode()
    assert "采集面板" in html


# ---------- T2 autolabel ----------

def _mk_session(tmp_path: Path) -> Path:
    """合成 40s session：脸全在场、speech_start@20s、末尾 5s 低质量段。"""
    sdir = tmp_path / "sess"
    sdir.mkdir()
    frames = []
    for i in range(600):  # 15fps × 40s
        t_ms = i * 66
        low_q = t_ms >= 35_000
        frames.append({
            "ts_mono_ms": t_ms, "valid": not low_q,
            "quality": 0.2 if low_q else 0.8,
            "feat": [0.1] * 64})
    (sdir / "frames.jsonl").write_text(
        "\n".join(json.dumps(f) for f in frames) + "\n")
    events = [{"id": "ev_000001", "ts_mono_ms": 20_000, "type": "speech_start"}]
    (sdir / "events.jsonl").write_text(json.dumps(events[0]) + "\n")
    meta = {"session_id": "sess", "date": "2026-07-20", "camera": "index0",
            "machine": "air", "mono_at_start_ms": 0, "epoch_at_start": 1_000_000.0}
    (sdir / "session_meta.json").write_text(json.dumps(meta))
    return sdir


def test_build_segments_rules(tmp_path):
    sdir = _mk_session(tmp_path)
    frames = [json.loads(x) for x in (sdir / "frames.jsonl").read_text().splitlines()]
    events = [json.loads(x) for x in (sdir / "events.jsonl").read_text().splitlines()]
    meta = json.loads((sdir / "session_meta.json").read_text())
    segs = build_segments(frames, events, meta)
    kinds = {}
    for s in segs:
        kinds.setdefault(s["intent"], []).append(s)
    # I3: speech_start@20s → [17,20]，事件锚齐全
    assert len(kinds["I3"]) == 1
    i3 = kinds["I3"][0]
    assert abs(i3["t0"] - 17.0) < 0.1 and abs(i3["t1"] - 20.0) < 0.1
    assert i3["anchor_mode"] == "event_ts" and i3["anchor_event_id"] == "ev_000001"
    # I1: 稳定段至少 1 段，且不与事件邻近
    assert len(kinds.get("I1", [])) >= 1
    # I0: 末尾低质量段
    assert len(kinds.get("I0", [])) >= 1


def test_autolabel_confirm_cli_end_to_end(tmp_path):
    sdir = _mk_session(tmp_path)
    r1 = subprocess.run([sys.executable, str(CAPTURE_DIR / "autolabel.py"), str(sdir)],
                        capture_output=True, text=True)
    assert r1.returncode == 0, r1.stdout + r1.stderr
    draft = json.loads((sdir / "annotations_draft.json").read_text())
    n = len(draft[0]["segments"])
    assert n >= 3 and (sdir / "review.html").exists()

    drop_id = draft[0]["segments"][0]["seg_id"]
    r2 = subprocess.run([sys.executable, str(CAPTURE_DIR / "confirm.py"), str(sdir),
                         "--drop", drop_id], capture_output=True, text=True)
    assert r2.returncode == 0, r2.stdout + r2.stderr
    final = json.loads((sdir / "annotations.json").read_text())
    assert len(final[0]["segments"]) == n - 1
    assert all(s["seg_id"] != drop_id for s in final[0]["segments"])
