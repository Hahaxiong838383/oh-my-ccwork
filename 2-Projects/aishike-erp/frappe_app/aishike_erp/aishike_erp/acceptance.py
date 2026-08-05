from __future__ import annotations

import frappe

from aishike_erp.localization import apply_chinese_defaults


EXPECTED_DOCTYPES = (
    "Aishike SKU Configuration",
    "Aishike Device Unit",
    "Aishike Device Test Record",
    "Aishike Device Lifecycle Event",
)

ACCEPTANCE_FINISHED_ITEM = "ASK-RW-DESK-STAR-WHITE-STD"
ACCEPTANCE_COMPONENT_ITEM = "ASK-COMPONENT-MAINBOARD"


def runtime_check() -> dict[str, object]:
    installed_apps = frappe.get_installed_apps()
    missing_doctypes = [
        doctype for doctype in EXPECTED_DOCTYPES if not frappe.db.exists("DocType", doctype)
    ]
    return {
        "status": "ok" if not missing_doctypes else "incomplete",
        "app_installed": "aishike_erp" in installed_apps,
        "expected_doctypes": list(EXPECTED_DOCTYPES),
        "missing_doctypes": missing_doctypes,
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
