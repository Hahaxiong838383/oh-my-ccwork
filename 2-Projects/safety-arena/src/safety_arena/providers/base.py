"""SUT(System Under Test)抽象。

一个 SUT 接收一条输入,跑一次,产出事件流(token + signal,按 t_ms 归并)。
真实实现(M3)会用 asyncio 并发跑 LLM 生成与 classifier,记录每个事件的真实
到达时间戳后归并产出;本层只定义契约,不绑定任何具体引擎。
"""

from __future__ import annotations

from typing import Iterable, Protocol, runtime_checkable

from ..models import Event, InputCase


@runtime_checkable
class Sut(Protocol):
    name: str

    def run(self, case: InputCase) -> Iterable[Event]:
        """产出该输入的事件流。要求至少含 token 与 signal,顺序不限(capture 会按 t_ms 排序)。"""
        ...
