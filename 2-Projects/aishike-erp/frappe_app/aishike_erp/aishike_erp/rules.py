from __future__ import annotations

from collections.abc import Mapping, Sequence


class RuleViolation(ValueError):
    pass


SKU_STATUS_TRANSITIONS = {
    None: {"Draft"},
    "Draft": {"Draft", "Approved"},
    "Approved": {"Approved", "Disabled"},
    "Disabled": {"Disabled"},
}


DEVICE_STATE_TRANSITIONS = {
    None: {"CREATED"},
    "CREATED": {"CREATED", "ASSEMBLED"},
    "ASSEMBLED": {"ASSEMBLED", "FLASHED"},
    "FLASHED": {"FLASHED", "QC_PASSED"},
    "QC_PASSED": {"QC_PASSED", "STOCKED"},
    "STOCKED": {"STOCKED", "ALLOCATED"},
    "ALLOCATED": {"ALLOCATED", "SHIPPED"},
    "SHIPPED": {"SHIPPED", "ACTIVATED"},
    "ACTIVATED": {"ACTIVATED", "RMA_OPEN"},
    "RMA_OPEN": {"RMA_OPEN", "REPAIRING", "RETURNED", "SCRAPPED"},
    "REPAIRING": {"REPAIRING", "RETURNED", "REFURBISHED", "SCRAPPED"},
    "RETURNED": {"RETURNED"},
    "REFURBISHED": {"REFURBISHED"},
    "SCRAPPED": {"SCRAPPED"},
}


def validate_transition(
    transitions: Mapping[str | None, set[str]],
    previous: str | None,
    current: str,
    label: str,
) -> None:
    allowed = transitions.get(previous, set())
    if current not in allowed:
        previous_label = previous or "未创建"
        raise RuleViolation(f"{label}不允许从 {previous_label} 变更为 {current}")


def validate_sku_status_transition(previous: str | None, current: str) -> None:
    validate_transition(SKU_STATUS_TRANSITIONS, previous, current, "SKU状态")


def validate_device_state_transition(previous: str | None, current: str) -> None:
    validate_transition(DEVICE_STATE_TRANSITIONS, previous, current, "设备状态")


def changed_locked_fields(
    previous: Mapping[str, object],
    current: Mapping[str, object],
    fields: Sequence[str],
) -> list[str]:
    return [field for field in fields if previous.get(field) != current.get(field)]
