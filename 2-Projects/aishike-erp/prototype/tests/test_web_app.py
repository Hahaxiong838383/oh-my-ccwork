from __future__ import annotations

import unittest

from aishike_erp import DeviceState, DomainError
from web_app import DemoController


class DemoControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = DemoController()

    def test_rejects_unapproved_sales_configuration(self) -> None:
        with self.assertRaisesRegex(DomainError, "未经过工程批准"):
            self.controller.execute(
                "create_sku",
                {"color": "DEEP_GRAY", "hardware": "PRO", "region": "CN"},
            )

    def test_manual_ui_flow_reaches_activation(self) -> None:
        actions = [
            (
                "create_sku",
                {"color": "STAR_WHITE", "hardware": "STANDARD", "region": "CN"},
            ),
            ("release_work_order", {}),
            ("create_device", {}),
            ("assemble", {}),
            ("flash", {}),
            ("run_tests", {}),
            ("stock", {}),
            ("create_order", {"channel": "TMALL"}),
            ("allocate", {}),
            ("ship", {}),
            ("activate", {}),
        ]
        for action, payload in actions:
            state = self.controller.execute(action, payload)

        self.assertEqual(
            DeviceState.ACTIVATED,
            self.controller.service.devices[self.controller.serial_no].state,
        )
        self.assertEqual(10, sum(step["complete"] for step in state["pipeline"]))
        self.assertEqual(["open_rma"], state["actions"])

    def test_failed_optical_test_blocks_stock_until_retest(self) -> None:
        for action in (
            "release_work_order",
            "create_device",
            "assemble",
            "flash",
        ):
            if action == "release_work_order":
                self.controller.execute(
                    "create_sku",
                    {
                        "color": "STAR_WHITE",
                        "hardware": "STANDARD",
                        "region": "CN",
                    },
                )
            self.controller.execute(action, {})
        self.controller.execute("run_tests", {"fail_optical": True})

        with self.assertRaisesRegex(DomainError, "OPTICAL"):
            self.controller.execute("stock", {})

        self.controller.execute("run_tests", {})
        state = self.controller.execute("stock", {})
        self.assertEqual("STOCKED", state["trace"]["device"]["state"])
        self.assertEqual(6, state["summary"]["passed_test_count"])


if __name__ == "__main__":
    unittest.main()
