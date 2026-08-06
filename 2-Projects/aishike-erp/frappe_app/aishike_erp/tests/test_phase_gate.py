from __future__ import annotations

import unittest

from aishike_erp.phase_gate import (
    derive_m2_device_state,
    is_m23_fixture_batch,
    is_m2_event_type,
)


class PhaseGateTest(unittest.TestCase):
    def test_passed_flash_has_priority_over_assembly(self) -> None:
        self.assertEqual(
            "FLASHED",
            derive_m2_device_state(has_passed_flash=True, has_assembly_event=True),
        )

    def test_assembly_without_passed_flash_stays_assembled(self) -> None:
        self.assertEqual(
            "ASSEMBLED",
            derive_m2_device_state(has_passed_flash=False, has_assembly_event=True),
        )

    def test_device_without_manufacturing_evidence_returns_to_created(self) -> None:
        self.assertEqual(
            "CREATED",
            derive_m2_device_state(has_passed_flash=False, has_assembly_event=False),
        )

    def test_only_explicit_m23_batches_are_cleanup_fixtures(self) -> None:
        self.assertTrue(is_m23_fixture_batch("M23-BROWSER-ACCEPT-001"))
        self.assertFalse(is_m23_fixture_batch("M2-ACCEPT-001"))
        self.assertFalse(is_m23_fixture_batch(None))

    def test_quality_and_stock_events_are_outside_m2(self) -> None:
        self.assertTrue(is_m2_event_type("TEST_PASS"))
        self.assertFalse(is_m2_event_type("QC_PASSED"))
        self.assertFalse(is_m2_event_type("STOCKED"))


if __name__ == "__main__":
    unittest.main()
