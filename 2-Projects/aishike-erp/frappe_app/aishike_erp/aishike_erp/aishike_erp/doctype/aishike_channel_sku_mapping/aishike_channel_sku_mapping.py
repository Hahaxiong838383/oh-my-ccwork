from __future__ import annotations

import frappe
from frappe.model.document import Document

from aishike_erp.fulfillment_rules import (
    FulfillmentRuleError,
    build_mapping_key,
    validate_channel_mapping,
)
from aishike_erp.rules import changed_locked_fields


KEY_FIELDS = ("channel", "channel_scope", "external_sku", "sku_configuration")


class AishikeChannelSKUMapping(Document):
    def before_insert(self) -> None:
        self._normalize()

    def validate(self) -> None:
        self._normalize()
        sku_status = frappe.db.get_value(
            "Aishike SKU Configuration", self.sku_configuration, "status"
        )
        try:
            validate_channel_mapping(
                channel=self.channel,
                channel_scope=self.channel_scope,
                external_sku=self.external_sku,
                sku_status=sku_status or "",
                mapping_status=self.status,
            )
        except FulfillmentRuleError as error:
            frappe.throw(str(error))

        previous = self.get_doc_before_save()
        if not previous:
            return
        changed = changed_locked_fields(previous.as_dict(), self.as_dict(), KEY_FIELDS)
        if changed:
            frappe.throw(f"渠道 SKU 映射身份字段不可修改: {', '.join(changed)}")
        if previous.status == "DISABLED" and self.status != "DISABLED":
            frappe.throw("已停用的渠道 SKU 映射不能重新启用，请新建映射")

    def on_trash(self) -> None:
        frappe.throw("渠道 SKU 映射不可删除；请将状态改为已停用")

    def _normalize(self) -> None:
        self.channel = (self.channel or "").strip().upper()
        self.channel_scope = (self.channel_scope or "").strip().upper()
        self.external_sku = (self.external_sku or "").strip().upper()
        self.status = (self.status or "ACTIVE").strip().upper()
        self.mapping_key = build_mapping_key(
            self.channel, self.channel_scope, self.external_sku
        )
