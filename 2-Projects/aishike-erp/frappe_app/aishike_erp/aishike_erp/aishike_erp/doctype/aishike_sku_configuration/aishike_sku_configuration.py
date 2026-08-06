from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from aishike_erp.rules import (
    RuleViolation,
    build_sku_code,
    changed_locked_fields,
    validate_sku_status_transition,
)


LOCKED_FIELDS = (
    "item_template",
    "item_code",
    "product_name",
    "erp_item_code",
    "erp_item_code_status",
    "channel_spec_name",
    "short_spec_name",
    "product_line_code",
    "model_code",
    "screen_code",
    "bundle_code",
    "version_code",
    "color",
    "hardware_configuration",
    "sales_region",
    "bom",
    "product_bundle",
)


class AishikeSKUConfiguration(Document):
    def validate(self) -> None:
        self._apply_structured_sku_code()
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
        structured_fields = (
            "product_line_code",
            "model_code",
            "screen_code",
            "bundle_code",
            "version_code",
        )
        if any(self.get(field) for field in structured_fields):
            missing = [field for field in structured_fields if not self.get(field)]
            if missing:
                frappe.throw(f"结构化SKU编码字段不完整: {', '.join(missing)}")
            duplicate = frappe.db.exists(
                "Aishike SKU Configuration",
                {
                    **{field: self.get(field) for field in structured_fields},
                    "name": ["!=", self.name or ""],
                },
            )
            if duplicate:
                frappe.throw(f"相同结构化SKU已存在: {duplicate}")
            return

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

    def _apply_structured_sku_code(self) -> None:
        fields = (
            "product_line_code",
            "model_code",
            "screen_code",
            "bundle_code",
            "version_code",
        )
        if not any(self.get(field) for field in fields):
            return
        missing = [field for field in fields if not self.get(field)]
        if missing:
            frappe.throw(f"结构化SKU编码字段不完整: {', '.join(missing)}")
        try:
            expected = build_sku_code(*(self.get(field) for field in fields))
        except RuleViolation as error:
            frappe.throw(str(error))
        if self.item_code and self.item_code != expected:
            frappe.throw(f"SKU编码必须遵循命名规则，预期值: {expected}")
        self.item_code = expected

        required = ("product_name", "channel_spec_name", "short_spec_name")
        missing = [field for field in required if not self.get(field)]
        if missing:
            frappe.throw(f"Sheet1 SKU必须补齐字段: {', '.join(missing)}")

        if self.erp_item_code_status == "CONFIRMED":
            erp_item_code = (self.erp_item_code or "").strip()
            if len(erp_item_code) != 14 or not erp_item_code.startswith("FQT"):
                frappe.throw("已确认ERP料号必须使用 FQT000000AV000 格式")
