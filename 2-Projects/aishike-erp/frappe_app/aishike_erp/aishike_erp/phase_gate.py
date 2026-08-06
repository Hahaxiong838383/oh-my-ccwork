from __future__ import annotations


M2_ALLOWED_DEVICE_STATES = frozenset({"CREATED", "ASSEMBLED", "FLASHED"})
M2_ALLOWED_EVENT_TYPES = frozenset(
    {
        "DEVICE_CREATED",
        "ASSEMBLED",
        "FLASH_FAIL",
        "FLASH_PASS",
        "FLASHED",
        "TEST_FAIL",
        "TEST_PASS",
    }
)
M23_FIXTURE_BATCH_PREFIX = "M23-"
M23_DEVICE_COLUMNS = (
    "quality_release_record",
    "current_warehouse",
    "latest_stock_movement",
)
M23_ORPHAN_DOCTYPES = (
    "Aishike Quality Release Record",
    "Aishike Device Stock Movement",
)


def derive_m2_device_state(*, has_passed_flash: bool, has_assembly_event: bool) -> str:
    if has_passed_flash:
        return "FLASHED"
    if has_assembly_event:
        return "ASSEMBLED"
    return "CREATED"


def is_m23_fixture_batch(production_batch: str | None) -> bool:
    return bool(production_batch and production_batch.startswith(M23_FIXTURE_BATCH_PREFIX))


def is_m2_event_type(event_type: str) -> bool:
    return event_type in M2_ALLOWED_EVENT_TYPES
