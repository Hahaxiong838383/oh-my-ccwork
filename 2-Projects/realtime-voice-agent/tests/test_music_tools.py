"""音乐工具单元测试（严格 mock httpx，不打网）。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from voice_agent.tools.music_client import MusicClient
from voice_agent.tools.music_tools import create_music_tools


def _fake_ctx(session_id: str = "room-test-123"):
    """构造最小 RunContext 假对象，供 tool._func 调用。"""
    room = SimpleNamespace(name=session_id)
    room_io = SimpleNamespace(room=room)
    session = SimpleNamespace(room_io=room_io)
    return SimpleNamespace(session=session)


@pytest.mark.asyncio
async def test_music_client_search_ok():
    client = MusicClient("http://example.test", "k1")
    fake_resp = {"results": [{"id": "1", "title": "晴天", "artist": "周杰伦", "duration_sec": 240}]}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mpost:
        mpost.return_value = SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: fake_resp,
            status_code=200,
        )
        res = await client.music_search("晴天", limit=3, session_id="r1")
        assert "results" in res
        assert res["results"][0]["title"] == "晴天"


@pytest.mark.asyncio
async def test_music_client_play_ambiguous():
    client = MusicClient("http://m.test")
    fake = {"status": "ambiguous", "candidates": [{"title": "晴天"}, {"title": "七里香"}]}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mpost:
        mpost.return_value = SimpleNamespace(
            raise_for_status=lambda: None, json=lambda: fake, status_code=200
        )
        res = await client.music_play("晴天", session_id="r1")
        assert res["status"] == "ambiguous"
        assert len(res["candidates"]) == 2


@pytest.mark.asyncio
async def test_music_client_play_playing():
    client = MusicClient("http://m.test", "keyx")
    fake = {"status": "playing", "track": {"title": "夜曲"}, "stream_url": "/stream/xx/yy"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mpost:
        mpost.return_value = SimpleNamespace(
            raise_for_status=lambda: None, json=lambda: fake, status_code=200
        )
        res = await client.music_play("夜曲", session_id="r9")
        assert res["status"] == "playing"
        assert "stream_url" in res


@pytest.mark.asyncio
async def test_music_client_play_not_found():
    client = MusicClient("http://m.test")
    fake = {"status": "not_found"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mpost:
        mpost.return_value = SimpleNamespace(
            raise_for_status=lambda: None, json=lambda: fake, status_code=200
        )
        res = await client.music_play("不存在的歌", session_id="r1")
        assert res["status"] == "not_found"


@pytest.mark.asyncio
async def test_music_tools_play_branches_use_real_room_name():
    """验证 tool 拿到真实 room.name 作为 session_id，且 ambiguous 返回可反问文案。"""
    client = MusicClient("http://m.test")

    # 打桩底层 client
    async def fake_play(query, mode="track", session_id=""):
        if "多" in query:
            return {"status": "ambiguous", "candidates": [{"title": "A"}, {"title": "B"}]}
        if "无" in query:
            return {"status": "not_found"}
        return {"status": "playing", "track": {"title": query}, "stream_url": "/s/1"}

    client.music_play = fake_play  # type: ignore[assignment]

    tools = create_music_tools(client)
    play_tool = next(t for t in tools if getattr(t, "info", None) and t.info.name == "music_play")

    # ambiguous
    out = await play_tool._func(_fake_ctx("real-room-42"), "多首歌")  # type: ignore[attr-defined]
    assert "多首" in out or "请问" in out or "A" in out

    # playing
    out2 = await play_tool._func(_fake_ctx("real-room-42"), "晴天")  # type: ignore[attr-defined]
    assert "开始播放" in out2 or "晴天" in out2

    # not_found
    out3 = await play_tool._func(_fake_ctx("real-room-42"), "无此歌")  # type: ignore[attr-defined]
    assert "没有找到" in out3 or "not_found" in out3.lower()


@pytest.mark.asyncio
async def test_music_client_network_error_returns_error_shape():
    client = MusicClient("http://bad.test")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mpost:
        mpost.side_effect = RuntimeError("boom")
        res = await client.music_search("x", session_id="r")
        assert res.get("status") == "error"
        assert "boom" in str(res.get("message", ""))


@pytest.mark.asyncio
async def test_music_client_status_and_control():
    client = MusicClient("http://m.test")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mpost, patch(
        "httpx.AsyncClient.get", new_callable=AsyncMock
    ) as mget:
        mpost.return_value = SimpleNamespace(
            raise_for_status=lambda: None, json=lambda: {"status": "ok"}, status_code=200
        )
        mget.return_value = SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"playing": True, "current_track": {"title": "t"}},
            status_code=200,
        )

        c = await client.music_control("pause", session_id="r1")
        assert c["status"] == "ok"

        s = await client.music_status(session_id="r1")
        assert s.get("playing") is True
