from __future__ import annotations

import frappe
from frappe.utils import now_datetime


def append_device_event(
    device_unit: str,
    event_type: str,
    source_system: str,
    source_record_id: str = "",
    metadata_json: str = "",
) -> None:
    event = frappe.get_doc(
        {
            "doctype": "Aishike Device Lifecycle Event",
            "device_unit": device_unit,
            "event_type": event_type,
            "occurred_at": now_datetime(),
            "source_system": source_system,
            "source_record_id": source_record_id,
            "metadata_json": metadata_json,
        }
    )
    event.insert(ignore_permissions=True)
