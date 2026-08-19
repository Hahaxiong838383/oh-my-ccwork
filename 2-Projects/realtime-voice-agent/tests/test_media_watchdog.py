"""媒体看门狗契约:LOST 持续才删房(瞬断免疫)、恢复即取消、hangup 恰一次;帧统计准确。"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import numpy as np

from voice_agent.engines.media_watchdog import (
    MediaWatchdog,
    _frame_peak,
    register_media_watchdog,
)


def _frame(samples: list[int]) -> SimpleNamespace:
    return SimpleNamespace(data=np.array(samples, dtype=np.int16).tobytes())


class TestFramePeak:
    def test_normal(self) -> None:
        assert _frame_peak(_frame([0, 100, -200, 50])) == 200

    def test_int16_min_no_overflow(self) -> None:
        # abs(-32768) 在 int16 内溢出回负——min/max 双取必须给出 32768
        assert _frame_peak(_frame([-32768, 1])) == 32768

    def test_empty_and_missing_data(self) -> None:
        assert _frame_peak(_frame([])) == 0
        assert _frame_peak(SimpleNamespace()) == 0


class TestLostStateMachine:
    async def test_lost_sustained_fires_once(self) -> None:
        fired: list[str] = []
        wd = MediaWatchdog(lost_hangup_s=0.05, hangup=fired.append)
        wd.on_remote_quality(identity="dev-1", lost=True)
        # 重复 LOST 事件不重复起倒计时
        wd.on_remote_quality(identity="dev-1", lost=True)
        await asyncio.sleep(0.12)
        assert len(fired) == 1
        assert "dev-1" in fired[0]
        assert wd.fired
        # fired 后事件不再动作
        wd.on_remote_quality(identity="dev-1", lost=True)
        await asyncio.sleep(0.08)
        assert len(fired) == 1

    async def test_recovery_cancels(self) -> None:
        fired: list[str] = []
        wd = MediaWatchdog(lost_hangup_s=0.05, hangup=fired.append)
        wd.on_remote_quality(identity="dev-1", lost=True)
        await asyncio.sleep(0.01)
        wd.on_remote_quality(identity="dev-1", lost=False)  # 瞬断恢复
        await asyncio.sleep(0.1)
        assert fired == []
        assert not wd.lost and not wd.fired

    async def test_relost_after_recovery_fires(self) -> None:
        fired: list[str] = []
        wd = MediaWatchdog(lost_hangup_s=0.05, hangup=fired.append)
        wd.on_remote_quality(identity="dev-1", lost=True)
        wd.on_remote_quality(identity="dev-1", lost=False)
        wd.on_remote_quality(identity="dev-1", lost=True)
        await asyncio.sleep(0.12)
        assert len(fired) == 1

    async def test_good_quality_noop(self) -> None:
        fired: list[str] = []
        wd = MediaWatchdog(lost_hangup_s=0.05, hangup=fired.append)
        wd.on_remote_quality(identity="dev-1", lost=False)
        await asyncio.sleep(0.08)
        assert fired == [] and not wd.lost

    async def test_aclose_cancels_countdown(self) -> None:
        fired: list[str] = []
        wd = MediaWatchdog(lost_hangup_s=0.05, hangup=fired.append)
        wd.on_remote_quality(identity="dev-1", lost=True)
        wd.aclose()
        await asyncio.sleep(0.1)
        assert fired == []


class TestFrameStats:
    def test_interval_take_and_reset(self) -> None:
        t = {"now": 100.0}
        wd = MediaWatchdog(lost_hangup_s=1, hangup=lambda _: None, clock=lambda: t["now"])
        wd.note_frame(120)
        wd.note_frame(300)
        t["now"] = 102.5
        assert wd.take_interval_stats() == (2, 300)
        assert wd.take_interval_stats() == (0, 0)  # 取走即清零
        assert wd.last_frame_age() == 2.5

    def test_no_frame_age_none(self) -> None:
        wd = MediaWatchdog(lost_hangup_s=1, hangup=lambda _: None)
        assert wd.last_frame_age() is None


# --- 接线层(fake room/ctx/session,livekit 仅取枚举真值) ---


class FakeRoom:
    def __init__(self) -> None:
        self._handlers: dict[str, list[Any]] = {}
        self.name = "t-demo-abc"
        self.local_participant = SimpleNamespace(identity="agent-self")

    def on(self, ev: str, cb: Any) -> None:
        self._handlers.setdefault(ev, []).append(cb)

    def emit(self, ev: str, *args: Any) -> None:
        for cb in self._handlers.get(ev, []):
            cb(*args)


class FakeSource:
    """充当 RoomIO 原始流:异步吐两帧后停;attach 协议打点。"""

    def __init__(self) -> None:
        self.frames = [_frame([10, -20]), _frame([500, -600])]
        self.attached_calls = 0
        self._publication = SimpleNamespace(muted=False)

    def __aiter__(self) -> Any:
        return self

    async def __anext__(self) -> Any:
        if not self.frames:
            raise StopAsyncIteration
        return self.frames.pop(0)

    def on_attached(self) -> None:
        self.attached_calls += 1

    def on_detached(self) -> None:
        pass


def _make_env(monkeypatch: Any, **kv: str) -> None:
    for k, v in kv.items():
        monkeypatch.setenv(k, v)


class TestRegister:
    async def test_remote_lost_deletes_room_local_filtered(self, monkeypatch: Any) -> None:
        from livekit import rtc

        _make_env(monkeypatch, MEDIA_LOST_HANGUP_S="0.05", MEDIA_STATS_INTERVAL_S="0")
        room = FakeRoom()
        deleted: list[bool] = []
        ctx = SimpleNamespace(room=room, delete_room=lambda: deleted.append(True))
        session = SimpleNamespace(input=SimpleNamespace(audio=None))

        wd = register_media_watchdog(session, ctx)
        # agent 自身 LOST 必须被过滤
        room.emit(
            "connection_quality_changed",
            SimpleNamespace(identity="agent-self"),
            rtc.ConnectionQuality.QUALITY_LOST,
        )
        # participant 查不到(None)也过滤
        room.emit("connection_quality_changed", None, rtc.ConnectionQuality.QUALITY_LOST)
        await asyncio.sleep(0.08)
        assert deleted == []
        # 远端设备 LOST → 倒计时 → 删房
        room.emit(
            "connection_quality_changed",
            SimpleNamespace(identity="device-1"),
            rtc.ConnectionQuality.QUALITY_LOST,
        )
        await asyncio.sleep(0.12)
        assert deleted == [True]
        wd.aclose()

    async def test_remote_recovery_no_delete(self, monkeypatch: Any) -> None:
        from livekit import rtc

        _make_env(monkeypatch, MEDIA_LOST_HANGUP_S="0.05", MEDIA_STATS_INTERVAL_S="0")
        room = FakeRoom()
        deleted: list[bool] = []
        ctx = SimpleNamespace(room=room, delete_room=lambda: deleted.append(True))
        session = SimpleNamespace(input=SimpleNamespace(audio=None))

        wd = register_media_watchdog(session, ctx)
        dev = SimpleNamespace(identity="device-1")
        room.emit("connection_quality_changed", dev, rtc.ConnectionQuality.QUALITY_LOST)
        await asyncio.sleep(0.01)
        room.emit("connection_quality_changed", dev, rtc.ConnectionQuality.QUALITY_GOOD)
        await asyncio.sleep(0.1)
        assert deleted == []
        wd.aclose()

    async def test_tap_forwards_and_counts(self, monkeypatch: Any) -> None:
        _make_env(monkeypatch, MEDIA_LOST_HANGUP_S="15", MEDIA_STATS_INTERVAL_S="0")
        room = FakeRoom()
        ctx = SimpleNamespace(room=room, delete_room=lambda: None)
        source = FakeSource()
        session = SimpleNamespace(input=SimpleNamespace(audio=source))

        wd = register_media_watchdog(session, ctx)
        tap = session.input.audio
        assert tap is not source, "input 必须被包装"
        assert tap.source is source, "包装层 source 链必须指向原始流(框架 _collect_source 依赖)"
        got = [f async for f in tap]
        assert len(got) == 2, "帧必须原样转发"
        assert wd.take_interval_stats() == (2, 600)
        assert wd.last_frame_age() is not None
        wd.aclose()
