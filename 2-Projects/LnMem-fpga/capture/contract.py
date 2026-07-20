"""feature_contract.md v0.1 的代码化（单一真源是契约文档，本文件与其对齐）。

v0 采集器范围声明：
- context 16 维中，活维 12 / dead-by-design 4（见 DEAD_BY_DESIGN_V0）。
- 死维显式登记 + 健康哨兵白名单 + 训练侧 drop——符合契约「禁止无人知晓的死维」精神；
  禁止的是静默灌缺省，不是登记在册的无源维。
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field

CONTRACT_VERSION = 1
CONTEXT_SCHEMA_ID = 1  # 会议场景 v1
FEAT_DIM = 64
CONTEXT_DIM = 16

# context one-hot 事件位（idx 0-7），顺序与契约 §4 一致
EVENT_TYPES = [
    "none",                 # 0
    "speech_start",         # 1  v0 有源（VAD 边沿）
    "speech_end",           # 2  v0 有源（VAD 边沿）
    "question_asked",       # 3  v0 无源
    "screen_share_change",  # 4  v0 无源
    "agenda_item_change",   # 5  v0 无源
    "join_leave",           # 6  v0 无源
    "mute_toggle",          # 7  v0 无源
]
EVENT_IDX = {name: i for i, name in enumerate(EVENT_TYPES)}

CONTEXT_NAMES = EVENT_TYPES + [
    "dt_last_event",      # 8
    "someone_speaking",   # 9   v0 无源
    "self_speaking",      # 10
    "kbd_mouse_activity", # 11
    "meeting_elapsed",    # 12
    "agenda_dwell",       # 13  v0 无源
    "hour_sin",           # 14
    "hour_cos",           # 15
]

# v0 dead-by-design：context 维索引 + one-hot 永不触发的事件位。
# 健康哨兵白名单引用此表；训练侧按此表 drop。
DEAD_BY_DESIGN_V0 = {
    "context_dims": [9, 13],          # someone_speaking / agenda_dwell
    "event_onehot_bits": [3, 4, 5, 6, 7],
}

DT_LAST_EVENT_CAP_S = 600.0
AGENDA_DWELL_CAP_S = 1800.0
MEETING_ELAPSED_CAP_S = 3600.0


def encode_dt_last_event(seconds: float) -> float:
    """log1p 压缩到 [0,1]，契约 §4 idx8。"""
    s = max(0.0, float(seconds))
    return min(1.0, math.log1p(s) / math.log1p(DT_LAST_EVENT_CAP_S))


def hour_sincos(hour_float: float) -> tuple[float, float]:
    a = 2.0 * math.pi * (hour_float % 24.0) / 24.0
    return math.sin(a), math.cos(a)


def build_context(
    last_event_type: str,
    dt_last_event_s: float,
    self_speaking: bool,
    kbd_mouse_activity: float,
    meeting_elapsed_s: float,
    hour_float: float,
) -> list[float]:
    """组装 16 维 context（v0：死维恒 0，登记于 DEAD_BY_DESIGN_V0）。"""
    c = [0.0] * CONTEXT_DIM
    c[EVENT_IDX.get(last_event_type, 0)] = 1.0
    c[8] = encode_dt_last_event(dt_last_event_s)
    c[9] = 0.0  # someone_speaking: dead-by-design v0
    c[10] = 1.0 if self_speaking else 0.0
    c[11] = min(1.0, max(0.0, float(kbd_mouse_activity)))
    c[12] = min(1.0, max(0.0, meeting_elapsed_s / MEETING_ELAPSED_CAP_S))
    c[13] = 0.0  # agenda_dwell: dead-by-design v0
    c[14], c[15] = hour_sincos(hour_float)
    return c


@dataclass
class FrameRecord:
    """FeatureFrame v1（契约 §2）的落盘形态。数值存 raw，标准化归训练侧。"""
    ts_mono_ms: int
    track_id: int
    face_bbox: list[float]        # 归一化 x,y,w,h
    pose: list[float]             # yaw,pitch,roll 度
    pose_valid: bool
    feat: list[float]             # FEAT_DIM 维
    context: list[float]          # CONTEXT_DIM 维
    context_valid: bool
    quality: float
    valid: bool
    contract_version: int = CONTRACT_VERSION
    context_schema_id: int = CONTEXT_SCHEMA_ID

    def to_json(self) -> str:
        d = self.__dict__.copy()
        d["feat"] = [round(x, 5) for x in self.feat]
        d["context"] = [round(x, 5) for x in self.context]
        d["face_bbox"] = [round(x, 5) for x in self.face_bbox]
        d["pose"] = [round(x, 2) for x in self.pose]
        d["quality"] = round(self.quality, 4)
        return json.dumps(d, ensure_ascii=False)


@dataclass
class EventRecord:
    """事件流本体（契约 §4 规则 1：one-hot 只是摘要，事件流才是全量真源）。"""
    id: str
    ts_mono_ms: int
    type: str                     # 不限于 EVENT_TYPES（如 leave_seat/app_switch 供标注用）
    meta: dict = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(self.__dict__, ensure_ascii=False)
