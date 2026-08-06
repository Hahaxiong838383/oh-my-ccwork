from __future__ import annotations

import json

import frappe
from frappe.model.document import Document

from aishike_erp.events import append_device_event
from aishike_erp.manufacturing import ManufacturingRuleError, validate_flash_attempt


class AishikeFirmwareFlashRecord(Document):
    def validate(self) -> None:
        if self.get_doc_before_save():
            frappe.throw("烧录记录不可修改；重新烧录必须新增记录")

        state = frappe.db.get_value("Aishike Device Unit", self.device_unit, "lifecycle_state")
        try:
            validate_flash_attempt(
                lifecycle_state=state,
                result=self.result,
                firmware_version=self.firmware_version,
                agent_version=self.agent_version,
                failure_reason=self.failure_reason,
            )
        except ManufacturingRuleError as error:
            frappe.throw(str(error))

    def before_insert(self) -> None:
        frappe.db.sql(
            "select name from `tabAishike Device Unit` where name = %s for update",
            self.device_unit,
        )
        self.attempt_no = (
            frappe.db.count("Aishike Firmware Flash Record", {"device_unit": self.device_unit})
            + 1
        )

    def after_insert(self) -> None:
        append_device_event(
            self.device_unit,
            "FLASH_PASS" if self.result == "PASS" else "FLASH_FAIL",
            "MES",
            self.name,
            json.dumps(
                {
                    "attempt_no": self.attempt_no,
                    "firmware_version": self.firmware_version,
                    "agent_version": self.agent_version,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        if self.result != "PASS":
            return

        frappe.db.set_value(
            "Aishike Device Unit",
            self.device_unit,
            {
                "firmware_version": self.firmware_version,
                "agent_version": self.agent_version,
            },
            update_modified=False,
        )
        device = frappe.get_doc("Aishike Device Unit", self.device_unit)
        if device.lifecycle_state == "ASSEMBLED":
            device.lifecycle_state = "FLASHED"
            device.save(ignore_permissions=True)
