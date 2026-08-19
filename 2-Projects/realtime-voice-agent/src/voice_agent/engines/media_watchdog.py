"""上行媒体活性看门狗(2026-08-19,端侧「常连房间」僵尸房的 worker 侧根治半边)。

背景:P003 网页端(同事线)为降唤醒延迟保留「常连房间」——设备退出语音后不
disconnect,下次唤醒复用同一房。代价是僵尸房:信令 WS 有 ping/pong 保活,
room.state 显示 connected,但 WebRTC 上行媒体已死(设备息屏冻结/NAT 映射
失效/网络切换),agent 收不到音频 → 整轮零 ASR、零 LLM。SFU 不踢它(信令
活着),端侧 room.state 也被骗,只能靠「说了话却没字幕」间接推断——端侧
8-17 的无 ASR 看门狗即此思路,已出跨窗口误杀。worker 侧有更硬的真值,分两层:

L1 挂断(默认开):SFU 对设备的 connection_quality 评估走 RTCP/传输层,
   **不受 opus DTX 静音停包影响**;报 LOST 持续 MEDIA_LOST_HANGUP_S 秒无
   恢复 → 删房(sentinel 挂断同款 ``ctx.delete_room``,端侧收标准
   disconnected 事件,前端零改动)。效果:僵尸态被压缩成断开态——端侧
   「复用前查 room.state」的第一层自救从被骗变可信,下次唤醒走正常重连
   (~1-1.5s)。瞬时弱网免疫:倒计时内质量恢复(任何非 LOST 事件)即取消。

L2 遥测(默认开,只记日志不动作):包装 ``session.input.audio``(官方
   record_input 同款链式模式)记帧流量+幅度峰值,周期输出
   ``media watchdog stats:`` 行(journalctl grep 即得)。排障钥匙——
   LOST/无帧=传输死;有帧但 peak≈0 而端侧硬件 VAD 报在说话=采集死
   (系统收走麦克风,WebRTC 只发静音,传输层全绿,只有端侧能自救)。
   两种僵尸从此一眼分开。⚠️ 不做「无帧超时」自动挂断:DTX 静默期的帧
   到达行为未实证,常连待机静默是常态,误判即误杀;观测数据攒够再议。

回滚:``MEDIA_WATCHDOG=0`` 整体关;``MEDIA_LOST_HANGUP_S`` 调倒计时
(默认 15);``MEDIA_STATS_INTERVAL_S`` 调遥测周期(默认 60,0=只关遥测
日志、保留 L1)。两 worker 共享 src,对主 worker(无常连模式)LOST 删房
同样是正确行为——传输死了留房只有害处。

顶层不 import livekit(仓约定:零依赖可单测);接线在 ``register_media_watchdog``
方法体内。
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Callable
from typing import Any

import numpy as np

logger = logging.getLogger("voice_agent.media_watchdog")


def _frame_peak(frame: Any) -> int:
    """int16 PCM 幅度峰值。min/max 双取避免 abs(-32768) 的 int16 溢出。"""
    data = getattr(frame, "data", None)
    if data is None:
        return 0
    arr = np.frombuffer(data, dtype=np.int16)
    if arr.size == 0:
        return 0
    return max(int(arr.max()), -int(arr.min()))


class MediaWatchdog:
    """LOST 状态机 + 帧统计(纯逻辑,livekit 无关,可单测)。

    hangup 动作注入(生产=ctx.delete_room,测试=计数器);时钟注入便于测试。
    """

    def __init__(
        self,
        *,
        lost_hangup_s: float,
        hangup: Callable[[str], None],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._lost_hangup_s = lost_hangup_s
        self._hangup = hangup
        self._clock = clock
        self._lost_since: float | None = None
        self._lost_identity = ""
        self._countdown: asyncio.Task[None] | None = None
        self._fired = False
        self._aux_tasks: list[asyncio.Task[None]] = []
        # L2 帧统计(interval 值由 take_interval_stats 取走并清零)
        self._last_frame_ts: float | None = None
        self._frames_total = 0
        self._interval_frames = 0
        self._interval_peak = 0

    # --- L2 帧统计 ---

    def note_frame(self, peak: int) -> None:
        self._last_frame_ts = self._clock()
        self._frames_total += 1
        self._interval_frames += 1
        if peak > self._interval_peak:
            self._interval_peak = peak

    def last_frame_age(self) -> float | None:
        if self._last_frame_ts is None:
            return None
        return self._clock() - self._last_frame_ts

    def take_interval_stats(self) -> tuple[int, int]:
        frames, peak = self._interval_frames, self._interval_peak
        self._interval_frames = 0
        self._interval_peak = 0
        return frames, peak

    # --- L1 LOST 状态机 ---

    @property
    def lost(self) -> bool:
        return self._lost_since is not None

    @property
    def fired(self) -> bool:
        return self._fired

    def on_remote_quality(self, *, identity: str, lost: bool) -> None:
        if self._fired:
            return
        if lost:
            if self._lost_since is None:
                self._lost_since = self._clock()
                self._lost_identity = identity
                logger.warning(
                    "remote media LOST: %s(%.0fs 内无恢复即删房)",
                    identity,
                    self._lost_hangup_s,
                )
                self._countdown = asyncio.create_task(self._lost_countdown())
        elif self._lost_since is not None:
            logger.info(
                "remote media recovered: %s(LOST 持续 %.1fs)",
                identity,
                self._clock() - self._lost_since,
            )
            self._reset_lost()

    def _reset_lost(self) -> None:
        self._lost_since = None
        self._lost_identity = ""
        if self._countdown is not None:
            self._countdown.cancel()
            self._countdown = None

    async def _lost_countdown(self) -> None:
        await asyncio.sleep(self._lost_hangup_s)
        if self._fired or self._lost_since is None:
            return
        self._fired = True
        age = self.last_frame_age()
        self._hangup(
            f"participant {self._lost_identity} 媒体 LOST 持续"
            f" {self._clock() - self._lost_since:.0f}s"
            f"(last_frame_age={f'{age:.0f}s' if age is not None else 'n/a'})"
        )

    # --- 生命周期 ---

    def attach_task(self, task: asyncio.Task[None]) -> None:
        self._aux_tasks.append(task)

    def aclose(self) -> None:
        """取消全部内部任务(engine.aclose 调;悬挂 task 会拖 entrypoint 收尾)。"""
        if self._countdown is not None:
            self._countdown.cancel()
            self._countdown = None
        for t in self._aux_tasks:
            t.cancel()
        self._aux_tasks.clear()


def register_media_watchdog(session: Any, ctx: Any) -> MediaWatchdog:
    """接线:LOST 事件订阅 + input 包装 + 周期遥测。

    必须在 ``session.start`` 之后调用(input.audio 由 RoomIO 在 start 时组装,
    之前是 None——fade_output 同款时序坑)。返回 watchdog,engine.aclose 时回收。
    """
    from livekit import rtc
    from livekit.agents.voice.io import AudioInput

    lost_hangup_s = float(os.environ.get("MEDIA_LOST_HANGUP_S", "15"))
    stats_interval_s = float(os.environ.get("MEDIA_STATS_INTERVAL_S", "60"))

    def _hangup(reason: str) -> None:
        logger.warning(
            "media watchdog 删房 %s: %s(端侧将收 disconnected,下次唤醒走正常重连)",
            ctx.room.name,
            reason,
        )
        ctx.delete_room()  # 内部已兜 NOT_FOUND/网络异常,fire-and-forget 安全

    wd = MediaWatchdog(lost_hangup_s=lost_hangup_s, hangup=_hangup)
    local_identity = ctx.room.local_participant.identity

    def _on_quality(participant: Any, quality: Any) -> None:
        # 过滤 agent 自身(local)与 identity 缺失(SFU 事件偶发查不到 participant)
        identity = getattr(participant, "identity", None)
        if identity is None or identity == local_identity:
            return
        wd.on_remote_quality(
            identity=identity,
            lost=quality == rtc.ConnectionQuality.QUALITY_LOST,
        )

    ctx.room.on("connection_quality_changed", _on_quality)

    # L2:包装 input 记帧。orig 引用保留给遥测读 muted(RoomIO 私有属性,防御 getattr)
    orig = session.input.audio
    if orig is not None:

        class _Tap(AudioInput):
            def __init__(self) -> None:
                super().__init__(label="MediaWatchdog", source=orig)

            async def __anext__(self) -> Any:
                frame = await super().__anext__()
                wd.note_frame(_frame_peak(frame))
                return frame

        session.input.audio = _Tap()

    if stats_interval_s > 0:

        async def _stats_loop() -> None:
            while True:
                await asyncio.sleep(stats_interval_s)
                frames, peak = wd.take_interval_stats()
                age = wd.last_frame_age()
                muted = getattr(getattr(orig, "_publication", None), "muted", None)
                logger.info(
                    "media watchdog stats: frames=+%d peak=%d last_frame_age=%s"
                    " muted=%s lost=%s",
                    frames,
                    peak,
                    f"{age:.1f}s" if age is not None else "n/a",
                    muted,
                    wd.lost,
                )

        wd.attach_task(asyncio.create_task(_stats_loop()))

    logger.info(
        "media watchdog armed: lost_hangup=%.0fs stats_interval=%.0fs tap=%s",
        lost_hangup_s,
        stats_interval_s,
        orig is not None,
    )
    return wd


__all__ = ["MediaWatchdog", "register_media_watchdog"]
