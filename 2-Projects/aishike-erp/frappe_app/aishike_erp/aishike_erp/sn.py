from __future__ import annotations

from io import BytesIO

import frappe
from frappe import _
from frappe.utils import cint, getdate, now_datetime
from pyqrcode import create as create_qr

from aishike_erp.serials import (
    SerialRuleError,
    get_scope_key,
    make_qr_payload,
    normalize_scan_value,
    render_serial,
)


DEFAULT_RULE = "ASK-DEFAULT"
MAX_GENERATION_QUANTITY = 200


def ensure_default_rule() -> None:
    if frappe.db.exists("Aishike Serial Number Rule", DEFAULT_RULE):
        return
    frappe.get_doc(
        {
            "doctype": "Aishike Serial Number Rule",
            "rule_code": DEFAULT_RULE,
            "rule_name": "爱视可默认设备 SN 规则",
            "enabled": 1,
            "pattern": "{PREFIX}-{SEQ}",
            "prefix": "ASK",
            "suffix": "",
            "date_format": "YYMMDD",
            "sequence_digits": 6,
            "reset_policy": "NEVER",
            "current_scope_key": "GLOBAL",
            "next_sequence": 1,
            "barcode_format": "CODE128",
            "qr_payload_prefix": "ASK:DEVICE:",
        }
    ).insert(ignore_permissions=True)


@frappe.whitelist()
def get_console_bootstrap() -> dict[str, object]:
    frappe.has_permission("Aishike Device Unit", "read", throw=True)
    rules = frappe.get_all(
        "Aishike Serial Number Rule",
        filters={"enabled": 1},
        fields=[
            "name",
            "rule_name",
            "pattern",
            "date_format",
            "sequence_digits",
            "reset_policy",
            "barcode_format",
            "sample_serial",
        ],
        order_by="modified desc",
    )
    skus = frappe.get_all(
        "Aishike SKU Configuration",
        filters={"status": "Approved"},
        fields=["name", "item_code", "color", "hardware_configuration"],
        order_by="name asc",
    )
    batches = frappe.get_all(
        "Aishike Serial Number Batch",
        fields=[
            "name",
            "serial_rule",
            "sku_configuration",
            "production_batch",
            "generation_date",
            "generated_count",
            "generated_at",
        ],
        order_by="generated_at desc",
        limit_page_length=8,
    )
    return {"rules": rules, "skus": skus, "batches": batches, "max_quantity": MAX_GENERATION_QUANTITY}


@frappe.whitelist()
def preview_serials(
    serial_rule: str,
    sku_configuration: str,
    production_batch: str = "",
    generation_date: str = "",
    quantity: int = 3,
) -> dict[str, object]:
    frappe.has_permission("Aishike Serial Number Rule", "read", throw=True)
    frappe.has_permission("Aishike SKU Configuration", "read", throw=True)
    preview_quantity = _validate_quantity(quantity, maximum=10)
    rule = _get_enabled_rule(serial_rule)
    _validate_approved_sku(sku_configuration)
    selected_date = _validate_generation_date(generation_date)
    scope_key, sequence_start = _get_sequence_start(rule, production_batch, selected_date)
    serials = _render_serial_range(
        rule,
        sku_configuration,
        production_batch,
        sequence_start,
        preview_quantity,
        selected_date,
    )
    return {
        "serials": serials,
        "scope_key": scope_key,
        "sequence_start": sequence_start,
        "barcode_format": rule.barcode_format,
    }


@frappe.whitelist(methods=["POST"])
def generate_serials(
    serial_rule: str,
    sku_configuration: str,
    production_batch: str = "",
    generation_date: str = "",
    quantity: int = 1,
) -> dict[str, object]:
    frappe.has_permission("Aishike Device Unit", "create", throw=True)
    frappe.has_permission("Aishike Serial Number Rule", "write", throw=True)
    requested_quantity = _validate_quantity(quantity, maximum=MAX_GENERATION_QUANTITY)

    locked_rule = frappe.db.sql(
        """
        select name
        from `tabAishike Serial Number Rule`
        where name = %s
        for update
        """,
        serial_rule,
        as_dict=True,
    )
    if not locked_rule:
        frappe.throw(_("SN 规则不存在"))

    rule = _get_enabled_rule(serial_rule)
    _validate_approved_sku(sku_configuration)
    selected_date = _validate_generation_date(generation_date)
    scope_key, sequence_start = _get_sequence_start(rule, production_batch, selected_date)
    serials = _render_serial_range(
        rule,
        sku_configuration,
        production_batch,
        sequence_start,
        requested_quantity,
        selected_date,
    )
    duplicate = frappe.db.get_value("Aishike Device Unit", {"name": ["in", serials]}, "name")
    if duplicate:
        frappe.throw(_("生成范围与现有设备 SN 冲突: {0}").format(duplicate))

    sequence_end = sequence_start + requested_quantity - 1
    generation_batch = frappe.get_doc(
        {
            "doctype": "Aishike Serial Number Batch",
            "serial_rule": rule.name,
            "sku_configuration": sku_configuration,
            "production_batch": production_batch,
            "generation_date": selected_date,
            "status": "GENERATED",
            "requested_quantity": requested_quantity,
            "generated_count": requested_quantity,
            "sequence_start": sequence_start,
            "sequence_end": sequence_end,
            "generated_by": frappe.session.user,
            "generated_at": now_datetime(),
        }
    )
    generation_batch.insert(ignore_permissions=True)

    for serial_no in serials:
        frappe.get_doc(
            {
                "doctype": "Aishike Device Unit",
                "serial_no": serial_no,
                "sku_configuration": sku_configuration,
                "production_batch": production_batch,
                "sn_generation_batch": generation_batch.name,
                "lifecycle_state": "CREATED",
            }
        ).insert()

    rule.current_scope_key = scope_key
    rule.next_sequence = sequence_end + 1
    rule.save(ignore_permissions=True)
    return {
        "batch": generation_batch.name,
        "serials": serials,
        "generated_count": requested_quantity,
        "sequence_start": sequence_start,
        "sequence_end": sequence_end,
        "barcode_format": rule.barcode_format,
    }


