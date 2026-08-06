from __future__ import annotations

import frappe

from aishike_erp.sku_catalog import sheet1_skus


def ensure_sheet1_skus() -> dict[str, object]:
    created_items = []
    created_skus = []
    reused_skus = []

    for row in sheet1_skus():
        item_template = _ensure_item(row, created_items)
        sku_code = str(row["item_code"])
        if frappe.db.exists("Aishike SKU Configuration", sku_code):
            reused_skus.append(sku_code)
            continue

        frappe.get_doc(
            {
                "doctype": "Aishike SKU Configuration",
                "item_template": item_template,
                "item_code": sku_code,
                "status": "Draft",
                "product_name": row["product_name"],
                "erp_item_code": row["erp_item_code"],
                "erp_item_code_status": row["erp_item_code_status"],
                "channel_spec_name": row["channel_spec_name"],
                "short_spec_name": row["short_spec_name"],
                "product_line_code": row["product_line_code"],
                "model_code": row["model_code"],
                "screen_code": row["screen_code"],
                "bundle_code": row["bundle_code"],
                "version_code": row["version_code"],
                "sales_region": "CN",
                "channel_ready": 0,
                "source_reference": row["source_reference"],
                "source_row": row["source_row"],
            }
        ).insert(ignore_permissions=True)
        created_skus.append(sku_code)

    frappe.db.commit()
    return {
        "source": "Feishu Sheet1",
        "total": len(sheet1_skus()),
        "created_items": created_items,
        "created_skus": created_skus,
        "reused_skus": reused_skus,
    }


def _ensure_item(row: dict[str, object], created_items: list[str]) -> str:
    erp_item_code = str(row["erp_item_code"])
    item_code = (
        erp_item_code
        if row["erp_item_code_status"] == "CONFIRMED"
        else str(row["item_code"])
    )
    if frappe.db.exists("Item", item_code):
        return item_code

    frappe.get_doc(
        {
            "doctype": "Item",
            "item_code": item_code,
            "item_name": row["channel_spec_name"],
            "description": row["short_spec_name"],
            "item_group": "Products",
            "stock_uom": "Nos",
            "is_stock_item": 0 if row["product_line_code"] == "T&S" else 1,
            "disabled": 0,
        }
    ).insert(ignore_permissions=True)
    created_items.append(item_code)
    return item_code
