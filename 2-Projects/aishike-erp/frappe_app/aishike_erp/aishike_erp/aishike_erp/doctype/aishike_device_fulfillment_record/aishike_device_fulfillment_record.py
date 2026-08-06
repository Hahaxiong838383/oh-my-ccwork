from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from aishike_erp.fulfillment_projection import refresh_order_projection
from aishike_erp.fulfillment_rules import (
    FulfillmentRuleError,
    validate_deidentified_reference,
    validate_fulfillment_action,
)


ACTION_SOURCE_SYSTEM = {
    "ALLOCATE": "OMS",
    "SHIP": "WMS",
    "ACTIVATE": "IOT",
}


class AishikeDeviceFulfillmentRecord(Document):
    def before_insert(self) -> None:
        self.action = (self.action or "").strip().upper()
        frappe.db.sql(
            "select name from `tabAishike Channel Order` where name = %s for update",
            self.channel_order,
        )
        frappe.db.sql(
            "select name from `tabAishike Device Unit` where name = %s for update",
            self.device_unit,
        )
        self.action_key = f"{self.device_unit}|{self.action}"
        self.action_no = (
            frappe.db.count(
                "Aishike Device Fulfillment Record", {"device_unit": self.device_unit}
            )
            + 1
        )
        self.action_at = now_datetime()
        self.operator = frappe.session.user
        self.source_system = ACTION_SOURCE_SYSTEM.get(self.action, "ERP")
        self.logistics_carrier = (self.logistics_carrier or "").strip()
        self.tracking_no = (self.tracking_no or "").strip().upper()
        self.activation_ref = (self.activation_ref or "").strip()
        self.customer_ref = (self.customer_ref or "").strip()
        self.source_record_id = (self.source_record_id or "").strip()
        self.remarks = (self.remarks or "").strip()
        self.operation_warehouse = frappe.db.get_value(
            "Aishike Device Unit", self.device_unit, "current_warehouse"
        )

    def validate(self) -> None:
        if self.get_doc_before_save():
            frappe.throw("设备履约凭证不可修改；新的动作必须新增凭证")
        self._validate_action_role()
        order = frappe.db.get_value(
            "Aishike Channel Order",
            self.channel_order,
            ["name", "sku_configuration", "order_quantity", "allocated_count"],
            as_dict=True,
        )
        device = frappe.db.get_value(
            "Aishike Device Unit",
            self.device_unit,
            [
                "lifecycle_state",
                "sku_configuration",
                "channel_order_id",
                "current_warehouse",
            ],
            as_dict=True,
        )
        if not order or not device:
            frappe.throw("渠道订单或设备不存在")
        try:
            validate_fulfillment_action(
                action=self.action,
                device_state=device.lifecycle_state,
                device_sku=device.sku_configuration,
                order_sku=order.sku_configuration,
                device_order_id=device.channel_order_id or "",
                order_name=order.name,
                current_warehouse=device.current_warehouse or "",
                allocated_count=int(order.allocated_count or 0),
                order_quantity=int(order.order_quantity or 0),
                logistics_carrier=self.logistics_carrier or "",
                tracking_no=self.tracking_no or "",
                activation_ref=self.activation_ref or "",
            )
            validate_deidentified_reference(
                self.customer_ref or "", "脱敏客户引用", required=False
            )
        except FulfillmentRuleError as error:
            frappe.throw(str(error))

    def after_insert(self) -> None:
        order = frappe.get_doc("Aishike Channel Order", self.channel_order)
        device = frappe.get_doc("Aishike Device Unit", self.device_unit)
        device.current_channel = order.channel
        device.channel_order_id = order.name
        device.latest_fulfillment_record = self.name

        if self.action == "ALLOCATE":
            device.lifecycle_state = "ALLOCATED"
        elif self.action == "SHIP":
            device.lifecycle_state = "SHIPPED"
            device.logistics_carrier = self.logistics_carrier
            device.tracking_no = self.tracking_no
            device.shipped_at = self.action_at
            device.current_warehouse = None
        else:
            device.lifecycle_state = "ACTIVATED"
            device.activation_ref = self.activation_ref
            device.current_customer_ref = self.customer_ref or None
            device.activated_at = self.action_at

        device.flags.lifecycle_source_system = self.source_system
        device.flags.lifecycle_source_record_id = self.name
        device.flags.fulfillment_projection_update = True
        device.save(ignore_permissions=True)
        refresh_order_projection(self.channel_order)

    def on_trash(self) -> None:
        frappe.throw("设备履约凭证不可删除")

    def _validate_action_role(self) -> None:
        if frappe.session.user == "Administrator":
            return
        roles = set(frappe.get_roles())
        if self.action in {"ALLOCATE", "SHIP"} and "Stock Manager" in roles:
            return
        if self.action == "ACTIVATE" and "System Manager" in roles:
            return
        frappe.throw("当前岗位无权执行该履约动作", frappe.PermissionError)
