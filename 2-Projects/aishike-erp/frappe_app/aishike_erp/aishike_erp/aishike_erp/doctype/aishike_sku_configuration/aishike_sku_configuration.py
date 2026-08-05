from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from aishike_erp.rules import RuleViolation, changed_locked_fields, validate_sku_status_transition


LOCKED_FIELDS = (
    "item_template",
    "item_code",
    "color",
    "hardware_configuration",
    "sales_region",
    "bom",
    "product_bundle",
)


class AishikeSKUConfiguration(Document):
    def validate(self) -> None:
        previous = self.get_doc_before_save()
        previous_status = previous.status if previous else None
        try:
            validate_sku_status_transition(previous_status, self.status)
        except RuleViolation as error:
            frappe.throw(str(error))

        if previous and previous.status in {"Approved", "Disabled"}:
            changed = changed_locked_fields(previous.as_dict(), self.as_dict(), LOCKED_FIELDS)
            if changed:
                frappe.throw(f"SKU批准后不可修改关键字段: {', '.join(changed)}")

        if self.status == "Approved":
            self._validate_approval()
            if not self.approved_by:
                self.approved_by = frappe.session.user
                self.approved_on = now_datetime()

        if self.status == "Disabled" and not self.disabled_reason:
            frappe.throw("停用SKU必须填写停用原因")

        self._validate_unique_combination()

    def on_trash(self) -> None:
        if self.status != "Draft":
            frappe.throw("只有草稿SKU可以删除；已批准SKU应使用停用状态")

    def _validate_approval(self) -> None:
        missing = [field for field in ("item_template", "item_code", "bom") if not self.get(field)]
        if missing:
            frappe.throw(f"SKU批准前必须补齐字段: {', '.join(missing)}")

    def _validate_unique_combination(self) -> None:
        duplicate = frappe.db.exists(
            "Aishike SKU Configuration",
            {
                "item_template": self.item_template,
                "color": self.color,
                "hardware_configuration": self.hardware_configuration,
                "sales_region": self.sales_region,
                "name": ["!=", self.name or ""],
            },
        )
        if duplicate:
            frappe.throw(f"相同属性组合已存在: {duplicate}")