@frappe.whitelist()
def lookup_device(scan_value: str) -> dict[str, object]:
    frappe.has_permission("Aishike Device Unit", "read", throw=True)
    try:
        serial_no = normalize_scan_value(scan_value)
    except SerialRuleError as error:
        frappe.throw(str(error))

    if not frappe.db.exists("Aishike Device Unit", serial_no):
        frappe.throw(_("未找到设备 SN: {0}").format(serial_no))

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
            "work_order",
            "last_event_at",
        ],
        as_dict=True,
    )
    generation_batch = frappe.db.get_value(
        "Aishike Serial Number Batch",
        device.sn_generation_batch,
        ["serial_rule", "generation_date"],
        as_dict=True,
    )
    rule_name = generation_batch.serial_rule if generation_batch else ""
    barcode_format = (
        frappe.db.get_value("Aishike Serial Number Rule", rule_name, "barcode_format")
        if rule_name
        else "CODE128"
    )
    return {
        **device,
        "serial_no": device.name,
        "route": f"/desk/aishike-device-unit/{device.name}",
        "barcode_format": barcode_format or "CODE128",
        "qr_payload": make_qr_payload(device.name),
        "generation_date": generation_batch.generation_date if generation_batch else None,
    }


@frappe.whitelist(methods=["POST"])
def mark_assembled(scan_value: str, work_order: str = "") -> dict[str, object]:
    frappe.has_permission("Aishike Device Unit", "write", throw=True)
    try:
        serial_no = normalize_scan_value(scan_value)
    except SerialRuleError as error:
        frappe.throw(str(error))

    device = frappe.get_doc("Aishike Device Unit", serial_no)
    if device.lifecycle_state != "CREATED":
        frappe.throw(_("只有待组装设备可以登记组装完成"))
    if work_order:
        device.work_order = work_order
    device.lifecycle_state = "ASSEMBLED"
    device.save()
    return lookup_device(serial_no)


@frappe.whitelist()
def get_code_assets(scan_value: str) -> dict[str, str]:
    device = lookup_device(scan_value)
    qr_payload = device["qr_payload"]
    qr = create_qr(qr_payload)
    stream = BytesIO()
    try:
        qr.svg(stream, scale=4, background="#ffffff", module_color="#111827")
        qr_svg = stream.getvalue().decode().replace("\n", "")
    finally:
        stream.close()
    return {
        "serial_no": device["serial_no"],
        "qr_payload": qr_payload,
        "qr_svg": qr_svg,
        "barcode_format": device["barcode_format"],
    }


def _validate_quantity(quantity: int, maximum: int) -> int:
    value = cint(quantity)
    if value < 1 or value > maximum:
        frappe.throw(_("生成数量必须在 1 到 {0} 之间").format(maximum))
    return value


def _get_enabled_rule(serial_rule: str):
    if not serial_rule or not frappe.db.exists("Aishike Serial Number Rule", serial_rule):
        frappe.throw(_("SN 规则不存在"))
    rule = frappe.get_doc("Aishike Serial Number Rule", serial_rule)
    if not rule.enabled:
        frappe.throw(_("SN 规则已停用"))
    return rule


def _validate_approved_sku(sku_configuration: str) -> None:
    status = frappe.db.get_value("Aishike SKU Configuration", sku_configuration, "status")
    if status != "Approved":
        frappe.throw(_("只有已批准 SKU 可以批量生成设备"))


def _validate_generation_date(generation_date: str):
    if not generation_date:
        frappe.throw(_("必须选择生产日期"))
    return getdate(generation_date)


def _get_sequence_start(rule, production_batch: str, generation_date) -> tuple[str, int]:
    try:
        scope_key = get_scope_key(rule.reset_policy, generation_date, production_batch)
    except SerialRuleError as error:
        frappe.throw(str(error))
    sequence_start = 1 if rule.current_scope_key != scope_key else int(rule.next_sequence or 1)
    return scope_key, sequence_start


def _render_serial_range(
    rule,
    sku_configuration: str,
    production_batch: str,
    sequence_start: int,
    quantity: int,
    generation_date,
) -> list[str]:
    serials = []
    for offset in range(quantity):
        try:
            serials.append(
                render_serial(
                    pattern=rule.pattern,
                    prefix=rule.prefix,
                    suffix=rule.suffix,
                    date_format=rule.date_format,
                    sku=sku_configuration,
                    batch=production_batch,
                    sequence=sequence_start + offset,
                    sequence_digits=int(rule.sequence_digits),
                    date_value=generation_date,
                )
            )
        except SerialRuleError as error:
            frappe.throw(str(error))
    return serials
