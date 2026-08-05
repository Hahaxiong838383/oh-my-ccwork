from __future__ import annotations

import unittest

from aishike_erp import (
    AishikeErpService,
    BillOfMaterials,
    Channel,
    DeviceState,
    DomainError,
    ProductTemplate,
    RmaType,
)
from aishike_erp.domain import configuration_key


class AishikeErpServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.service = AishikeErpService()
        self.approved_attributes = {
            "color": "STAR_WHITE",
            "hardware": "STANDARD",
            "region": "CN",
        }
        self.service.register_template(
            ProductTemplate(
                code="K1",
                allowed_attributes={
                    "color": frozenset({"STAR_WHITE", "DEEP_GRAY"}),
                    "hardware": frozenset({"STANDARD", "PRO"}),
                    "region": frozenset({"CN"}),
                },
                approved_combinations=frozenset(
                    {configuration_key(self.approved_attributes)}
                ),
            )
        )
        self.service.configure_sku(
            "K1",
            "K1-WHITE-STD-CN",
            self.approved_attributes,
            "K1-BOM-R1",
        )
        self.service.register_bom(
            BillOfMaterials(
                revision="K1-BOM-R1",
                sku_code="K1-WHITE-STD-CN",
                components={"MAINBOARD": 1, "OPTICAL-MODULE": 1},
                required_tests=("OPTICAL", "SENSOR", "AI", "OQC"),
            )
        )

    def create_flashed_device(self, serial_no: str = "K1-SN-001") -> None:
        self.service.release_work_order("WO-001", "K1-WHITE-STD-CN", 1)
        self.service.create_device(serial_no, "WO-001")
        self.service.mark_assembled(serial_no)
        self.service.flash_device(serial_no, "FW-1.0.0", "XIAOKE-3.2")

    def pass_all_tests(self, serial_no: str = "K1-SN-001") -> None:
        for test_type in ("OPTICAL", "SENSOR", "AI", "OQC"):
            self.service.record_test(
                serial_no,
                test_type,
                True,
                "TEMPLATE-1",
                f"qms://{serial_no}/{test_type.lower()}",
            )

    def test_rejects_unapproved_sku_combination(self) -> None:
        with self.assertRaisesRegex(DomainError, "未经过工程批准"):
            self.service.configure_sku(
                "K1",
                "K1-GRAY-PRO-CN",
                {"color": "DEEP_GRAY", "hardware": "PRO", "region": "CN"},
                "K1-BOM-R2",
            )

    def test_rejects_stock_release_when_required_tests_are_missing(self) -> None:
        self.create_flashed_device()
        self.service.record_test(
            "K1-SN-001",
            "OPTICAL",
            True,
            "TEMPLATE-1",
            "qms://optical",
        )
        with self.assertRaisesRegex(DomainError, "强制测试未通过"):
            self.service.release_to_stock("K1-SN-001")

    def test_failed_test_can_be_retested_without_overwriting_history(self) -> None:
        self.create_flashed_device()
        self.service.record_test(
            "K1-SN-001", "OPTICAL", False, "TEMPLATE-1", "qms://failed"
        )
        self.service.record_test(
            "K1-SN-001", "OPTICAL", True, "TEMPLATE-1", "qms://passed"
        )
        for test_type in ("SENSOR", "AI", "OQC"):
            self.service.record_test(
                "K1-SN-001",
                test_type,
                True,
                "TEMPLATE-1",
                f"qms://{test_type.lower()}",
            )
        self.service.release_to_stock("K1-SN-001")
        self.assertEqual(DeviceState.STOCKED, self.service.devices["K1-SN-001"].state)
        self.assertEqual(5, len(self.service.devices["K1-SN-001"].tests))

    def test_channel_order_creation_is_idempotent(self) -> None:
        self.service.map_channel_sku(
            Channel.TMALL,
            "TM-K1-001",
            "K1-WHITE-STD-CN",
            "FLAGSHIP",
        )
        first = self.service.create_channel_order(
            "SO-001", Channel.TMALL, "TM-ORDER-001", "TM-K1-001", "FLAGSHIP"
        )
        second = self.service.create_channel_order(
            "SO-RETRY", Channel.TMALL, "TM-ORDER-001", "TM-K1-001", "FLAGSHIP"
        )
        self.assertIs(first, second)
        self.assertEqual("SO-001", second.internal_order_id)

    def test_full_device_lifecycle_reaches_activation(self) -> None:
        self.create_flashed_device()
        self.pass_all_tests()
        self.service.release_to_stock("K1-SN-001")
        self.service.map_channel_sku(
            Channel.JD,
            "JD-K1-A01",
            "K1-WHITE-STD-CN",
            "JD-FLAGSHIP",
        )
        self.service.create_channel_order(
            "SO-001", Channel.JD, "JD-ORDER-001", "JD-K1-A01", "JD-FLAGSHIP"
        )
        self.service.allocate_device("SO-001", "K1-SN-001")
        self.service.ship_order("SO-001", "JD-LOGISTICS-001")
        self.service.activate_device("K1-SN-001", "family://masked-001")

        trace = self.service.get_device_trace("K1-SN-001")

        self.assertEqual(DeviceState.ACTIVATED, self.service.devices["K1-SN-001"].state)
        self.assertEqual("K1-BOM-R1", trace["device"]["bom_revision"])
        self.assertEqual("JD-ORDER-001", trace["orders"][0]["external_order_id"])
        self.assertEqual(12, len(trace["device"]["lifecycle_events"]))

    def test_activated_device_can_open_rma(self) -> None:
        self.create_flashed_device()
        self.pass_all_tests()
        self.service.release_to_stock("K1-SN-001")
        self.service.map_channel_sku(
            Channel.TMALL,
            "TM-K1-001",
            "K1-WHITE-STD-CN",
            "FLAGSHIP",
        )
        self.service.create_channel_order(
            "SO-001", Channel.TMALL, "TM-ORDER-001", "TM-K1-001", "FLAGSHIP"
        )
        self.service.allocate_device("SO-001", "K1-SN-001")
        self.service.ship_order("SO-001", "SF-001")
        self.service.activate_device("K1-SN-001", "family://masked-001")

        self.service.open_rma(
            "RMA-001",
            "K1-SN-001",
            RmaType.REPAIR,
            "OPTICAL_CALIBRATION",
        )

        trace = self.service.get_device_trace("K1-SN-001")
        self.assertEqual(DeviceState.RMA_OPEN, self.service.devices["K1-SN-001"].state)
        self.assertEqual("RMA-001", trace["rma_cases"][0]["rma_id"])

    def test_activation_before_shipping_is_rejected(self) -> None:
        self.create_flashed_device()
        with self.assertRaisesRegex(DomainError, "需要=SHIPPED"):
            self.service.activate_device("K1-SN-001", "family://masked-001")


if __name__ == "__main__":
    unittest.main()
