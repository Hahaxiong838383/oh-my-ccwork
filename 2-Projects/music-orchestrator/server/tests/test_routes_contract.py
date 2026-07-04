"""测试 /tools/* 路由契约（mock source，不走真实网络）"""

from unittest.mock import AsyncMock, patch

import os

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch

# 测试前必须设置 key，否则鉴权会失败
os.environ.setdefault("MUSIC_KEY", "testkey")
os.environ.setdefault("MUSIC_ADMIN_KEY", "adminkey")

from app.config import config as app_config
from app.main import app
from app.sources.base import SearchResult

# 强制注入 key（即使 import 时 env 顺序问题）
app_config.music_key = "testkey"
app_config.music_admin_key = "adminkey"

client = TestClient(app)


def _fake_results():
    return [
        SearchResult(id="BV1xx", source="bilibili", title="七里香", artist="周杰伦", duration_sec=280, popularity=123456),
        SearchResult(id="BV1yy", source="bilibili", title="青花瓷", artist="周杰伦", duration_sec=250, popularity=99999),
    ]


@pytest.fixture(autouse=True)
def patch_sources():
    # 让 /tools 路由拿到的 source 永远是 mock
    mock_src = AsyncMock()
    mock_src.name = "bilibili"
    mock_src.search = AsyncMock(return_value=_fake_results())
    mock_src.resolve = AsyncMock(return_value="https://fake.url/audio.mp3")

    with patch("app.sources.get_enabled_sources", return_value=[mock_src]), \
         patch("app.sources.get_source_by_name", return_value=mock_src):
        yield


def test_music_search_contract():
    resp = client.post(
        "/tools/music_search",
        json={"query": "七里香", "limit": 3, "session_id": "s1"},
        headers={"X-Music-Key": "testkey"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "results" in data
    assert isinstance(data["results"], list)
    if data["results"]:
        item = data["results"][0]
        for k in ["id", "source", "title", "artist", "duration_sec", "score"]:
            assert k in item


def test_music_play_high_confidence():
    resp = client.post(
        "/tools/music_play",
        json={"query": "七里香", "mode": "track", "session_id": "s2"},
        headers={"X-Music-Key": "testkey"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] in ("playing", "ambiguous", "not_found")
    if data["status"] == "playing":
        assert "track" in data
        assert "stream_url" in data
        assert data["stream_url"].startswith("/stream/")


def test_music_control_and_status():
    sid = "s3"
    # 先 play 建立状态
    client.post(
        "/tools/music_play",
        json={"query": "test", "session_id": sid},
        headers={"X-Music-Key": "testkey"},
    )
    # pause
    r = client.post(
        "/tools/music_control",
        json={"action": "pause", "session_id": sid},
        headers={"X-Music-Key": "testkey"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

    # status
    st = client.get(f"/tools/music_status?session_id={sid}", headers={"X-Music-Key": "testkey"})
    assert st.status_code == 200
    body = st.json()
    assert "playing" in body
    assert "current_track" in body
    assert "queue" in body
    assert "position_sec" in body


def test_queue_ops():
    sid = "s4"
    r = client.post(
        "/tools/music_queue",
        json={"action": "add", "item": {"id": "x", "title": "t"}, "session_id": sid},
        headers={"X-Music-Key": "testkey"},
    )
    assert r.status_code == 200
    assert len(r.json()["queue"]) == 1

    r2 = client.post(
        "/tools/music_queue",
        json={"action": "list", "session_id": sid},
        headers={"X-Music-Key": "testkey"},
    )
    assert r2.status_code == 200


def test_missing_key_returns_401():
    r = client.post(
        "/tools/music_search",
        json={"query": "x", "session_id": "s5"},
        headers={"X-Music-Key": "wrong"},
    )
    assert r.status_code == 401
