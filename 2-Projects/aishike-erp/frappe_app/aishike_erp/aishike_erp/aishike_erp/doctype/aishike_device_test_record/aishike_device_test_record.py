from __future__ import annotations

import frappe
from frappe.model.document import Document

from aishike_erp.events import append_device_event


class AishikeDeviceTestRecord(Document):
    def validate(self) -> None:
        state = frappe.db.get_value("Aishike Device Unit", self.device_unit, "lifecycle_state")
        if state not in {"FLASHED", "QC_PASSED"}:
            frappe.throw("设备必须完成烧录后才能记录出厂测试")

        previous = self.get_doc_before_save()
        if previous:
            frappe.throw("测试记录不可修改；复测必须新增记录")

    def after_insert(self) -> None:
        append_device_event(
            self.device_unit,
            "TEST_PASS" if self.result == "PASS" else "TEST_FAIL",
            "QMS",
            self.name,
        )
