from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import now_datetime

from aishike_erp.manufacturing import TEST_LABELS, TEST_TYPES, summarize_test_records
from aishike_erp.serials import SerialRuleError, normalize_scan_value


DEFAULT_TEST_TEMPLATE = "M2.2-V1"


@frappe.whitelist()
def get_production_console(scan_value: str) -> dict[str, object]:
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
            "work_order",
            "firmware_version",
            "agent_version",
            "last_event_at",
        ],
        as_dict=True,
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
            "package_checksum",
            "flash_tool_version",
            "workstation",
            "operator",
            "flashed_at",
            "raw_log_ref",
            "failure_reason",
        ],
        order_by="flashed_at desc, creation desc",
        limit_page_length=8,
    )
    flash_count = frappe.db.count("Aishike Firmware Flash Record", {"device_unit": serial_no})
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
        limit_page_length=200,
    )
    summary = summarize_test_records(test_records)
    tests = []
    for test_type in TEST_TYPES:
        tests.append(
            {
                "test_type": test_type,
                "label": TEST_LABELS[test_type],
                "attempts": summary["attempts"][test_type],
                "latest": summary["latest"][test_type],
            }
        )
    return {
        "device": {**device, "serial_no": device.name},
        "flash_records": flash_records,
        "flash_count": flash_count,
        "latest_flash": flash_records[0] if flash_records else None,
        "tests": tests,
        "summary": {
            "passed": summary["passed"],
            "failed": summary["failed"],
            "pending": summary["pending"],
            "complete": summary["complete"],
            "total": len(TEST_TYPES),
        },
        "default_test_template": DEFAULT_TEST_TEMPLATE,
    }


@frappe.whitelist(methods=["POST"])
def record_flash(
    scan_value: str,
    result: str,
    firmware_version: str,
    agent_version: str,
    package_checksum: str = "",
    flash_tool_version: str = "",
    workstation: str = "",
    raw_log_ref: str = "",
    failure_reason: str = "",
) -> dict[str, object]:
    frappe.has_permission("Aishike Firmware Flash Record", "create", throw=True)
    serial_no = _normalize_existing_device(scan_value)
    frappe.get_doc(
        {
            "doctype": "Aishike Firmware Flash Record",
            "device_unit": serial_no,
            "result": (result or "").upper(),
            "firmware_version": (firmware_version or "").strip(),
            "agent_version": (agent_version or "").strip(),
            "package_checksum": (package_checksum or "").strip(),
            "flash_tool_version": (flash_tool_version or "").strip(),
            "workstation": workstation or None,
            "operator": frappe.session.user,
            "flashed_at": now_datetime(),
            "raw_log_ref": (raw_log_ref or "").strip(),
            "failure_reason": (failure_reason or "").strip(),
        }
    ).insert()
    return get_production_console(serial_no)


@frappe.whitelist(methods=["POST"])
def record_test(
    scan_value: str,
    test_type: str,
    result: str,
    test_template_version: str = DEFAULT_TEST_TEMPLATE,
    workstation: str = "",
    raw_data_ref: str = "",
    result_summary: str = "",
    measurement_json: str = "",
    failure_reason: str = "",
) -> dict[str, object]:
    frappe.has_permission("Aishike Device Test Record", "create", throw=True)
    serial_no = _normalize_existing_device(scan_value)
    frappe.get_doc(
        {
            "doctype": "Aishike Device Test Record",
            "device_unit": serial_no,
            "test_type": (test_type or "").upper(),
            "result": (result or "").upper(),
            "test_template_version": (test_template_version or DEFAULT_TEST_TEMPLATE).strip(),
            "tested_at": now_datetime(),
            "workstation": workstation or None,
            "operator": frappe.session.user,
            "raw_data_ref": (raw_data_ref or "").strip(),
            "result_summary": (result_summary or "").strip(),
            "measurement_json": (measurement_json or "").strip(),
            "failure_reason": (failure_reason or "").strip(),
        }
    ).insert()
    return get_production_console(serial_no)


def _normalize_existing_device(scan_value: str) -> str:
    try:
        serial_no = normalize_scan_value(scan_value)
    except SerialRuleError as error:
        frappe.throw(str(error))
    if not frappe.db.exists("Aishike Device Unit", serial_no):
        frappe.throw(_("未找到设备 SN: {0}").format(serial_no))
    return serial_no
