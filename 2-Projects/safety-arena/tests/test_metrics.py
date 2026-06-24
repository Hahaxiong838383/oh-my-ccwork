import fixtures

from safety_arena.metrics import aggregate, format_table, percentile
from safety_arena.replay import default_strategies, run_matrix


def test_percentile_interpolates():
    assert percentile([10, 20, 30, 40], 50) == 25.0
    assert percentile([], 50) is None
    assert percentile([5], 99) == 5


def test_aggregate_separates_strategies_and_leakage():
    traces = list(fixtures.all_traces().values())
    results = run_matrix(traces, default_strategies())
    agg = aggregate(results)

    assert "serial-block" in agg
    assert "parallel-buffer(k=0)" in agg
    # 串行零泄漏;零缓冲并行有泄漏 —— 平台的核心对比结论
    assert agg["serial-block"].leakage_rate == 0.0
    assert agg["parallel-buffer(k=0)"].leakage_rate > 0.0
    assert agg["serial-block"].n == 4
    assert "strategy" in format_table(agg)
