from __future__ import annotations

import base64
import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any


READ_MODEL_VERSION = "m3-read-v1"
SAFE_COMPONENT = re.compile(r"[^A-Za-z0-9._-]+")


def safe_component(value: Any) -> str:
    raw = str(value or "")
    readable = SAFE_COMPONENT.sub("-", raw).strip("-")[:100] or "record"
    digest = hashlib.sha256(raw.encode()).hexdigest()[:12]
    return f"{readable}-{digest}"


def encode_cursor(sort_key: str) -> str:
    payload = json.dumps({"sortKey": sort_key}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> str:
    if not cursor:
        return ""
    padding = "=" * (-len(cursor) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor + padding))
    except (ValueError, json.JSONDecodeError) as error:
        raise ValueError("cursor is invalid") from error
    sort_key = str(payload.get("sortKey") or "")
    if len(sort_key) > 300:
        raise ValueError("cursor is invalid")
    return sort_key


def iso(value: Any) -> str:
    if not value:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        parsed = value
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def item(
    *,
    external_id: str,
    object_type: str,
    modified: Any,
    payload: dict[str, Any],
    source_record_id: str,
    status: str = "active",
) -> dict[str, Any]:
    source_updated_at = iso(modified)
    return {
        "externalId": external_id,
        "objectType": object_type,
        "sourceUpdatedAt": source_updated_at,
        "validFrom": source_updated_at,
        "status": status,
        "epistemicType": "source_fact",
        "authority": "aishike-erp-m3",
        "purpose": "operations-read-model",
        "payload": payload,
        "provenance": {
            "sourceRecordId": source_record_id,
            "sourceVersion": READ_MODEL_VERSION,
            "collectedAt": source_updated_at,
            "transformation": "aishike-erp-m3-safe-projection",
        },
        "_sortKey": f"{source_updated_at}|{object_type}|{external_id}",
    }


def map_order(row: dict[str, Any]) -> list[dict[str, Any]]:
    name = str(row["name"])
    order_id = safe_component(name)
    common = {
        "orderKey": name,
        "channel": row.get("channel"),
        "skuKey": row.get("sku_configuration"),
        "quantity": int(row.get("order_quantity") or 0),
        "orderStatus": row.get("order_status"),
        "allocatedCount": int(row.get("allocated_count") or 0),
        "shippedCount": int(row.get("shipped_count") or 0),
        "activatedCount": int(row.get("activated_count") or 0),
    }
    return [
        item(external_id=f"order:{order_id}", object_type="domain.operations.Order", modified=row.get("modified"), payload=common, source_record_id=name),
        item(external_id=f"order-line:{order_id}:1", object_type="domain.operations.OrderLine", modified=row.get("modified"), payload={"orderKey": name, "lineKey": f"{name}:1", "skuKey": row.get("sku_configuration"), "quantity": common["quantity"], "lineStatus": row.get("order_status")}, source_record_id=name),
    ]


def map_device(row: dict[str, Any]) -> list[dict[str, Any]]:
    serial = str(row["name"])
    serial_id = safe_component(serial)
    modified = row.get("modified")
    state = str(row.get("lifecycle_state") or "UNKNOWN")
    output = [
        item(external_id=f"device:{serial_id}", object_type="domain.device.DeviceInstance", modified=modified, payload={"instanceKey": serial, "skuKey": row.get("sku_configuration"), "currentState": state, "sourceUpdatedAt": iso(modified), "warehouseKey": row.get("current_warehouse"), "orderKey": row.get("channel_order_id")}, source_record_id=serial),
        item(external_id=f"serial:{serial_id}", object_type="domain.device.SerialNumber", modified=modified, payload={"serialKey": serial, "serialStatus": "assigned"}, source_record_id=serial),
        item(external_id=f"device-state:{serial_id}:{safe_component(state)}", object_type="domain.device.DeviceState", modified=modified, payload={"deviceKey": serial, "state": state}, source_record_id=serial),
    ]
    if row.get("current_warehouse"):
        warehouse = str(row.get("current_warehouse"))
        output.append(item(external_id=f"inventory:{safe_component(warehouse)}:{serial_id}", object_type="domain.operations.InventoryPosition", modified=modified, payload={"positionKey": f"{warehouse}:{serial}", "warehouseKey": warehouse, "skuKey": row.get("sku_configuration"), "onHand": 1 if state in {"STOCKED", "ALLOCATED"} else 0, "available": 1 if state == "STOCKED" else 0}, source_record_id=serial))
    return output


def map_quality(row: dict[str, Any]) -> list[dict[str, Any]]:
    name = str(row["name"])
    return [item(external_id=f"quality:{safe_component(name)}", object_type="domain.operations.QualityInspection", modified=row.get("modified"), payload={"inspectionKey": name, "deviceKey": row.get("device_unit"), "result": row.get("decision"), "attemptNo": int(row.get("attempt_no") or 0), "checklistVersion": row.get("checklist_version"), "releasedAt": iso(row.get("released_at") or row.get("modified"))}, source_record_id=name)]


def map_fulfillment(row: dict[str, Any]) -> list[dict[str, Any]]:
    name = str(row["name"])
    record_id = safe_component(name)
    action = str(row.get("action") or "")
    base = {"evidenceKey": name, "evidenceType": action.lower(), "readModelVersion": READ_MODEL_VERSION, "orderKey": row.get("channel_order"), "deviceKey": row.get("device_unit"), "actionAt": iso(row.get("action_at") or row.get("modified")), "sourceSystem": row.get("source_system")}
    output = [item(external_id=f"fulfillment-evidence:{record_id}", object_type="domain.operations.FulfillmentEvidence", modified=row.get("modified"), payload=base, source_record_id=name)]
    if action == "SHIP":
        output.append(item(external_id=f"shipment:{record_id}", object_type="domain.operations.Shipment", modified=row.get("modified"), payload={"shipmentKey": name, "shipmentStatus": "SHIPPED", "orderKey": row.get("channel_order"), "deviceKey": row.get("device_unit"), "carrier": row.get("logistics_carrier"), "shippedAt": base["actionAt"]}, source_record_id=name))
    if action == "ACTIVATE":
        output.append(item(external_id=f"activation:{record_id}", object_type="domain.operations.Activation", modified=row.get("modified"), payload={"activationKey": name, "deviceKey": row.get("device_unit"), "activationStatus": "ACTIVATED", "activatedAt": base["actionAt"]}, source_record_id=name))
    return output


def paginate(items: list[dict[str, Any]], cursor: str | None, limit: int) -> dict[str, Any]:
    after = decode_cursor(cursor)
    filtered = sorted((entry for entry in items if entry["_sortKey"] > after), key=lambda entry: entry["_sortKey"])
    page = filtered[: limit + 1]
    has_more = len(page) > limit
    selected = page[:limit]
    next_cursor = encode_cursor(selected[-1]["_sortKey"]) if selected else cursor or ""
    safe_items = [{key: value for key, value in entry.items() if key != "_sortKey"} for entry in selected]
    return {"sourceVersion": READ_MODEL_VERSION, "items": safe_items, "nextCursor": next_cursor, "hasMore": has_more}
