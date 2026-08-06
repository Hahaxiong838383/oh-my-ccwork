from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import now_datetime

from aishike_erp.manufacturing import TEST_LABELS, TEST_TYPES, summarize_test_records
from aishike_erp.serials import SerialRuleError, normalize_scan_value


DEFAULT_QUALITY_CHECKLIST = "M2.3-V1"


@frappe.whitelist()
def get_quality_console(scan_value: str) -> dict[str, object]:
    frappe.has_permission("Aishike Device Unit", "read", throw=True)
    serial_no = _normalize_existing_device(scan_value)
    device = frappe.db.get_value(
        "Aishike Device Unit",
        serial_no,
        [
            "name",
            "sku_configuration",
            "item_code",
            "lifecycle_state",
            "production_batch",
            "sn_generation_batch",
            "bom",
            "work_order",
            "firmware_version",
            "agent_version",
            "quality_release_record",
            "current_warehouse",
            "latest_stock_movement",
            "current_channel",
            "channel_order_id",
            "activation_ref",
            "last_event_at",
        ],
        as_dict=True,
    )
    sku = frappe.db.get_value(
        "Aishike SKU Configuration",
        device.sku_configuration,
        [
            "name",
            "status",
            "color",
            "hardware_configuration",
            "sales_region",
            "product_bundle",
        ],
        as_dict=True,
    )
    generation_batch = (
        frappe.db.get_value(
            "Aishike Serial Number Batch",
            device.sn_generation_batch,
            [
                "name",
                "serial_rule",
                "generation_date",
                "production_batch",
                "sequence_start",
                "sequence_end",
                "generated_by",
                "generated_at",
            ],
            as_dict=True,
        )
        if device.sn_generation_batch
        else None
    )
    flash_records = frappe.get_all(
        "Aishike Firmware Flash Record",
        filters={"device_unit": serial_no},
        fields=[
            "name",
            "result",
            "attempt_no",
            "firmware_version",
            "agent_version",
            "workstation",
            "operator",
            "flashed_at",
            "failure_reason",
        ],
        order_by="flashed_at desc, creation desc",
        limit_page_length=200,
    )
    test_records = frappe.get_all(
        "Aishike Device Test Record",
        filters={"device_unit": serial_no},
        fields=[
            "name",
            "test_type",
            "result",
            "attempt_no",
            "test_template_version",
            "workstation",
            "operator",
            "tested_at",
            "raw_data_ref",
            "result_summary",
            "measurement_json",
            "failure_reason",
        ],
        order_by="tested_at asc, creation asc",
        limit_page_length=500,
    )
    summary = summarize_test_records(test_records)
    tests = [
        {
            "test_type": test_type,
            "label": TEST_LABELS[test_type],
            "attempts": summary["attempts"][test_type],
            "latest": summary["latest"][test_type],
        }
        for test_type in TEST_TYPES
    ]
    quality_records = frappe.get_all(
        "Aishike Quality Release Record",
        filters={"device_unit": serial_no},
        fields=[
            "name",
            "decision",
            "attempt_no",
            "checklist_version",
            "released_at",
            "inspector",
            "workstation",
            "release_summary",
            "failure_reason",
        ],
        order_by="released_at desc, creation desc",
        limit_page_length=100,
    )
    stock_movements = frappe.get_all(
        "Aishike Device Stock Movement",
        filters={"device_unit": serial_no},
        fields=[
            "name",
            "movement_type",
            "movement_no",
            "from_warehouse",
            "to_warehouse",
            "movement_at",
            "operator",
            "erp_stock_entry",
            "reference_type",
            "reference_id",
            "remarks",
        ],
        order_by="movement_at desc, creation desc",
        limit_page_length=200,
    )
    lifecycle_events = frappe.get_all(
        "Aishike Device Lifecycle Event",
        filters={"device_unit": serial_no},
        fields=[
            "name",
            "event_type",
            "occurred_at",
            "source_system",
            "source_record_id",
            "metadata_json",
        ],
        order_by="occurred_at desc, creation desc",
        limit_page_length=500,
    )
    warehouses = frappe.get_all(
        "Warehouse",
        filters={"is_group": 0, "disabled": 0},
        fields=["name", "warehouse_name", "company"],
        order_by="company asc, warehouse_name asc",
        limit_page_length=500,
    )
    return {
        "device": {**device, "serial_no": device.name},
        "sku": sku,
        "generation_batch": generation_batch,
        "flash_records": flash_records,
        "tests": tests,
        "test_records": test_records,
        "test_summary": {
            "passed": summary["passed"],
            "failed": summary["failed"],
            "pending": summary["pending"],
            "complete": summary["complete"],
            "total": len(TEST_TYPES),
        },
        "quality_records": quality_records,
        "stock_movements": stock_movements,
        "lifecycle_events": lifecycle_events,
        "warehouses": warehouses,
        "permissions": {
            "can_release": (
                device.lifecycle_state == "FLASHED"
                and bool(summary["complete"])
                and frappe.has_permission("Aishike Quality Release Record", "create")
            ),
            "can_receive": (
                device.lifecycle_state == "QC_PASSED"
                and not device.current_warehouse
                and frappe.has_permission("Aishike Device Stock Movement", "create")
            ),
            "can_transfer": (
                device.lifecycle_state == "STOCKED"
                and bool(device.current_warehouse)
                and frappe.has_permission("Aishike Device Stock Movement", "create")
            ),
            "can_create_quality_record": frappe.has_permission(
                "Aishike Quality Release Record", "create"
            ),
            "can_create_stock_movement": frappe.has_permission(
                "Aishike Device Stock Movement", "create"
            ),
        },
        "default_quality_checklist": DEFAULT_QUALITY_CHECKLIST,
    }


