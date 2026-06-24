"""Replay 入口:一条 Trace × 一个策略 → 一个 ReplayResult。

run_matrix 把多条 trace × 多个策略跑成结果集,交给 metrics 聚合。
这一层故意极薄 —— 所有重放语义在 strategies/,所有聚合在 metrics/。
"""

from __future__ import annotations

from .models import ReplayResult, Trace
from .strategies.arbiter import Arbiter
from .strategies.base import Knobs, Strategy
from .strategies.parallel_buffer import ParallelBuffer
from .strategies.serial_block import SerialBlock


def replay(trace: Trace, strategy: Strategy, knobs: Knobs | None = None) -> ReplayResult:
    return strategy.replay(trace, knobs or Knobs())


def run_matrix(
    traces: list[Trace],
    strategies: list[Strategy],
    knobs: Knobs | None = None,
) -> list[ReplayResult]:
    knobs = knobs or Knobs()
    return [s.replay(t, knobs) for t in traces for s in strategies]


def default_strategies() -> list[Strategy]:
    """开箱即用的对照组:串行 / 零缓冲并行 / 深缓冲并行 / 分级仲裁。"""
    return [SerialBlock(), ParallelBuffer(0), ParallelBuffer(4), Arbiter()]
