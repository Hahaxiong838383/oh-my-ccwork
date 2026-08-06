from __future__ import annotations

import json

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from aishike_erp.events import append_device_event
from aishike_erp.quality_inventory import (
    QualityInventoryRuleError,
    validate_stock_movement,
)


class AishikeDeviceStockMovement(Document):
    def validate(self) -> None:
        if self.get_doc_before_save():
            frappe.throw("库存移动记录不可修改；新的移动必须新增记录")

        device = frappe.db.get_value(
            "Aishike Device Unit",
            self.device_unit,
            ["lifecycle_state", "current_warehouse"],
            as_dict=True,
        )
        if not device:
            frappe.throw("设备不存在")
        target_warehouse = frappe.db.get_value(
            "Warehouse",
            self.to_warehouse,
            ["is_group", "disabled"],
            as_dict=True,
        )
        if not target_warehouse:
            frappe.throw("目标仓库不存在")
        if target_warehouse.is_group:
            frappe.throw("目标仓库必须是可存货的末级仓库")
        if target_warehouse.disabled:
            frappe.throw("目标仓库已停用")
        try:
            validate_stock_movement(
                lifecycle_state=device.lifecycle_state,
                movement_type=self.movement_type,
                current_warehouse=device.current_warehouse or "",
                from_warehouse=self.from_warehouse or "",
                to_warehouse=self.to_warehouse or "",
            )
        except QualityInventoryRuleError as error:
            frappe.throw(str(error))

    def before_insert(self) -> None:
        frappe.db.sql(
            "select name from `tabAishike Device Unit` where name = %s for update",
            self.device_unit,
        )
        current_warehouse = frappe.db.get_value(
            "Aishike Device Unit", self.device_unit, "current_warehouse"
        )
        self.movement_type = (self.movement_type or "").strip().upper()
        self.from_warehouse = current_warehouse if self.movement_type == "TRANSFER" else None
        self.movement_at = now_datetime()
        self.operator = frappe.session.user
        self.reference_type = (self.reference_type or "").strip()
        self.reference_id = (self.reference_id or "").strip()
        self.remarks = (self.remarks or "").strip()
        self.movement_no = (
            frappe.db.count("Aishike Device Stock Movement", {"device_unit": self.device_unit})
            + 1
        )

    def after_insert(self) -> None:
        device = frappe.get_doc("Aishike Device Unit", self.device_unit)
        device.current_warehouse = self.to_warehouse
        device.latest_stock_movement = self.name
        if self.movement_type == "RECEIVE":
            device.lifecycle_state = "STOCKED"
            device.flags.lifecycle_source_system = "WMS"
            device.flags.lifecycle_source_record_id = self.name
            device.save(ignore_permissions=True)
            return

        device.save(ignore_permissions=True)
        append_device_event(
            self.device_unit,
            "STOCK_TRANSFERRED",
            "WMS",
            self.name,
            json.dumps(
                {
                    "movement_no": self.movement_no,
                    "from_warehouse": self.from_warehouse,
                    "to_warehouse": self.to_warehouse,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )

    def on_trash(self) -> None:
        frappe.throw("库存移动记录不可删除")
