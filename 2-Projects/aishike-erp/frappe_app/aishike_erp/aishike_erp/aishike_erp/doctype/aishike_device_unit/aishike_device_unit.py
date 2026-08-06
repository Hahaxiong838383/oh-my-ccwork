from __future__ import annotations

import frappe
from frappe.model.document import Document
from aishike_erp.events import append_device_event
from aishike_erp.phase_gate import is_m3_device_state
from aishike_erp.rules import (
    RuleViolation,
    changed_locked_fields,
    validate_device_state_transition,
)


IDENTITY_FIELDS = ("serial_no", "sku_configuration", "item_code", "bom", "work_order")
PROJECTION_FIELDS = (
    "quality_release_record",
    "current_warehouse",
    "latest_stock_movement",
    "current_channel",
    "channel_order_id",
    "latest_fulfillment_record",
    "logistics_carrier",
    "tracking_no",
    "shipped_at",
    "activation_ref",
    "current_customer_ref",
    "activated_at",
)
REQUIRED_TESTS = {"OPTICAL", "SENSOR", "FUNCTION", "AI", "AGING", "OQC"}


class AishikeDeviceUnit(Document):
    def validate(self) -> None:
        previous = self.get_doc_before_save()
        previous_state = previous.lifecycle_state if previous else None
        if not is_m3_device_state(self.lifecycle_state):
            frappe.throw(f"当前 M3 阶段不允许设备进入状态: {self.lifecycle_state}")
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

        if self.lifecycle_state == "FLASHED" and previous_state != "FLASHED":
            self._validate_flash_gate()

        if self.lifecycle_state == "QC_PASSED" and previous_state != "QC_PASSED":
            self._validate_quality_gate()

        if self.lifecycle_state == "STOCKED" and previous_state != "STOCKED":
            self._validate_stock_gate()

        if self.lifecycle_state in {"ALLOCATED", "SHIPPED", "ACTIVATED"} and (
            previous_state != self.lifecycle_state
        ):
            self._validate_fulfillment_gate()

        if previous:
            changed_projections = changed_locked_fields(
                previous.as_dict(), self.as_dict(), PROJECTION_FIELDS
            )
            if changed_projections:
                self._validate_record_projections()

        if self.lifecycle_state == "ACTIVATED" and not self.activation_ref:
            frappe.throw("设备激活时必须写入脱敏激活引用")

    def after_insert(self) -> None:
        append_device_event(self.name, "DEVICE_CREATED", "ERP", self.name)

    def on_update(self) -> None:
        previous = self.get_doc_before_save()
        if previous and previous.lifecycle_state != self.lifecycle_state:
            append_device_event(
                self.name,
                self.lifecycle_state,
                self.flags.get("lifecycle_source_system") or "ERP",
                self.flags.get("lifecycle_source_record_id")
                or self.work_order
                or self.channel_order_id
                or self.name,
            )

    def _validate_flash_gate(self) -> None:
        latest_result = frappe.db.get_value(
            "Aishike Firmware Flash Record",
            {"device_unit": self.name},
            "result",
            order_by="flashed_at desc, creation desc",
        )
        if latest_result != "PASS":
            frappe.throw("设备必须有最新烧录通过记录才能进入已完成烧录状态")

    def _validate_quality_gate(self) -> None:
        latest_decision = frappe.db.get_value(
            "Aishike Quality Release Record",
            {"device_unit": self.name},
            ["name", "decision"],
            order_by="released_at desc, creation desc",
            as_dict=True,
        )
        if not latest_decision or latest_decision.decision != "PASS":
            frappe.throw("设备必须有最新质量放行通过记录才能进入已通过质量门状态")
        if self.quality_release_record != latest_decision.name:
            frappe.throw("设备质量放行凭证必须指向最新通过记录")

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

    def _validate_stock_gate(self) -> None:
        latest_movement = frappe.db.get_value(
            "Aishike Device Stock Movement",
            {"device_unit": self.name},
            ["name", "movement_type", "to_warehouse"],
            order_by="movement_at desc, creation desc",
            as_dict=True,
        )
        if not latest_movement or latest_movement.movement_type != "RECEIVE":
            frappe.throw("设备必须有成品入库凭证才能进入已入成品库状态")
        if self.latest_stock_movement != latest_movement.name:
            frappe.throw("设备最近库存凭证必须指向成品入库记录")
        if self.current_warehouse != latest_movement.to_warehouse:
            frappe.throw("设备当前仓库必须与成品入库目标仓库一致")

    def _validate_record_projections(self) -> None:
        if self.quality_release_record:
            release = frappe.db.get_value(
                "Aishike Quality Release Record",
                self.quality_release_record,
                ["device_unit", "decision"],
                as_dict=True,
            )
            if not release or release.device_unit != self.name or release.decision != "PASS":
                frappe.throw("设备质量放行凭证不是本设备的有效通过记录")

        if self.latest_stock_movement or self.current_warehouse:
            movement = frappe.db.get_value(
                "Aishike Device Stock Movement",
                self.latest_stock_movement,
                ["device_unit", "to_warehouse"],
                as_dict=True,
            )
            if not movement or movement.device_unit != self.name:
                frappe.throw("设备最近库存凭证不是本设备的有效记录")
            if self.lifecycle_state not in {"SHIPPED", "ACTIVATED"} and (
                movement.to_warehouse != self.current_warehouse
            ):
                frappe.throw("设备当前仓库必须由最近库存移动记录派生")

        if any(
            (
                self.current_channel,
                self.channel_order_id,
                self.latest_fulfillment_record,
                self.logistics_carrier,
                self.tracking_no,
                self.shipped_at,
                self.activation_ref,
                self.current_customer_ref,
                self.activated_at,
            )
        ):
            self._validate_fulfillment_projections()

    def _validate_fulfillment_gate(self) -> None:
        expected_action = {
            "ALLOCATED": "ALLOCATE",
            "SHIPPED": "SHIP",
            "ACTIVATED": "ACTIVATE",
        }[self.lifecycle_state]
        latest = frappe.db.get_value(
            "Aishike Device Fulfillment Record",
            {"device_unit": self.name},
            ["name", "action", "channel_order"],
            order_by="action_at desc, creation desc",
            as_dict=True,
        )
        if not latest or latest.action != expected_action:
            frappe.throw(f"设备必须有有效的{expected_action}履约凭证才能推进状态")
        if self.latest_fulfillment_record != latest.name:
            frappe.throw("设备最近履约凭证必须指向当前状态对应记录")
        if self.channel_order_id != latest.channel_order:
            frappe.throw("设备渠道订单必须由履约凭证派生")

    def _validate_fulfillment_projections(self) -> None:
        latest = frappe.db.get_value(
            "Aishike Device Fulfillment Record",
            self.latest_fulfillment_record,
            ["device_unit", "channel_order", "action"],
            as_dict=True,
        )
        if not latest or latest.device_unit != self.name:
            frappe.throw("设备最近履约凭证不是本设备的有效记录")
        order = frappe.db.get_value(
            "Aishike Channel Order",
            latest.channel_order,
            ["name", "channel"],
            as_dict=True,
        )
        if not order or self.channel_order_id != order.name:
            frappe.throw("设备渠道订单不是履约凭证对应订单")
        if self.current_channel != order.channel:
            frappe.throw("设备销售渠道必须由渠道订单派生")

        shipment = frappe.db.get_value(
            "Aishike Device Fulfillment Record",
            {"device_unit": self.name, "action": "SHIP"},
            ["logistics_carrier", "tracking_no", "action_at", "operation_warehouse"],
            order_by="action_at desc, creation desc",
            as_dict=True,
        )
        if self.lifecycle_state in {"SHIPPED", "ACTIVATED"}:
            if not shipment:
                frappe.throw("设备缺少发货凭证")
            if self.current_warehouse:
                frappe.throw("已发货设备不能继续保留当前库存仓库")
            if (
                self.logistics_carrier != shipment.logistics_carrier
                or self.tracking_no != shipment.tracking_no
                or self.shipped_at != shipment.action_at
            ):
                frappe.throw("设备物流投影必须由发货凭证派生")

        activation = frappe.db.get_value(
            "Aishike Device Fulfillment Record",
            {"device_unit": self.name, "action": "ACTIVATE"},
            ["activation_ref", "customer_ref", "action_at"],
            order_by="action_at desc, creation desc",
            as_dict=True,
        )
        if self.lifecycle_state == "ACTIVATED":
            if not activation:
                frappe.throw("设备缺少激活凭证")
            if (
                self.activation_ref != activation.activation_ref
                or (self.current_customer_ref or "") != (activation.customer_ref or "")
                or self.activated_at != activation.action_at
            ):
                frappe.throw("设备激活投影必须由激活凭证派生")
