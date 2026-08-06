from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from aishike_erp.fulfillment_rules import (
    FulfillmentRuleError,
    build_order_key,
    validate_channel_order,
)
from aishike_erp.rules import changed_locked_fields


BUSINESS_FIELDS = (
    "channel",
    "channel_scope",
    "external_order_id",
    "channel_sku_mapping",
    "external_sku",
    "sku_configuration",
    "order_quantity",
    "recipient_ref",
    "internal_sales_order",
    "raw_payload_ref",
)
PROJECTION_FIELDS = (
    "order_status",
    "allocated_count",
    "shipped_count",
    "activated_count",
)


class AishikeChannelOrder(Document):
    def before_insert(self) -> None:
        self._normalize_identity()
        self.order_status = "OPEN"
        self.allocated_count = 0
        self.shipped_count = 0
        self.activated_count = 0
        self.imported_at = now_datetime()
        self.imported_by = frappe.session.user

    def validate(self) -> None:
        self._normalize_identity()
        previous = self.get_doc_before_save()
        mapping = frappe.db.get_value(
            "Aishike Channel SKU Mapping",
            self.channel_sku_mapping,
            [
                "channel",
                "channel_scope",
                "external_sku",
                "sku_configuration",
                "status",
            ],
            as_dict=True,
        )
        if not mapping:
            frappe.throw("渠道 SKU 映射不存在")
        if (
            mapping.channel != self.channel
            or mapping.channel_scope != self.channel_scope
        ):
            frappe.throw("订单渠道与 SKU 映射不一致")
        self.external_sku = mapping.external_sku
        self.sku_configuration = mapping.sku_configuration
        try:
            validate_channel_order(
                channel=self.channel,
                channel_scope=self.channel_scope,
                external_order_id=self.external_order_id,
                mapping_status=mapping.status,
                order_quantity=int(self.order_quantity or 0),
                recipient_ref=self.recipient_ref or "",
                raw_payload_ref=self.raw_payload_ref or "",
                require_active_mapping=not bool(previous),
            )
        except FulfillmentRuleError as error:
            frappe.throw(str(error))

        if not previous:
            return
        if frappe.db.exists(
            "Aishike Device Fulfillment Record", {"channel_order": self.name}
        ):
            changed = changed_locked_fields(
                previous.as_dict(), self.as_dict(), BUSINESS_FIELDS
            )
            if changed:
                frappe.throw(f"订单开始履约后不可修改业务字段: {', '.join(changed)}")
        projection_changes = changed_locked_fields(
            previous.as_dict(), self.as_dict(), PROJECTION_FIELDS
        )
        if projection_changes and not self.flags.get("fulfillment_projection_update"):
            frappe.throw("订单履约进度只能由设备履约凭证派生")

    def on_trash(self) -> None:
        frappe.throw("渠道订单不可删除；请保留订单和设备履约历史")

    def _normalize_identity(self) -> None:
        self.channel = (self.channel or "").strip().upper()
        self.channel_scope = (self.channel_scope or "").strip().upper()
        self.external_order_id = (self.external_order_id or "").strip().upper()
        self.recipient_ref = (self.recipient_ref or "").strip()
        self.raw_payload_ref = (self.raw_payload_ref or "").strip()
        self.external_order_key = build_order_key(
            self.channel, self.channel_scope, self.external_order_id
        )
