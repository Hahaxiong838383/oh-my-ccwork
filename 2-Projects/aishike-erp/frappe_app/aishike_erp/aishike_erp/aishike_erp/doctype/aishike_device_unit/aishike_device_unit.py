from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from aishike_erp.events import append_device_event
from aishike_erp.rules import (
    RuleViolation,
    changed_locked_fields,
    validate_device_state_transition,
)


IDENTITY_FIELDS = ("serial_no", "sku_configuration", "item_code", "bom", "work_order")
REQUIRED_TESTS = {"OPTICAL", "SENSOR", "FUNCTION", "AI", "AGING", "OQC"}


class AishikeDeviceUnit(Document):
    def validate(self) -> None:
        previous = self.get_doc_before_save()
        previous_state = previous.lifecycle_state if previous else None
        try:
            validate_device_state_transition(previous_state, self.lifecycle_state)
        except RuleViolation as error:
            frappe.throw(str(error))

        sku_status = frappe.db.get_value(
            "Aishike SKU Configuration", self.sku_configuration, "status"
        )
        if sku_status != "Approved":
            frappe.throw("只有已批准SKU可以创建设备")

        if previous and previous.lifecycle_state != "CREATED":
            changed = changed_locked_fields(previous.as_dict(), self.as_dict(), IDENTITY_FIELDS)
            if changed:
                frappe.throw(f"设备进入生产后不可修改身份字段: {', '.join(changed)}")

        if self.lifecycle_state == "QC_PASSED":
            self._validate_quality_gate()

        if self.lifecycle_state == "ACTIVATED" and not self.activation_ref:
            frappe.throw("设备激活时必须写入脱敏激活引用")

    def after_insert(self) -> None:
        append_device_event(self.name, "DEVICE_CREATED", "ERP", self.name)
        frappe.db.set_value(self.doctype, self.name, "last_event_at", now_datetime())

    def on_update(self) -> None:
        previous = self.get_doc_before_save()
        if previous and previous.lifecycle_state != self.lifecycle_state:
            append_device_event(
                self.name,
                self.lifecycle_state,
                "ERP",
                self.work_order or self.channel_order_id or self.name,
            )
            frappe.db.set_value(self.doctype, self.name, "last_event_at", now_datetime())

    def _validate_quality_gate(self) -> None:
        rows = frappe.get_all(
            "Aishike Device Test Record",
            filters={"device_unit": self.name},
            fields=["test_type", "result", "tested_at"],
            order_by="tested_at asc, creation asc",
        )
        latest: dict[str, str] = {}
        for row in rows:
            latest[row.test_type] = row.result
        missing_or_failed = sorted(
            test_type for test_type in REQUIRED_TESTS if latest.get(test_type) != "PASS"
        )
        if missing_or_failed:
            frappe.throw(f"质量门未通过: {', '.join(missing_or_failed)}")
