import os
import tempfile

# server.py 在 import 时即建 store,先把 DB 指到临时文件,别污染项目目录
os.environ.setdefault("SAFETY_ARENA_DB", os.path.join(tempfile.gettempdir(), "safety-arena-pytest.db"))

from fastapi.testclient import TestClient  # noqa: E402

from safety_arena.server import app  # noqa: E402


def test_health_and_seed():
    with TestClient(app) as c:  # 进入上下文触发 lifespan → seed 内置场景
        d = c.get("/api/health").json()
        assert d["ok"] and d["traces"] >= 4


def test_traces_listed():
    with TestClient(app) as c:
        ids = [t["trace_id"] for t in c.get("/api/traces").json()["traces"]]
        assert "harm-early::mock" in ids


def test_replay_serial_zero_leak_parallel_leaks():
    with TestClient(app) as c:
        d = c.post("/api/replay", json={"trace_id": "harm-early::mock"}).json()
        by = {r["strategy"]: r for r in d["results"]}
        assert by["serial-block"]["leaked_tokens"] == 0
        assert by["parallel-buffer(k=0)"]["leaked_tokens"] == 3
        assert "strategy" in d["metrics_table"]


def test_scan_buffer_monotonic():
    with TestClient(app) as c:
        pts = c.post(
            "/api/scan",
            json={"trace_id": "harm-early::mock", "knob": "buffer", "values": [0, 2, 4]},
        ).json()["points"]
        assert [p["leaked_tokens"] for p in pts] == [3, 1, 0]  # 缓冲越深泄漏越少


def test_capture_unknown_scenario_404():
    with TestClient(app) as c:
        assert c.post("/api/capture", json={"scenario": "nope"}).status_code == 404


def test_capture_live_without_env_returns_503(monkeypatch):
    # 未配 GEMINI 凭证时,真实 SUT 端点应给可读 503,而不是 500
    monkeypatch.delenv("GEMINI_PROXY_URL", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with TestClient(app) as c:
        assert c.post("/api/capture-live", json={"text": "hi"}).status_code == 503
