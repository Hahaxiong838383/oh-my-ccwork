from __future__ import annotations

import frappe
from frappe.model.document import Document


class AishikeDeviceLifecycleEvent(Document):
    def validate(self) -> None:
        if self.get_doc_before_save():
            frappe.throw("设备生命周期事件不可修改")

    def on_trash(self) -> None:
        frappe.throw("设备生命周期事件不可删除")