@frappe.whitelist(methods=["POST"])
def record_quality_release(
    scan_value: str,
    decision: str,
    checklist_version: str = DEFAULT_QUALITY_CHECKLIST,
    workstation: str = "",
    release_summary: str = "",
    failure_reason: str = "",
) -> dict[str, object]:
    frappe.has_permission("Aishike Quality Release Record", "create", throw=True)
    serial_no = _normalize_existing_device(scan_value)
    frappe.get_doc(
        {
            "doctype": "Aishike Quality Release Record",
            "device_unit": serial_no,
            "decision": (decision or "").upper(),
            "checklist_version": (checklist_version or DEFAULT_QUALITY_CHECKLIST).strip(),
            "released_at": now_datetime(),
            "inspector": frappe.session.user,
            "workstation": workstation or None,
            "release_summary": (release_summary or "").strip(),
            "failure_reason": (failure_reason or "").strip(),
        }
    ).insert()
    return get_quality_console(serial_no)


@frappe.whitelist(methods=["POST"])
def record_stock_movement(
    scan_value: str,
    movement_type: str,
    to_warehouse: str,
    erp_stock_entry: str = "",
    reference_type: str = "",
    reference_id: str = "",
    remarks: str = "",
) -> dict[str, object]:
    frappe.has_permission("Aishike Device Stock Movement", "create", throw=True)
    serial_no = _normalize_existing_device(scan_value)
    normalized_type = (movement_type or "").upper()
    current_warehouse = frappe.db.get_value(
        "Aishike Device Unit", serial_no, "current_warehouse"
    )
    frappe.get_doc(
        {
            "doctype": "Aishike Device Stock Movement",
            "device_unit": serial_no,
            "movement_type": normalized_type,
            "from_warehouse": current_warehouse if normalized_type == "TRANSFER" else None,
            "to_warehouse": to_warehouse,
            "movement_at": now_datetime(),
            "operator": frappe.session.user,
            "erp_stock_entry": erp_stock_entry or None,
            "reference_type": (reference_type or "").strip(),
            "reference_id": (reference_id or "").strip(),
            "remarks": (remarks or "").strip(),
        }
    ).insert()
    return get_quality_console(serial_no)


def _normalize_existing_device(scan_value: str) -> str:
    try:
        serial_no = normalize_scan_value(scan_value)
    except SerialRuleError as error:
        frappe.throw(str(error))
    if not frappe.db.exists("Aishike Device Unit", serial_no):
        frappe.throw(_("未找到设备 SN: {0}").format(serial_no))
    return serial_no
