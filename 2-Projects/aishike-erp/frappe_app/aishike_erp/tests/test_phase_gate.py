from __future__ import annotations

import unittest

from aishike_erp.phase_gate import (
    is_m3_device_state,
    is_m3_event_type,
    is_m23_device_state,
    is_m23_event_type,
)


class PhaseGateTest(unittest.TestCase):
    def test_quality_and_stock_states_are_inside_m23(self) -> None:
        self.assertTrue(is_m23_device_state("QC_PASSED"))
        self.assertTrue(is_m23_device_state("STOCKED"))

    def test_channel_states_remain_outside_m23(self) -> None:
        self.assertFalse(is_m23_device_state("ALLOCATED"))
        self.assertFalse(is_m23_device_state("SHIPPED"))

    def test_quality_and_stock_events_are_inside_m23(self) -> None:
        self.assertTrue(is_m23_event_type("QUALITY_REJECTED"))
        self.assertTrue(is_m23_event_type("QC_PASSED"))
        self.assertTrue(is_m23_event_type("STOCKED"))
        self.assertTrue(is_m23_event_type("STOCK_TRANSFERRED"))

    def test_channel_events_remain_outside_m23(self) -> None:
        self.assertFalse(is_m23_event_type("ALLOCATED"))
        self.assertFalse(is_m23_event_type("SHIPPED"))

    def test_fulfillment_states_and_events_are_inside_m3(self) -> None:
        for value in ("ALLOCATED", "SHIPPED", "ACTIVATED"):
            self.assertTrue(is_m3_device_state(value))
            self.assertTrue(is_m3_event_type(value))

    def test_rma_states_remain_outside_m3(self) -> None:
        self.assertFalse(is_m3_device_state("RMA_OPEN"))
        self.assertFalse(is_m3_event_type("RMA_OPEN"))


if __name__ == "__main__":
    unittest.main()
