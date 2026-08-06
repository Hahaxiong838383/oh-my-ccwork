from __future__ import annotations

import re


CHANNELS = {"TMALL", "JD", "DEALER"}
MAPPING_STATUSES = {"ACTIVE", "DISABLED"}
FULFILLMENT_ACTIONS = {"ALLOCATE", "SHIP", "ACTIVATE"}
ORDER_STATUSES = {
    "OPEN",
    "PARTIALLY_ALLOCATED",
    "ALLOCATED",
    "PARTIALLY_SHIPPED",
    "SHIPPED",
    "PARTIALLY_ACTIVATED",
    "ACTIVATED",
}


class FulfillmentRuleError(ValueError):
    pass


def build_mapping_key(channel: str, channel_scope: str, external_sku: str) -> str:
    return "|".join(
        (
            _normalized_required(channel, "销售渠道").upper(),
            _normalized_required(channel_scope, "渠道范围").upper(),
            _normalized_required(external_sku, "渠道 SKU").upper(),
        )
    )


def build_order_key(channel: str, channel_scope: str, external_order_id: str) -> str:
    return "|".join(
        (
            _normalized_required(channel, "销售渠道").upper(),
            _normalized_required(channel_scope, "渠道范围").upper(),
            _normalized_required(external_order_id, "渠道订单号").upper(),
        )
    )


def validate_channel_mapping(
    *,
    channel: str,
    channel_scope: str,
    external_sku: str,
    sku_status: str,
    mapping_status: str,
) -> None:
    if channel not in CHANNELS:
        raise FulfillmentRuleError(f"不支持的销售渠道: {channel}")
    _normalized_required(channel_scope, "渠道范围")
    _normalized_required(external_sku, "渠道 SKU")
    if sku_status != "Approved":
        raise FulfillmentRuleError("渠道 SKU 只能映射到已批准的内部 SKU")
    if mapping_status not in MAPPING_STATUSES:
        raise FulfillmentRuleError(f"不支持的映射状态: {mapping_status}")


def validate_channel_order(
    *,
    channel: str,
    channel_scope: str,
    external_order_id: str,
    mapping_status: str,
    order_quantity: int,
    recipient_ref: str = "",
    raw_payload_ref: str = "",
    require_active_mapping: bool = True,
) -> None:
    if channel not in CHANNELS:
        raise FulfillmentRuleError(f"不支持的销售渠道: {channel}")
    _normalized_required(channel_scope, "渠道范围")
    _normalized_required(external_order_id, "渠道订单号")
    if require_active_mapping and mapping_status != "ACTIVE":
        raise FulfillmentRuleError("渠道订单必须使用启用中的 SKU 映射")
    if order_quantity < 1 or order_quantity > 200:
        raise FulfillmentRuleError("订单数量必须在 1 到 200 之间")
    validate_deidentified_reference(recipient_ref, "脱敏收货对象引用", required=False)
    validate_deidentified_reference(raw_payload_ref, "脱敏原始报文引用", required=False)


def derive_order_status(
    *, order_quantity: int, allocated_count: int, shipped_count: int, activated_count: int
) -> str:
    if order_quantity < 1:
        raise FulfillmentRuleError("订单数量必须大于 0")
    counts = (allocated_count, shipped_count, activated_count)
    if any(count < 0 for count in counts):
        raise FulfillmentRuleError("履约数量不能为负数")
    if not activated_count <= shipped_count <= allocated_count <= order_quantity:
        raise FulfillmentRuleError("履约数量必须满足 激活 ≤ 发货 ≤ 分配 ≤ 订单数量")

    if activated_count == order_quantity:
        return "ACTIVATED"
    if activated_count:
        return "PARTIALLY_ACTIVATED"
    if shipped_count == order_quantity:
        return "SHIPPED"
    if shipped_count:
        return "PARTIALLY_SHIPPED"
    if allocated_count == order_quantity:
        return "ALLOCATED"
    if allocated_count:
        return "PARTIALLY_ALLOCATED"
    return "OPEN"


def validate_fulfillment_action(
    *,
    action: str,
    device_state: str,
    device_sku: str,
    order_sku: str,
    device_order_id: str = "",
    order_name: str,
    current_warehouse: str = "",
    allocated_count: int = 0,
    order_quantity: int = 1,
    logistics_carrier: str = "",
    tracking_no: str = "",
    activation_ref: str = "",
) -> None:
    if action not in FULFILLMENT_ACTIONS:
        raise FulfillmentRuleError(f"不支持的履约动作: {action}")

    if action == "ALLOCATE":
        if device_state != "STOCKED":
            raise FulfillmentRuleError("只有在库设备可以分配给渠道订单")
        if device_sku != order_sku:
            raise FulfillmentRuleError("订单 SKU 与设备 SKU 不一致")
        if not current_warehouse:
            raise FulfillmentRuleError("在库设备缺少当前仓库，不能分配")
        if allocated_count >= order_quantity:
            raise FulfillmentRuleError("订单已达到设备分配数量")
        return

    if device_order_id != order_name:
        raise FulfillmentRuleError("设备绑定的渠道订单与当前订单不一致")

    if action == "SHIP":
        if device_state != "ALLOCATED":
            raise FulfillmentRuleError("设备必须先完成订单分配才能发货")
        if not current_warehouse:
            raise FulfillmentRuleError("待发货设备缺少出库仓库")
        _normalized_required(logistics_carrier, "物流承运商")
        _normalized_required(tracking_no, "物流单号")
        return

    if device_state != "SHIPPED":
        raise FulfillmentRuleError("设备必须完成发货后才能激活")
    validate_deidentified_reference(activation_ref, "脱敏激活引用", required=True)


def validate_deidentified_reference(value: str, label: str, *, required: bool) -> None:
    normalized = (value or "").strip()
    if required and not normalized:
        raise FulfillmentRuleError(f"{label}不能为空")
    if not normalized:
        return
    if len(normalized) > 140:
        raise FulfillmentRuleError(f"{label}不能超过 140 个字符")
    if "@" in normalized or re.search(r"(?<!\d)1[3-9]\d{9}(?!\d)", normalized):
        raise FulfillmentRuleError(f"{label}不能包含邮箱或手机号码等直接个人信息")


def _normalized_required(value: str, label: str) -> str:
    normalized = (value or "").strip()
    if not normalized:
        raise FulfillmentRuleError(f"{label}不能为空")
    return normalized
