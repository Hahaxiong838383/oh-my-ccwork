from __future__ import annotations

import frappe

from aishike_erp.ontology_read_contract import map_device, map_fulfillment, map_order, map_quality, paginate


ONTOLOGY_READER_ROLE = "Aishike Ontology Reader"


def ensure_ontology_reader_role() -> None:
    if not frappe.db.exists("Role", ONTOLOGY_READER_ROLE):
        frappe.get_doc({"doctype": "Role", "role_name": ONTOLOGY_READER_ROLE, "desk_access": 0}).insert(ignore_permissions=True)


def _require_reader() -> None:
    if ONTOLOGY_READER_ROLE not in set(frappe.get_roles()):
        frappe.throw("仅公司 Ontology 只读服务账号可访问。", frappe.PermissionError)


def _rows(doctype: str, fields: list[str], floor: str | None, limit: int) -> list[dict[str, object]]:
    filters = {"modified": [">=", floor]} if floor else None
    return frappe.get_all(doctype, filters=filters, fields=["name", "modified", *fields], order_by="modified asc, name asc", limit_page_length=max(500, limit * 6))


@frappe.whitelist(methods=["GET"])
def export_m3_read_model(cursor: str = "", limit: int = 100) -> dict[str, object]:
    _require_reader()
    normalized_limit = max(1, min(200, int(limit or 100)))
    floor = None
    if cursor:
        from aishike_erp.ontology_read_contract import decode_cursor

        sort_key = decode_cursor(cursor)
        floor = sort_key.split("|", 1)[0] if sort_key else None

    items: list[dict[str, object]] = []
    for row in _rows("Aishike Channel Order", ["channel", "sku_configuration", "order_quantity", "order_status", "allocated_count", "shipped_count", "activated_count"], floor, normalized_limit):
        items.extend(map_order(row))
    for row in _rows("Aishike Device Unit", ["sku_configuration", "lifecycle_state", "current_warehouse", "channel_order_id"], floor, normalized_limit):
        items.extend(map_device(row))
    for row in _rows("Aishike Quality Release Record", ["device_unit", "decision", "attempt_no", "checklist_version", "released_at"], floor, normalized_limit):
        items.extend(map_quality(row))
    for row in _rows("Aishike Device Fulfillment Record", ["channel_order", "device_unit", "action", "action_at", "source_system", "logistics_carrier"], floor, normalized_limit):
        items.extend(map_fulfillment(row))
    return paginate(items, cursor, normalized_limit)
