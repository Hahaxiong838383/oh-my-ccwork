from __future__ import annotations

import json

import frappe
from frappe.model.document import Document

from aishike_erp.events import append_device_event
from aishike_erp.manufacturing import ManufacturingRuleError, validate_test_attempt


class AishikeDeviceTestRecord(Document):
    def validate(self) -> None:
        state = frappe.db.get_value("Aishike Device Unit", self.device_unit, "lifecycle_state")
        previous = self.get_doc_before_save()
        if previous:
            frappe.throw("测试记录不可修改；复测必须新增记录")
        try:
            validate_test_attempt(
                lifecycle_state=state,
                test_type=self.test_type,
                result=self.result,
                failure_reason=self.failure_reason,
            )
        except ManufacturingRuleError as error:
            frappe.throw(str(error))
        if self.measurement_json:
            try:
                json.loads(self.measurement_json)
            except (TypeError, ValueError):
                frappe.throw("测量数据必须为有效 JSON")

    def before_insert(self) -> None:
        frappe.db.sql(
            "select name from `tabAishike Device Unit` where name = %s for update",
            self.device_unit,
        )
        self.attempt_no = (
            frappe.db.count(
                "Aishike Device Test Record",
                {"device_unit": self.device_unit, "test_type": self.test_type},
            )
            + 1
        )

    def after_insert(self) -> None:
        append_device_event(
            self.device_unit,
            "TEST_PASS" if self.result == "PASS" else "TEST_FAIL",
            "QMS",
            self.name,
            json.dumps(
                {
                    "test_type": self.test_type,
                    "attempt_no": self.attempt_no,
                    "result": self.result,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
