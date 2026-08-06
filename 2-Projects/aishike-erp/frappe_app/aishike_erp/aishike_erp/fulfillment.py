from __future__ import annotations

import frappe
from frappe import _

from aishike_erp.fulfillment_rules import build_mapping_key, build_order_key
from aishike_erp.serials import SerialRuleError, normalize_scan_value


@frappe.whitelist()
def get_fulfillment_setup() -> dict[str, object]:
    frappe.has_permission("Aishike Channel Order", "read", throw=True)
    roles = set(frappe.get_roles())
    is_administrator = frappe.session.user == "Administrator"
    return {
        "channels": ["TMALL", "JD", "DEALER"],
        "mappings": frappe.get_all(
            "Aishike Channel SKU Mapping",
            filters={"status": "ACTIVE"},
            fields=[
                "name",
                "channel",
                "channel_scope",
                "external_sku",
                "sku_configuration",
            ],
            order_by="channel asc, channel_scope asc, external_sku asc",
            limit_page_length=500,
        ),
        "permissions": {
            "can_create_mapping": frappe.has_permission(
                "Aishike Channel SKU Mapping", "create"
            ),
            "can_create_order": frappe.has_permission("Aishike Channel Order", "create"),
            "can_fulfill": frappe.has_permission(
                "Aishike Device Fulfillment Record", "create"
            ),
            "can_allocate_ship": is_administrator or "Stock Manager" in roles,
            "can_activate": is_administrator or "System Manager" in roles,
        },
    }


@frappe.whitelist()
def get_fulfillment_console(search_value: str) -> dict[str, object]:
    frappe.has_permission("Aishike Channel Order", "read", throw=True)
    order_name = _resolve_order(search_value)
    order = frappe.db.get_value(
        "Aishike Channel Order",
        order_name,
        [
            "name",
            "channel",
            "channel_scope",
            "external_order_id",
            "channel_sku_mapping",
            "external_sku",
            "sku_configuration",
            "order_quantity",
            "order_status",
            "allocated_count",
            "shipped_count",
            "activated_count",
            "recipient_ref",
            "internal_sales_order",
            "raw_payload_ref",
            "imported_at",
            "imported_by",
        ],
        as_dict=True,
    )
    mapping = frappe.db.get_value(
        "Aishike Channel SKU Mapping",
        order.channel_sku_mapping,
        [
            "name",
            "channel",
            "channel_scope",
            "external_sku",
            "sku_configuration",
            "status",
        ],
        as_dict=True,
    )
    records = frappe.get_all(
        "Aishike Device Fulfillment Record",
        filters={"channel_order": order_name},
        fields=[
            "name",
            "device_unit",
            "action",
            "action_no",
            "action_at",
            "operator",
            "source_system",
            "operation_warehouse",
            "logistics_carrier",
            "tracking_no",
            "activation_ref",
            "customer_ref",
            "source_record_id",
            "remarks",
        ],
        order_by="action_at desc, creation desc",
        limit_page_length=1000,
    )
    devices = frappe.get_all(
        "Aishike Device Unit",
        filters={"channel_order_id": order_name},
        fields=[
            "name",
            "lifecycle_state",
            "sku_configuration",
            "current_warehouse",
            "latest_fulfillment_record",
            "logistics_carrier",
            "tracking_no",
            "shipped_at",
            "activation_ref",
            "current_customer_ref",
            "activated_at",
        ],
        order_by="name asc",
        limit_page_length=500,
    )
    available_devices = frappe.get_all(
        "Aishike Device Unit",
        filters={
            "lifecycle_state": "STOCKED",
            "sku_configuration": order.sku_configuration,
        },
        fields=["name", "current_warehouse", "production_batch"],
        order_by="creation asc",
        limit_page_length=200,
    )
    return {
        "order": order,
        "mapping": mapping,
        "records": records,
        "devices": devices,
        "available_devices": available_devices,
        "setup": get_fulfillment_setup(),
    }


