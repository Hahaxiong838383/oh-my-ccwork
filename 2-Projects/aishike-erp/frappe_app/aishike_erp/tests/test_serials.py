from __future__ import annotations

import unittest
from datetime import date

from aishike_erp.serials import (
    SerialRuleError,
    get_scope_key,
    make_qr_payload,
    normalize_scan_value,
    render_serial,
    validate_pattern,
)


class SerialRuleTest(unittest.TestCase):
    def test_renders_custom_serial_pattern(self) -> None:
        serial = render_serial(
            pattern="{PREFIX}-{DATE}-{SKU}-{BATCH}-{SEQ}-{SUFFIX}",
            prefix="ASK",
            suffix="CN",
            date_format="YYMMDD",
            sku="ASK-RW-DESK-STAR-WHITE-PRO",
            batch="LOT 01",
            sequence=42,
            sequence_digits=6,
            date_value=date(2026, 8, 5),
        )
        self.assertEqual("ASK-260805-ASKRWDESKSTARWHITEPRO-LOT01-000042-CN", serial)

    def test_optional_empty_suffix_does_not_leave_separator(self) -> None:
        serial = render_serial(
            pattern="{PREFIX}-{DATE}-{SEQ}-{SUFFIX}",
            prefix="ASK",
            suffix="",
            date_format="YYYYMMDD",
            sku="",
            batch="",
            sequence=1,
            sequence_digits=4,
            date_value=date(2026, 8, 5),
        )
        self.assertEqual("ASK-20260805-0001", serial)

    def test_pattern_requires_sequence_token(self) -> None:
        with self.assertRaisesRegex(SerialRuleError, "SEQ"):
            validate_pattern("{PREFIX}-{DATE}")

    def test_pattern_rejects_unknown_token(self) -> None:
        with self.assertRaisesRegex(SerialRuleError, "UNKNOWN"):
            validate_pattern("{PREFIX}-{UNKNOWN}-{SEQ}")

    def test_scope_keys_follow_reset_policy(self) -> None:
        current_date = date(2026, 8, 5)
        self.assertEqual("GLOBAL", get_scope_key("NEVER", current_date, "LOT01"))
        self.assertEqual("20260805", get_scope_key("DAILY", current_date, "LOT01"))
        self.assertEqual("202608", get_scope_key("MONTHLY", current_date, "LOT01"))
        self.assertEqual("BATCH:LOT01", get_scope_key("BATCH", current_date, "Lot 01"))

    def test_batch_reset_requires_batch(self) -> None:
        with self.assertRaisesRegex(SerialRuleError, "生产批次"):
            get_scope_key("BATCH", date(2026, 8, 5), "")

    def test_normalizes_raw_qr_and_url_scans(self) -> None:
        serial = "ASK-260805-000001"
        self.assertEqual(serial, normalize_scan_value(serial))
        self.assertEqual(serial, normalize_scan_value(f"ASK:DEVICE:{serial}"))
        self.assertEqual(
            serial,
            normalize_scan_value(
                f"http://aishike.localhost:18080/desk/aishike-device-unit/{serial}"
            ),
        )

    def test_qr_payload_is_versioned_and_contains_no_extra_data(self) -> None:
        self.assertEqual("ASK:DEVICE:ASK-260805-000001", make_qr_payload("ASK-260805-000001"))


if __name__ == "__main__":
    unittest.main()
