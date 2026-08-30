"""calib_store.py — 校准档持久化（2026-08 v3.9 增量标定）

把显式标定结果（锚点+系数）与隐式捏取样本落盘，启动时加载 →
3 点快验微调，免去每次开 App 全量 9 点标定。

安全设计（threshold_dead_signal 教训的预防）：
- 元数据校验：backend / deg_scale / 标定点布局版本任一不匹配 → 弃档
  （换信号源/改归一化/改点表后，旧档的 raw 空间不兼容，是毒药）
- 任何读取异常（文件损坏/字段缺失/类型错）→ 返回 None，静默回全量
  标定（fail safe），绝不带病加载
- 隐式样本带时间戳，回灌时超保鲜期的丢弃

档案路径：~/Library/Application Support/GestureDemo/calibration.json
（删掉此文件 = 物理重置，逃生门）
"""
from __future__ import annotations

import json
import os
import time
from typing import List, Optional, Sequence, Tuple

from config import (
    CALIB_STORE_ENABLED, GAZE_BACKEND, GAZE_PT_DEG_SCALE,
    IMPLICIT_PERSIST_DAYS,
)

STORE_DIR = os.path.expanduser("~/Library/Application Support/GestureDemo")
STORE_PATH = os.path.join(STORE_DIR, "calibration.json")
_FORMAT_VERSION = 1


def save(coef_x: Sequence[float], coef_y: Sequence[float],
         anchors_measured: Sequence[Tuple[float, float]],
         anchors_expected: Sequence[Tuple[float, float]],
         points_layout: str,
         implicit_samples: Optional[List[dict]] = None) -> bool:
    """写校准档。implicit_samples: [{"raw":[x,y],"expected":[x,y],"ts":epoch}]"""
    if not CALIB_STORE_ENABLED:
        return False
    data = {
        "format": _FORMAT_VERSION,
        "saved_at": time.time(),
        # ── 兼容性元数据：任一不匹配即弃档 ──
        "backend": GAZE_BACKEND,
        "deg_scale": GAZE_PT_DEG_SCALE,
        "points_layout": points_layout,
        # ── 载荷 ──
        "coef_x": [float(v) for v in coef_x],
        "coef_y": [float(v) for v in coef_y],
        "anchors_measured": [[float(a), float(b)] for a, b in anchors_measured],
        "anchors_expected": [[float(a), float(b)] for a, b in anchors_expected],
        "implicit_samples": implicit_samples or [],
    }
    try:
        os.makedirs(STORE_DIR, exist_ok=True)
        tmp = STORE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, STORE_PATH)  # 原子替换，防写一半损档
        print(f"[CalibStore] 校准档已保存 ({len(data['anchors_measured'])} 锚点, "
              f"{len(data['implicit_samples'])} 隐式样本)")
        return True
    except OSError as e:
        print(f"[CalibStore] 保存失败（不影响使用）: {e}")
        return False


def load(points_layout: str) -> Optional[dict]:
    """读校准档。不存在/损坏/元数据不匹配 → None（回全量标定）。

    返回 dict：coef_x/coef_y/anchors_measured/anchors_expected/
    implicit_samples（已过滤超期）/saved_at。
    """
    if not CALIB_STORE_ENABLED or not os.path.exists(STORE_PATH):
        return None
    try:
        with open(STORE_PATH) as f:
            data = json.load(f)
        # 兼容性校验：不匹配的旧档是毒药（raw 空间语义已变）
        for key, want in (("format", _FORMAT_VERSION),
                          ("backend", GAZE_BACKEND),
                          ("deg_scale", GAZE_PT_DEG_SCALE),
                          ("points_layout", points_layout)):
            if data.get(key) != want:
                print(f"[CalibStore] 档案 {key}={data.get(key)!r} 与当前 "
                      f"{want!r} 不匹配，弃档（需全量重标）")
                return None
        coef_x = [float(v) for v in data["coef_x"]]
        coef_y = [float(v) for v in data["coef_y"]]
        if len(coef_x) != 6 or len(coef_y) != 6:
            raise ValueError("coef 维度异常")
        anchors_m = [(float(a), float(b)) for a, b in data["anchors_measured"]]
        anchors_e = [(float(a), float(b)) for a, b in data["anchors_expected"]]
        if len(anchors_m) != len(anchors_e) or len(anchors_m) < 5:
            raise ValueError("锚点数量异常")
        # 隐式样本保鲜过滤
        cutoff = time.time() - IMPLICIT_PERSIST_DAYS * 86400
        samples = [s for s in data.get("implicit_samples", [])
                   if isinstance(s, dict) and s.get("ts", 0) >= cutoff
                   and len(s.get("raw", [])) == 2
                   and len(s.get("expected", [])) == 2]
        age_h = (time.time() - data["saved_at"]) / 3600
        print(f"[CalibStore] 已加载校准档（{age_h:.1f}h 前保存, "
              f"{len(anchors_m)} 锚点, 隐式样本 {len(samples)} 条在保鲜期）")
        return {
            "coef_x": coef_x, "coef_y": coef_y,
            "anchors_measured": anchors_m, "anchors_expected": anchors_e,
            "implicit_samples": samples, "saved_at": data["saved_at"],
        }
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
        print(f"[CalibStore] 档案读取失败，回全量标定: {e}")
        return None


def clear() -> None:
    """删档（按 C 全量重标前不必调用——重标完成 save 会覆盖；供手动重置）"""
    try:
        os.remove(STORE_PATH)
        print("[CalibStore] 校准档已删除")
    except OSError:
        pass
