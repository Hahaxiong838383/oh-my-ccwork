"""事件锚检测（标注手册 §1.4 的自动化基础）。

- speech_start / speech_end：self_speaking VAD 边沿（MicVAD 已做时长去抖，
  这里只做纯边沿转事件）——I3「准备发言」的事件锚。
- leave_seat 候选：脸 present→absent 持续 >3s 且此前连续在场 >60s
  ——I5「离开倾向」的事件锚（候选，标注时人工确认）。
- app_switch：前台 app 变化（元数据事件，供离线分析，不进 context one-hot）。

事件流是全量真源（契约 §4 规则 1）；context one-hot 只摘要其中 8 类。
"""
from __future__ import annotations

from contract import EventRecord


class EventLog:
    def __init__(self, path, listener=None):
        self._f = open(path, "a", buffering=1, encoding="utf-8")
        self._listener = listener
        self._seq = 0
        self.last_event_type = "none"     # 供 context one-hot（仅契约 8 类更新）
        self.last_event_ts_ms: int | None = None
        self.count = 0
        self._onehot_types = {"speech_start", "speech_end", "question_asked",
                              "screen_share_change", "agenda_item_change",
                              "join_leave", "mute_toggle"}

    def emit(self, ts_ms: int, etype: str, meta: dict | None = None) -> EventRecord:
        self._seq += 1
        ev = EventRecord(id=f"ev_{self._seq:06d}", ts_mono_ms=ts_ms,
                         type=etype, meta=meta or {})
        self._f.write(ev.to_json() + "\n")
        self.count += 1
        if etype in self._onehot_types:
            self.last_event_type = etype
            self.last_event_ts_ms = ts_ms
        if self._listener:
            self._listener(ev)
        return ev

    def dt_last_event_s(self, now_ms: int) -> float:
        if self.last_event_ts_ms is None:
            return 1e9  # 编码后饱和为 1.0
        return max(0.0, (now_ms - self.last_event_ts_ms) / 1000.0)

    def close(self):
        self._f.close()


class SpeechEdge:
    """VAD 布尔流 → speech_start/end 事件。"""

    def __init__(self, log: EventLog):
        self._log = log
        self._prev = False

    def update(self, ts_ms: int, speaking: bool):
        if speaking and not self._prev:
            self._log.emit(ts_ms, "speech_start")
        elif not speaking and self._prev:
            self._log.emit(ts_ms, "speech_end")
        self._prev = speaking


class LeaveSeatDetector:
    """脸消失检测 → leave_seat 候选事件。"""

    def __init__(self, log: EventLog, absent_s: float = 3.0, present_s: float = 30.0):
        # present_s 2026-07-20 验收校准 60→30：60s 门槛让 57.69s 起身的真实离座差 2.4s
        # 被漏掉；30s 仍足以防「路过/刚坐下就走」误报，且 leave_seat 仅是候选（仲裁兜底）
        self._log = log
        self._absent_ms = absent_s * 1000
        self._present_ms = present_s * 1000
        self._present_since: int | None = None
        self._absent_since: int | None = None
        self._present_run_ms = 0.0
        self._fired = False

    def update(self, ts_ms: int, face_present: bool):
        if face_present:
            if self._present_since is None:
                self._present_since = ts_ms
            self._present_run_ms = ts_ms - self._present_since
            self._absent_since = None
            self._fired = False
        else:
            if self._absent_since is None:
                self._absent_since = ts_ms
            if (not self._fired
                    and self._present_run_ms >= self._present_ms
                    and ts_ms - self._absent_since >= self._absent_ms):
                self._log.emit(ts_ms, "leave_seat",
                               {"present_run_s": round(self._present_run_ms / 1000, 1)})
                self._fired = True
                self._present_since = None
                self._present_run_ms = 0.0


class AppSwitchDetector:
    def __init__(self, log: EventLog):
        self._log = log
        self._prev: str | None = None

    def update(self, ts_ms: int, bundle_id: str):
        if bundle_id != self._prev and self._prev is not None:
            self._log.emit(ts_ms, "app_switch", {"to": bundle_id})
        self._prev = bundle_id
