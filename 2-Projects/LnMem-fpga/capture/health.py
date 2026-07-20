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
    """判定规则（2026-07-20 验收后校准）：
    - 死维 = max==min 完全恒定（var 阈值会把短会话没做的低频表情维误杀）
    - feat 侧告警需 n≥feat_min_frames（~3 分钟）：短会话盖不满 52 个表情维是正常的
    - ctx 侧不做饱和检查：one-hot/binary/单调/比率维天然贴边，全是伪影
    """

    def __init__(self, out_path, feat_dim: int, ctx_dim: int,
                 dead_ctx_whitelist: list[int],
                 dead_feat_whitelist: list[int] = (),
                 feat_min_frames: int = 3000,
                 report_every_s: float = 60.0):
        self.out_path = out_path
        self.feat = DimStats(feat_dim)
        self.ctx = DimStats(ctx_dim)
        self.dead_ctx = set(dead_ctx_whitelist)
        self.dead_feat = set(dead_feat_whitelist)
        self.feat_min_frames = feat_min_frames
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
            rng = self.feat.max[i] - self.feat.min[i]
            sat = (self.feat.lo_hits[i] + self.feat.hi_hits[i]) / max(1, self.feat.n)
            report["feat"].append({"i": i, "mean": round(self.feat.mean[i], 4),
                                   "rng": round(rng, 6), "sat": round(sat, 3)})
            if self.feat.n >= self.feat_min_frames and i not in self.dead_feat:
                if rng < 1e-9:
                    self.warnings.append(f"feat[{i}] 死维（完全恒定，非白名单）")
                elif sat > 0.30:
                    self.warnings.append(f"feat[{i}] 饱和率 {sat:.0%} >30%（R4）")
        for i in range(len(self.ctx.mean)):
            rng = self.ctx.max[i] - self.ctx.min[i]
            report["ctx"].append({"i": i, "mean": round(self.ctx.mean[i], 4),
                                  "rng": round(rng, 6)})
            # ctx 只查死维（饱和对 one-hot/binary/单调/比率维全是伪影）
            if rng < 1e-9 and i not in self.dead_ctx:
                self.warnings.append(f"ctx[{i}] 死维（完全恒定，非白名单）")
        report["warnings"] = self.warnings
        with open(self.out_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        return self.warnings
