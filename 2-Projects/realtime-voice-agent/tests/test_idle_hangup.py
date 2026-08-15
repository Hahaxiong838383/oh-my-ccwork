"""空闲关房兜底契约(2026-08-15):给"参与者永不断开"的会话设时长上限。

真实故障:租户安卓板以 ``#hold`` 进房后从不退出,单会话挂 22.7h 占死 job slot。
判据取"距上次用户语音"而非墙钟总时长——**两个方向都要钉**:该关的关(空闲超限),
不该关的绝不关(有人说话就一直续命),否则真实长对话会被砍断。

异步测试(``asyncio_mode=auto``,无需显式标记)。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from voice_agent.engines.tier_a_cascade import _idle_hangup_loop, _register_idle_hangup

# 快档位:timeout 50ms / poll 10ms,单测在百毫秒量级收敛
FAST: dict[str, float] = {"timeout_s": 0.05, "poll_s": 0.01}


class FakeRoom:
    name = "t-test-room"


class FakeCtx:
    """记账 delete_room 调用次数;raise_times>0 时前 N 次抛异常模拟关房失败。"""

    def __init__(self, raise_times: int = 0) -> None:
        self.room = FakeRoom()
        self.deleted = 0
        self._raise_times = raise_times

    def delete_room(self) -> None:
        if self._raise_times > 0:
            self._raise_times -= 1
            raise RuntimeError("模拟 delete_room 失败")
        self.deleted += 1


class FakeSession:
    def __init__(self) -> None:
        self.handlers: dict[str, list[Any]] = {}

    def on(self, event: str, handler: Any) -> None:
        self.handlers.setdefault(event, []).append(handler)


class TestIdleHangupLoop:
    async def test_hangs_up_when_idle_exceeds_timeout(self) -> None:
        ctx = FakeCtx()
        activity = {"ts": time.monotonic()}
        await asyncio.wait_for(_idle_hangup_loop(ctx, activity, **FAST), timeout=2.0)
        assert ctx.deleted == 1

    async def test_returns_after_hangup_no_repeat(self) -> None:
        """关成功即 return,不能每轮 poll 都再删一次(重复 API 调用是噪声)。"""
        ctx = FakeCtx()
        activity = {"ts": time.monotonic()}
        await asyncio.wait_for(_idle_hangup_loop(ctx, activity, **FAST), timeout=2.0)
        await asyncio.sleep(0.05)  # 再放几个 poll 周期过去
        assert ctx.deleted == 1

    async def test_activity_keeps_session_alive(self) -> None:
        """反向判据:持续有用户语音 → 绝不关房。这条挂了说明真实对话会被砍断。"""
        ctx = FakeCtx()
        activity = {"ts": time.monotonic()}
        task = asyncio.create_task(_idle_hangup_loop(ctx, activity, **FAST))
        # 以远快于 timeout 的频率喂活动,持续 timeout 的 4 倍时长
        for _ in range(20):
            await asyncio.sleep(0.01)
            activity["ts"] = time.monotonic()
        assert ctx.deleted == 0
        assert not task.done()
        task.cancel()

    async def test_delete_room_failure_retries_next_poll(self) -> None:
        """关房失败不能吞掉当成功:下一轮必须重试,且最终真的关掉。"""
        ctx = FakeCtx(raise_times=2)
        activity = {"ts": time.monotonic()}
        await asyncio.wait_for(_idle_hangup_loop(ctx, activity, **FAST), timeout=2.0)
        assert ctx.deleted == 1


class TestRegisterIdleHangup:
    async def test_registers_on_user_input_transcribed(self) -> None:
        """活动信号必须挂在 user_input_transcribed 上。

        ⚠️ 不能挂"用户已发布音轨":那台板子常态就是 tracks=0,
        用音轨判会在它每个会话上立刻误触发。
        """
        session, ctx = FakeSession(), FakeCtx()
        task = _register_idle_hangup(session, ctx, 3600.0)
        assert "user_input_transcribed" in session.handlers
        task.cancel()

    async def test_handler_resets_idle_timer(self) -> None:
        """注册返回的 handler 被调用后计时器真的重置(不是只挂上、不生效)。

        ⚠️ poll_s 必须显式传快档位。首版漏传 → 循环用默认 30s 轮询,0.2s 测试窗口内
        一次都没醒,这条断言恒绿(注入"handler 不重置"的真 bug 照样通过)。
        """
        session, ctx = FakeSession(), FakeCtx()
        task = _register_idle_hangup(session, ctx, 0.05, poll_s=0.01)
        handler = session.handlers["user_input_transcribed"][0]
        for _ in range(20):
            await asyncio.sleep(0.01)
            handler(object())
        assert ctx.deleted == 0
        assert not task.done()
        task.cancel()

    async def test_without_handler_calls_it_does_hang_up(self) -> None:
        """同装置的阳性锚:不喂活动时必须关房。

        没有这条,上面那句 ``deleted == 0`` 依旧可能是"循环压根没跑"造成的假绿。
        """
        session, ctx = FakeSession(), FakeCtx()
        task = _register_idle_hangup(session, ctx, 0.05, poll_s=0.01)
        await asyncio.sleep(0.25)
        assert ctx.deleted == 1
        task.cancel()
