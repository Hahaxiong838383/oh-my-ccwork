from __future__ import annotations

import unittest
import re

from aishike_erp.ontology_read_contract import decode_cursor, encode_cursor, map_device, map_fulfillment, map_order, paginate


class OntologyReadContractTest(unittest.TestCase):
    def test_cursor_round_trip_and_invalid_cursor(self) -> None:
        sort_key = "2026-08-09T01:00:00Z|domain.operations.Order|order:ASK-ORD-00015"
        self.assertEqual(sort_key, decode_cursor(encode_cursor(sort_key)))
        with self.assertRaisesRegex(ValueError, "cursor"):
            decode_cursor("not-base64")

    def test_order_projection_excludes_private_references(self) -> None:
        items = map_order({"name": "ASK-ORD-00015", "modified": "2026-08-09T01:00:00Z", "channel": "TMALL", "sku_configuration": "SKU-001", "order_quantity": 1, "order_status": "ACTIVATED", "allocated_count": 1, "shipped_count": 1, "activated_count": 1, "recipient_ref": "must-not-leak", "raw_payload_ref": "must-not-leak"})
        serialized = str(items)
        self.assertNotIn("must-not-leak", serialized)
        self.assertEqual(["domain.operations.Order", "domain.operations.OrderLine"], [entry["objectType"] for entry in items])

    def test_device_and_fulfillment_map_only_m3_objects(self) -> None:
        device = map_device({"name": "ASK-000020", "modified": "2026-08-09T01:00:00Z", "sku_configuration": "SKU-001", "lifecycle_state": "ACTIVATED", "current_warehouse": "Stores - ASK", "channel_order_id": "ASK-ORD-00015"})
        fulfillment = map_fulfillment({"name": "ASK-FUL-00001", "modified": "2026-08-09T01:00:00Z", "channel_order": "ASK-ORD-00015", "device_unit": "ASK-000020", "action": "ACTIVATE", "action_at": "2026-08-09T01:00:00Z", "source_system": "IOT", "activation_ref": "private-ref", "customer_ref": "private-ref"})
        self.assertIn("domain.device.DeviceInstance", [entry["objectType"] for entry in device])
        self.assertIn("domain.operations.Activation", [entry["objectType"] for entry in fulfillment])
        self.assertNotIn("private-ref", str(fulfillment))
        for entry in [*device, *fulfillment]:
            self.assertRegex(entry["externalId"], r"^[A-Za-z0-9:._-]+$")
        instance = next(entry for entry in device if entry["objectType"] == "domain.device.DeviceInstance")
        self.assertEqual("2026-08-09T01:00:00Z", instance["payload"]["sourceUpdatedAt"])

    def test_warehouse_names_are_safe_in_external_ids(self) -> None:
        items = map_device({"name": "ASK 000020/测试", "modified": "2026-08-09T01:00:00Z", "sku_configuration": "SKU-001", "lifecycle_state": "STOCKED", "current_warehouse": "Stores - ASK / 成品", "channel_order_id": None})
        for entry in items:
            self.assertTrue(re.fullmatch(r"[A-Za-z0-9:._-]+", entry["externalId"]), entry["externalId"])

    def test_pagination_is_stable_and_idempotent(self) -> None:
        items = map_order({"name": "ASK-ORD-00015", "modified": "2026-08-09T01:00:00Z", "channel": "TMALL", "sku_configuration": "SKU-001", "order_quantity": 1, "order_status": "ACTIVATED", "allocated_count": 1, "shipped_count": 1, "activated_count": 1})
        first = paginate(items, "", 1)
        second = paginate(items, first["nextCursor"], 1)
        self.assertTrue(first["hasMore"])
        self.assertFalse(second["hasMore"])
        self.assertNotEqual(first["items"][0]["externalId"], second["items"][0]["externalId"])


if __name__ == "__main__":
    unittest.main()
