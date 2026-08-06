from __future__ import annotations


M23_ALLOWED_DEVICE_STATES = frozenset(
    {"CREATED", "ASSEMBLED", "FLASHED", "QC_PASSED", "STOCKED"}
)
M23_ALLOWED_EVENT_TYPES = frozenset(
    {
        "DEVICE_CREATED",
        "ASSEMBLED",
        "FLASH_FAIL",
        "FLASH_PASS",
        "FLASHED",
        "TEST_FAIL",
        "TEST_PASS",
        "QUALITY_REJECTED",
        "QC_PASSED",
        "STOCKED",
        "STOCK_TRANSFERRED",
    }
)
M23_FIXTURE_BATCH_PREFIX = "M23-"
M23_DEVICE_COLUMNS = (
    "quality_release_record",
    "current_warehouse",
    "latest_stock_movement",
)
M23_REQUIRED_DOCTYPES = (
    "Aishike Quality Release Record",
    "Aishike Device Stock Movement",
)

M3_ALLOWED_DEVICE_STATES = frozenset(
    {*M23_ALLOWED_DEVICE_STATES, "ALLOCATED", "SHIPPED", "ACTIVATED"}
)
M3_ALLOWED_EVENT_TYPES = frozenset(
    {*M23_ALLOWED_EVENT_TYPES, "ALLOCATED", "SHIPPED", "ACTIVATED"}
)
M3_DEVICE_COLUMNS = (
    *M23_DEVICE_COLUMNS,
    "current_channel",
    "channel_order_id",
    "latest_fulfillment_record",
    "current_customer_ref",
    "logistics_carrier",
    "tracking_no",
    "shipped_at",
    "activation_ref",
    "activated_at",
)
M3_REQUIRED_DOCTYPES = (
    *M23_REQUIRED_DOCTYPES,
    "Aishike Channel SKU Mapping",
    "Aishike Channel Order",
    "Aishike Device Fulfillment Record",
)


def is_m23_device_state(lifecycle_state: str) -> bool:
    return lifecycle_state in M23_ALLOWED_DEVICE_STATES


def is_m23_event_type(event_type: str) -> bool:
    return event_type in M23_ALLOWED_EVENT_TYPES


def is_m3_device_state(lifecycle_state: str) -> bool:
    return lifecycle_state in M3_ALLOWED_DEVICE_STATES


def is_m3_event_type(event_type: str) -> bool:
    return event_type in M3_ALLOWED_EVENT_TYPES
