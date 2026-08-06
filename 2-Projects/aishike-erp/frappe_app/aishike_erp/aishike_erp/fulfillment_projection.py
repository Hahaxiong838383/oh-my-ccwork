from __future__ import annotations

import frappe

from aishike_erp.fulfillment_rules import derive_order_status


def get_order_projection(order_name: str) -> dict[str, int | str]:
    order_quantity = int(
        frappe.db.get_value("Aishike Channel Order", order_name, "order_quantity") or 0
    )
    allocated_count = frappe.db.count(
        "Aishike Device Fulfillment Record",
        {"channel_order": order_name, "action": "ALLOCATE"},
    )
    shipped_count = frappe.db.count(
        "Aishike Device Fulfillment Record",
        {"channel_order": order_name, "action": "SHIP"},
    )
    activated_count = frappe.db.count(
        "Aishike Device Fulfillment Record",
        {"channel_order": order_name, "action": "ACTIVATE"},
    )
    return {
        "order_status": derive_order_status(
            order_quantity=order_quantity,
            allocated_count=allocated_count,
            shipped_count=shipped_count,
            activated_count=activated_count,
        ),
        "allocated_count": allocated_count,
        "shipped_count": shipped_count,
        "activated_count": activated_count,
    }


def refresh_order_projection(order_name: str) -> dict[str, int | str]:
    projection = get_order_projection(order_name)
    order = frappe.get_doc("Aishike Channel Order", order_name)
    for fieldname, value in projection.items():
        order.set(fieldname, value)
    order.flags.fulfillment_projection_update = True
    order.save(ignore_permissions=True)
    return projection
