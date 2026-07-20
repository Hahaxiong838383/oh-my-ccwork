"""per-dim 活性哨兵（标注手册 §6 R2/R4 的实现）。

- Welford 滚动统计每维 mean/var + 饱和率（贴 min/max 的帧占比）
- 死维告警：窗口内 var < 阈值 且不在 dead-by-design 白名单
- LnMem 学费：4/18 维恒缺省跑一个月无人发现——这里每 60s 出一次体检
"""
from __future__ import annotations

import json
import time


class DimStats:
    def __init__(self, n_dims: int):
        self.n = 0
        self.mean = [0.0] * n_dims
        self.m2 = [0.0] * n_dims
        self.lo_hits = [0] * n_dims
        self.hi_hits = [0] * n_dims
        self.min = [float("inf")] * n_dims
        self.max = [float("-inf")] * n_dims

    def update(self, vec: list[float]):
        self.n += 1
        for i, x in enumerate(vec):
            d = x - self.mean[i]
            self.mean[i] += d / self.n
            self.m2[i] += d * (x - self.mean[i])
            self.min[i] = min(self.min[i], x)
            self.max[i] = max(self.max[i], x)

    def finalize_saturation(self, vec: list[float], eps: float = 1e-6):
        for i, x in enumerate(vec):
            if self.max[i] - self.min[i] > eps:
                if abs(x - self.min[i]) < eps:
                    self.lo_hits[i] += 1
                elif abs(x - self.max[i]) < eps:
                    self.hi_hits[i] += 1

    def var(self, i: int) -> float:
        return self.m2[i] / self.n if self.n > 1 else 0.0


class HealthSentinel:
    def __init__(self, out_path, feat_dim: int, ctx_dim: int,
                 dead_ctx_whitelist: list[int], report_every_s: float = 60.0):
        self.out_path = out_path
        self.feat = DimStats(feat_dim)
        self.ctx = DimStats(ctx_dim)
        self.dead_ctx = set(dead_ctx_whitelist)
        self.report_every_s = report_every_s
        self._last_report = time.monotonic()
        self.warnings: list[str] = []

    def update(self, feat: list[float], ctx: list[float]):
        self.feat.update(feat)
        self.ctx.update(ctx)
        self.feat.finalize_saturation(feat)
        self.ctx.finalize_saturation(ctx)

    def maybe_report(self) -> list[str]:
        """到点出体检报告，返回新告警列表（终端提示用）。"""
        if time.monotonic() - self._last_report < self.report_every_s:
            return []
        self._last_report = time.monotonic()
        self.warnings = []
        if self.feat.n < 30:
            return []

        report = {"ts": time.time(), "frames": self.feat.n,
                  "feat": [], "ctx": [], "warnings": []}
        for i in range(len(self.feat.mean)):
            v = self.feat.var(i)
            report["feat"].append({"i": i, "mean": round(self.feat.mean[i], 4),
                                   "var": round(v, 6)})
            if v < 1e-8:
                self.warnings.append(f"feat[{i}] 死维（var≈0，非白名单）")
        for i in range(len(self.ctx.mean)):
            v = self.ctx.var(i)
            sat = (self.ctx.lo_hits[i] + self.ctx.hi_hits[i]) / max(1, self.ctx.n)
            report["ctx"].append({"i": i, "mean": round(self.ctx.mean[i], 4),
                                  "var": round(v, 6), "sat": round(sat, 3)})
            if v < 1e-8 and i not in self.dead_ctx:
                self.warnings.append(f"ctx[{i}] 死维（var≈0，非白名单）")
            if sat > 0.30 and i not in self.dead_ctx and v >= 1e-8:
                self.warnings.append(f"ctx[{i}] 饱和率 {sat:.0%} >30%（阈值设计需注意，R4）")
        report["warnings"] = self.warnings
        with open(self.out_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        return self.warnings
