from __future__ import annotations

import frappe
from frappe.model.document import Document

from aishike_erp.phase_gate import is_m3_event_type


class AishikeDeviceLifecycleEvent(Document):
    def validate(self) -> None:
        if self.get_doc_before_save():
            frappe.throw("设备生命周期事件不可修改")
        if not is_m3_event_type(self.event_type):
            frappe.throw(f"当前 M3 阶段不允许写入事件: {self.event_type}")

    def on_trash(self) -> None:
        frappe.throw("设备生命周期事件不可删除")
