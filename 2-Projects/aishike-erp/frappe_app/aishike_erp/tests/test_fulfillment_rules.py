from __future__ import annotations

import unittest

from aishike_erp.fulfillment_rules import (
    FulfillmentRuleError,
    build_mapping_key,
    build_order_key,
    derive_order_status,
    validate_channel_mapping,
    validate_channel_order,
    validate_deidentified_reference,
    validate_fulfillment_action,
)


class FulfillmentRulesTest(unittest.TestCase):
    def test_mapping_and_order_keys_are_normalized(self) -> None:
        self.assertEqual(
            "TMALL|FLAGSHIP|TM-SKU-001",
            build_mapping_key("tmall", " flagship ", "tm-sku-001"),
        )
        self.assertEqual(
            "JD|SELF|JD-ORDER-001",
            build_order_key("jd", "self", "jd-order-001"),
        )

    def test_mapping_requires_approved_internal_sku(self) -> None:
        with self.assertRaisesRegex(FulfillmentRuleError, "已批准"):
            validate_channel_mapping(
                channel="TMALL",
                channel_scope="FLAGSHIP",
                external_sku="TM-SKU-001",
                sku_status="Draft",
                mapping_status="ACTIVE",
            )

    def test_order_requires_active_mapping(self) -> None:
        with self.assertRaisesRegex(FulfillmentRuleError, "启用"):
            validate_channel_order(
                channel="JD",
                channel_scope="SELF",
                external_order_id="JD-ORDER-001",
                mapping_status="DISABLED",
                order_quantity=1,
            )

    def test_existing_order_can_continue_after_mapping_is_disabled(self) -> None:
        validate_channel_order(
            channel="JD",
            channel_scope="SELF",
            external_order_id="JD-ORDER-001",
            mapping_status="DISABLED",
            order_quantity=1,
            require_active_mapping=False,
        )

    def test_order_quantity_has_business_limit(self) -> None:
        with self.assertRaisesRegex(FulfillmentRuleError, "1 到 200"):
            validate_channel_order(
                channel="DEALER",
                channel_scope="DEALER-001",
                external_order_id="DL-ORDER-001",
                mapping_status="ACTIVE",
                order_quantity=201,
            )

    def test_order_status_derives_partial_and_complete_progress(self) -> None:
        self.assertEqual(
            "PARTIALLY_ALLOCATED",
            derive_order_status(
                order_quantity=2, allocated_count=1, shipped_count=0, activated_count=0
            ),
        )
        self.assertEqual(
            "PARTIALLY_SHIPPED",
            derive_order_status(
                order_quantity=2, allocated_count=2, shipped_count=1, activated_count=0
            ),
        )
        self.assertEqual(
            "ACTIVATED",
            derive_order_status(
                order_quantity=2, allocated_count=2, shipped_count=2, activated_count=2
            ),
        )

    def test_order_status_rejects_impossible_counts(self) -> None:
        with self.assertRaisesRegex(FulfillmentRuleError, "激活 ≤ 发货"):
            derive_order_status(
                order_quantity=2, allocated_count=1, shipped_count=2, activated_count=0
            )

    def test_allocate_requires_stocked_matching_device(self) -> None:
        validate_fulfillment_action(
            action="ALLOCATE",
            device_state="STOCKED",
            device_sku="SKU-001",
            order_sku="SKU-001",
            order_name="ORDER-001",
            current_warehouse="Finished Goods - ASK",
            allocated_count=0,
            order_quantity=1,
        )
        with self.assertRaisesRegex(FulfillmentRuleError, "SKU 不一致"):
            validate_fulfillment_action(
                action="ALLOCATE",
                device_state="STOCKED",
                device_sku="SKU-002",
                order_sku="SKU-001",
                order_name="ORDER-001",
                current_warehouse="Finished Goods - ASK",
            )

    def test_allocate_rejects_full_order(self) -> None:
        with self.assertRaisesRegex(FulfillmentRuleError, "达到"):
            validate_fulfillment_action(
                action="ALLOCATE",
                device_state="STOCKED",
                device_sku="SKU-001",
                order_sku="SKU-001",
                order_name="ORDER-001",
                current_warehouse="Finished Goods - ASK",
                allocated_count=1,
                order_quantity=1,
            )

    def test_ship_requires_order_binding_and_logistics(self) -> None:
        with self.assertRaisesRegex(FulfillmentRuleError, "当前订单不一致"):
            validate_fulfillment_action(
                action="SHIP",
                device_state="ALLOCATED",
                device_sku="SKU-001",
                order_sku="SKU-001",
                device_order_id="ORDER-002",
                order_name="ORDER-001",
                current_warehouse="Finished Goods - ASK",
                logistics_carrier="顺丰",
                tracking_no="SF001",
            )
        with self.assertRaisesRegex(FulfillmentRuleError, "物流单号"):
            validate_fulfillment_action(
                action="SHIP",
                device_state="ALLOCATED",
                device_sku="SKU-001",
                order_sku="SKU-001",
                device_order_id="ORDER-001",
                order_name="ORDER-001",
                current_warehouse="Finished Goods - ASK",
                logistics_carrier="顺丰",
            )

    def test_activation_requires_shipped_device_and_masked_reference(self) -> None:
        with self.assertRaisesRegex(FulfillmentRuleError, "完成发货"):
            validate_fulfillment_action(
                action="ACTIVATE",
                device_state="ALLOCATED",
                device_sku="SKU-001",
                order_sku="SKU-001",
                device_order_id="ORDER-001",
                order_name="ORDER-001",
                activation_ref="IOT-ACT-001",
            )
        validate_fulfillment_action(
            action="ACTIVATE",
            device_state="SHIPPED",
            device_sku="SKU-001",
            order_sku="SKU-001",
            device_order_id="ORDER-001",
            order_name="ORDER-001",
            activation_ref="IOT-ACT-001",
        )

    def test_personal_information_is_rejected_from_references(self) -> None:
        with self.assertRaisesRegex(FulfillmentRuleError, "直接个人信息"):
            validate_deidentified_reference(
                "parent@example.com", "脱敏收货对象引用", required=False
            )
        with self.assertRaisesRegex(FulfillmentRuleError, "直接个人信息"):
            validate_deidentified_reference(
                "13800138000", "脱敏激活引用", required=True
            )
        with self.assertRaisesRegex(FulfillmentRuleError, "直接个人信息"):
            validate_channel_order(
                channel="TMALL",
                channel_scope="FLAGSHIP",
                external_order_id="TM-ORDER-PII-001",
                mapping_status="ACTIVE",
                order_quantity=1,
                raw_payload_ref="OMS://orders/parent@example.com",
            )


if __name__ == "__main__":
    unittest.main()