@frappe.whitelist(methods=["POST"])
def create_channel_mapping(
    channel: str,
    channel_scope: str,
    external_sku: str,
    sku_configuration: str,
    valid_from: str = "",
    valid_to: str = "",
) -> dict[str, object]:
    frappe.has_permission("Aishike Channel SKU Mapping", "create", throw=True)
    mapping_key = build_mapping_key(channel, channel_scope, external_sku)
    existing_name = frappe.db.get_value(
        "Aishike Channel SKU Mapping", {"mapping_key": mapping_key}, "name"
    )
    if existing_name:
        existing = frappe.get_doc("Aishike Channel SKU Mapping", existing_name)
        if existing.sku_configuration != sku_configuration or existing.status != "ACTIVE":
            frappe.throw("同一渠道 SKU 已存在不同或已停用的映射，不能自动覆盖")
        return {"mapping": existing.as_dict(), "reused": True}

    mapping = frappe.get_doc(
        {
            "doctype": "Aishike Channel SKU Mapping",
            "channel": channel,
            "channel_scope": channel_scope,
            "external_sku": external_sku,
            "sku_configuration": sku_configuration,
            "status": "ACTIVE",
            "valid_from": valid_from or None,
            "valid_to": valid_to or None,
        }
    ).insert()
    return {"mapping": mapping.as_dict(), "reused": False}


@frappe.whitelist(methods=["POST"])
def create_channel_order(
    channel: str,
    channel_scope: str,
    external_order_id: str,
    channel_sku_mapping: str,
    order_quantity: int = 1,
    recipient_ref: str = "",
    internal_sales_order: str = "",
    raw_payload_ref: str = "",
) -> dict[str, object]:
    frappe.has_permission("Aishike Channel Order", "create", throw=True)
    order_key = build_order_key(channel, channel_scope, external_order_id)
    existing_name = frappe.db.get_value(
        "Aishike Channel Order", {"external_order_key": order_key}, "name"
    )
    if existing_name:
        existing = frappe.db.get_value(
            "Aishike Channel Order",
            existing_name,
            ["channel_sku_mapping", "order_quantity", "recipient_ref"],
            as_dict=True,
        )
        if (
            existing.channel_sku_mapping != channel_sku_mapping
            or int(existing.order_quantity or 0) != int(order_quantity or 0)
            or (existing.recipient_ref or "") != (recipient_ref or "").strip()
        ):
            frappe.throw("重复渠道订单与原订单内容冲突，不能覆盖")
        result = get_fulfillment_console(existing_name)
        result["reused"] = True
        return result

    order = frappe.get_doc(
        {
            "doctype": "Aishike Channel Order",
            "channel": channel,
            "channel_scope": channel_scope,
            "external_order_id": external_order_id,
            "channel_sku_mapping": channel_sku_mapping,
            "order_quantity": int(order_quantity or 0),
            "recipient_ref": recipient_ref,
            "internal_sales_order": internal_sales_order or None,
            "raw_payload_ref": raw_payload_ref,
        }
    ).insert()
    result = get_fulfillment_console(order.name)
    result["reused"] = False
    return result


@frappe.whitelist(methods=["POST"])
def record_fulfillment_action(
    channel_order: str,
    scan_value: str,
    action: str,
    logistics_carrier: str = "",
    tracking_no: str = "",
    activation_ref: str = "",
    customer_ref: str = "",
    source_record_id: str = "",
    remarks: str = "",
) -> dict[str, object]:
    frappe.has_permission("Aishike Device Fulfillment Record", "create", throw=True)
    serial_no = _normalize_existing_device(scan_value)
    frappe.get_doc(
        {
            "doctype": "Aishike Device Fulfillment Record",
            "channel_order": channel_order,
            "device_unit": serial_no,
            "action": action,
            "logistics_carrier": logistics_carrier,
            "tracking_no": tracking_no,
            "activation_ref": activation_ref,
            "customer_ref": customer_ref,
            "source_record_id": source_record_id,
            "remarks": remarks,
        }
    ).insert()
    return get_fulfillment_console(channel_order)


def _resolve_order(search_value: str) -> str:
    value = (search_value or "").strip()
    if not value:
        frappe.throw("请输入内部订单号、渠道订单号或设备 SN")
    if frappe.db.exists("Aishike Channel Order", value):
        return value
    if frappe.db.exists("Aishike Device Unit", value):
        order_name = frappe.db.get_value(
            "Aishike Device Unit", value, "channel_order_id"
        )
        if not order_name:
            frappe.throw("该设备尚未分配渠道订单")
        return order_name
    matches = frappe.get_all(
        "Aishike Channel Order",
        filters={"external_order_id": value.upper()},
        pluck="name",
        limit_page_length=3,
    )
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        frappe.throw("该渠道订单号在多个渠道范围中存在，请使用内部订单号查询")
    frappe.throw(_("未找到渠道订单: {0}").format(value))


def _normalize_existing_device(scan_value: str) -> str:
    try:
        serial_no = normalize_scan_value(scan_value)
    except SerialRuleError as error:
        frappe.throw(str(error))
    if not frappe.db.exists("Aishike Device Unit", serial_no):
        frappe.throw(_("未找到设备 SN: {0}").format(serial_no))
    return serial_no
