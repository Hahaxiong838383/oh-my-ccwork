"""Capture:跑一次 SUT,把事件流归并成一条 Trace(单一真相源)。

trace_id 用 case.id + sut.name 确定性拼接(不读时钟/不用随机),保证可重放、可复现。
"""

from __future__ import annotations

from .models import Event, EventKind, InputCase, Trace
from .providers.base import Sut

# 同一 t_ms 下的稳定次序:生成开始 < (信号/ token 保持产出序) < 生成结束
_KIND_ORDER = {
    EventKind.GEN_START: 0,
    EventKind.SIGNAL: 1,
    EventKind.TOKEN: 1,
    EventKind.GEN_END: 2,
}


def capture(sut: Sut, case: InputCase) -> Trace:
    events: list[Event] = list(sut.run(case))
    events.sort(key=lambda e: (e.t_ms, _KIND_ORDER.get(e.kind, 1)))
    return Trace(
        trace_id=f"{case.id}::{sut.name}",
        input=case,
        events=events,
        sut_meta={"sut": sut.name},
    )


async def capture_async(sut, case: InputCase) -> Trace:
    """async 捕获:给真实 SUT(httpx 并发调 LLM)用。sut 需实现 async run_async(case) -> list[Event]。"""
    events: list[Event] = list(await sut.run_async(case))
    events.sort(key=lambda e: (e.t_ms, _KIND_ORDER.get(e.kind, 1)))
    return Trace(
        trace_id=f"{case.id}::{sut.name}",
        input=case,
        events=events,
        sut_meta={"sut": sut.name},
    )
