from __future__ import annotations

import unittest

from aishike_erp.rules import RuleViolation, build_sku_code
from aishike_erp.sku_catalog import sheet1_skus


class SKUCodeTest(unittest.TestCase):
    def test_sheet1_rule_matches_generator_format(self) -> None:
        self.assertEqual(
            "EC-T&S-Max-V-S2-V2",
            build_sku_code("T&S", "Max", "V", "S2", "V2"),
        )

    def test_invalid_rule_value_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuleViolation, "屏幕"):
            build_sku_code("T", "Max", "OLED", "N", "V1")

    def test_sheet1_catalog_contains_eleven_unique_skus(self) -> None:
        rows = sheet1_skus()
        codes = [str(row["item_code"]) for row in rows]
        self.assertEqual(11, len(rows))
        self.assertEqual(11, len(set(codes)))

    def test_sheet1_catalog_preserves_pending_erp_codes(self) -> None:
        rows = sheet1_skus()
        pending = [row for row in rows if row["erp_item_code_status"] == "PENDING"]
        self.assertEqual(4, len(pending))
        self.assertTrue(all(row["erp_item_code"] == "FQT" for row in pending))


if __name__ == "__main__":
    unittest.main()
