from __future__ import annotations

import json

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from aishike_erp.events import append_device_event
from aishike_erp.manufacturing import summarize_test_records
from aishike_erp.quality_inventory import (
    QualityInventoryRuleError,
    validate_quality_release,
)


class AishikeQualityReleaseRecord(Document):
    def validate(self) -> None:
        if self.get_doc_before_save():
            frappe.throw("质量放行记录不可修改；重新判定必须新增记录")

        state = frappe.db.get_value("Aishike Device Unit", self.device_unit, "lifecycle_state")
        test_records = frappe.get_all(
            "Aishike Device Test Record",
            filters={"device_unit": self.device_unit},
            fields=["test_type", "result"],
            order_by="tested_at asc, creation asc",
            limit_page_length=200,
        )
        summary = summarize_test_records(test_records)
        try:
            validate_quality_release(
                lifecycle_state=state,
                decision=self.decision,
                tests_complete=bool(summary["complete"]),
                failure_reason=self.failure_reason,
            )
        except QualityInventoryRuleError as error:
            frappe.throw(str(error))

    def before_insert(self) -> None:
        frappe.db.sql(
            "select name from `tabAishike Device Unit` where name = %s for update",
            self.device_unit,
        )
        self.decision = (self.decision or "").strip().upper()
        self.checklist_version = (self.checklist_version or "").strip()
        self.released_at = now_datetime()
        self.inspector = frappe.session.user
        self.release_summary = (self.release_summary or "").strip()
        self.failure_reason = (self.failure_reason or "").strip()
        self.attempt_no = (
            frappe.db.count("Aishike Quality Release Record", {"device_unit": self.device_unit})
            + 1
        )

    def after_insert(self) -> None:
        if self.decision == "REJECT":
            append_device_event(
                self.device_unit,
                "QUALITY_REJECTED",
                "QMS",
                self.name,
                json.dumps(
                    {"attempt_no": self.attempt_no, "checklist_version": self.checklist_version},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            )
            return

        device = frappe.get_doc("Aishike Device Unit", self.device_unit)
        device.quality_release_record = self.name
        device.lifecycle_state = "QC_PASSED"
        device.flags.lifecycle_source_system = "QMS"
        device.flags.lifecycle_source_record_id = self.name
        device.save(ignore_permissions=True)

    def on_trash(self) -> None:
        frappe.throw("质量放行记录不可删除")
