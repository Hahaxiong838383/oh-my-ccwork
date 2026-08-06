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


SKU_PRODUCT_LINES = {"T", "S", "T&S"}
SKU_MODELS = {"MaxLite", "Max", "Ultra", "LF"}
SKU_SCREENS = {"N", "A", "V"}
SKU_BUNDLES = {"N", "S1", "S2"}
SKU_VERSIONS = {"V1", "V2"}


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


def build_sku_code(
    product_line: str,
    model: str,
    screen: str,
    bundle: str,
    version: str,
) -> str:
    values = {
        "产品线": (product_line, SKU_PRODUCT_LINES),
        "机型": (model, SKU_MODELS),
        "屏幕": (screen, SKU_SCREENS),
        "套装": (bundle, SKU_BUNDLES),
        "版本": (version, SKU_VERSIONS),
    }
    for label, (value, allowed) in values.items():
        if value not in allowed:
            raise RuleViolation(f"SKU{label}代码无效: {value}")
    return f"EC-{product_line}-{model}-{screen}-{bundle}-{version}"


def validate_device_state_transition(previous: str | None, current: str) -> None:
    validate_transition(DEVICE_STATE_TRANSITIONS, previous, current, "设备状态")


def changed_locked_fields(
    previous: Mapping[str, object],
    current: Mapping[str, object],
    fields: Sequence[str],
) -> list[str]:
    return [field for field in fields if previous.get(field) != current.get(field)]
