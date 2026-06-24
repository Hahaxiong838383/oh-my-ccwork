"""M0 离线 demo:跑内置场景,打印架构对比表 + 两条权衡曲线。

运行:uv run python -m safety_arena.demo

这是纯逻辑引擎的端到端自证 —— 不碰真实 LLM,但完整走通 capture → replay → metrics,
并把"并行架构的命门(buffer 深度、classifier 延迟)"用可见的扫描曲线呈现出来。
"""

from __future__ import annotations

from .metrics import aggregate, format_table
from .replay import default_strategies, run_matrix
from .scenarios import all_traces
from .strategies import Knobs, ParallelBuffer


def main() -> None:
    traces = all_traces()
    he = traces["harm-early"]

    print("== 架构对比(4 场景 × 4 策略)==")
    print("（leak率=出现泄漏的场景占比,均泄漏=平均泄漏 token 数,ms 为相对生成起点）")
    print(format_table(aggregate(run_matrix(list(traces.values()), default_strategies()))))

    print("\n== 曲线①  buffer 深度 k ↔ 泄漏 / TTFT（harm-early,classifier 早判@220ms）==")
    for k in (0, 1, 2, 4, 8):
        r = ParallelBuffer(k).replay(he, Knobs())
        print(f"  k={k:>2}:  泄漏 {r.leaked_tokens} token   TTFT {r.ttft_ms:.0f}ms   "
              f"{'(零泄漏但首字变慢)' if r.leaked_tokens == 0 else ''}")

    print("\n== 曲线②  classifier 延迟注入 ↔ 泄漏（harm-early,parallel k=4）==")
    for lat in (0, 50, 100, 200):
        r = ParallelBuffer(4).replay(he, Knobs(classifier_latency_ms=lat))
        print(f"  +{lat:>3}ms:  泄漏 {r.leaked_tokens} token   "
              f"{'(classifier 太慢,缓冲被击穿)' if r.leaked_tokens > 0 else ''}")

    print("\n结论:并行的优势区间 = classifier 够快 + buffer 够深;"
          "越过任一边界就退化成'要么泄漏、要么不如串行'。")


if __name__ == "__main__":
    main()
