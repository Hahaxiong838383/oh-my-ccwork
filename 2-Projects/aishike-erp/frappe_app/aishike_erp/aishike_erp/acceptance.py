from __future__ import annotations

import frappe

from aishike_erp.localization import apply_chinese_defaults


EXPECTED_DOCTYPES = (
    "Aishike SKU Configuration",
    "Aishike Device Unit",
    "Aishike Device Test Record",
    "Aishike Device Lifecycle Event",
    "Aishike Firmware Flash Record",
    "Aishike Serial Number Rule",
    "Aishike Serial Number Batch",
)

ACCEPTANCE_FINISHED_ITEM = "ASK-RW-DESK-STAR-WHITE-STD"
ACCEPTANCE_COMPONENT_ITEM = "ASK-COMPONENT-MAINBOARD"


def runtime_check() -> dict[str, object]:
    installed_apps = frappe.get_installed_apps()
    missing_doctypes = [
        doctype for doctype in EXPECTED_DOCTYPES if not frappe.db.exists("DocType", doctype)
    ]
    expected_pages = ("aishike-sn-console", "aishike-production-console")
    missing_pages = [page for page in expected_pages if not frappe.db.exists("Page", page)]
    return {
        "status": "ok" if not missing_doctypes and not missing_pages else "incomplete",
        "app_installed": "aishike_erp" in installed_apps,
        "expected_doctypes": list(EXPECTED_DOCTYPES),
        "missing_doctypes": missing_doctypes,
        "missing_pages": missing_pages,
        "sn_console_available": bool(frappe.db.exists("Page", "aishike-sn-console")),
        "production_console_available": bool(
            frappe.db.exists("Page", "aishike-production-console")
        ),
    }


def seed_acceptance_fixture() -> dict[str, str]:
    _ensure_item(ACCEPTANCE_FINISHED_ITEM, "爱视可读写台 星光白 标准版", "Products")
    _ensure_item(ACCEPTANCE_COMPONENT_ITEM, "爱视可主板组件", "Raw Material")

    bom_name = frappe.db.get_value(
        "BOM",
        {"item": ACCEPTANCE_FINISHED_ITEM, "docstatus": 1, "is_active": 1},
        "name",
    )
    if not bom_name:
        bom = frappe.get_doc(
            {
                "doctype": "BOM",
                "item": ACCEPTANCE_FINISHED_ITEM,
                "quantity": 1,
                "is_active": 1,
                "is_default": 1,
                "items": [
                    {
                        "item_code": ACCEPTANCE_COMPONENT_ITEM,
                        "qty": 1,
                        "rate": 100,
                        "uom": "Nos",
                        "conversion_factor": 1,
                    }
                ],
            }
        )
        bom.insert(ignore_permissions=True)
        bom.submit()
        bom_name = bom.name

    sku_name = frappe.db.get_value(
        "Aishike SKU Configuration",
        {"item_code": ACCEPTANCE_FINISHED_ITEM},
        "name",
    )
    if not sku_name:
        sku = frappe.get_doc(
            {
                "doctype": "Aishike SKU Configuration",
                "item_template": ACCEPTANCE_FINISHED_ITEM,
                "item_code": ACCEPTANCE_FINISHED_ITEM,
                "status": "Draft",
                "color": "STAR_WHITE",
                "hardware_configuration": "STANDARD",
                "sales_region": "CN",
                "bom": bom_name,
            }
        )
        sku.insert(ignore_permissions=True)
        sku_name = sku.name

    frappe.db.commit()
    return {"item": ACCEPTANCE_FINISHED_ITEM, "bom": bom_name, "sku": sku_name}


def enable_chinese_ui() -> dict[str, str]:
    return apply_chinese_defaults()


def reset_m2_acceptance_fixture() -> dict[str, int]:
    serials = frappe.get_all(
        "Aishike Device Unit",
        filters={"production_batch": "M2-ACCEPT-001"},
        pluck="name",
    )
    batches = frappe.get_all(
        "Aishike Serial Number Batch",
        filters={"production_batch": "M2-ACCEPT-001"},
        pluck="name",
    )
    if serials:
        frappe.db.delete("Aishike Device Lifecycle Event", {"device_unit": ["in", serials]})
        frappe.db.delete("Aishike Firmware Flash Record", {"device_unit": ["in", serials]})
        frappe.db.delete("Aishike Device Test Record", {"device_unit": ["in", serials]})
        frappe.db.delete("Aishike Device Unit", {"name": ["in", serials]})
    if batches:
        frappe.db.delete("Aishike Serial Number Batch", {"name": ["in", batches]})
    frappe.db.set_value(
        "Aishike Serial Number Rule",
        "ASK-DEFAULT",
        {"pattern": "{PREFIX}-{SEQ}", "current_scope_key": "GLOBAL", "next_sequence": 1},
    )
    frappe.db.commit()
    return {"devices": len(serials), "batches": len(batches)}


def _ensure_item(item_code: str, item_name: str, item_group: str) -> None:
    if frappe.db.exists("Item", item_code):
        return

    frappe.get_doc(
        {
            "doctype": "Item",
            "item_code": item_code,
            "item_name": item_name,
            "item_group": item_group,
            "stock_uom": "Nos",
            "is_stock_item": 1,
        }
    ).insert(ignore_permissions=True)
