from __future__ import annotations

from collections.abc import Iterable, Mapping


TEST_TYPES = ("OPTICAL", "SENSOR", "FUNCTION", "AI", "AGING", "OQC")
TEST_LABELS = {
    "OPTICAL": "光学与照明",
    "SENSOR": "传感器",
    "FUNCTION": "整机功能",
    "AI": "AI 能力",
    "AGING": "老化",
    "OQC": "出厂检查",
}
FLASH_ALLOWED_STATES = {"ASSEMBLED", "FLASHED"}
TEST_ALLOWED_STATES = {"FLASHED"}
RESULTS = {"PASS", "FAIL"}


class ManufacturingRuleError(ValueError):
    pass


def validate_flash_attempt(
    *,
    lifecycle_state: str,
    result: str,
    firmware_version: str,
    agent_version: str,
    failure_reason: str = "",
) -> None:
    if lifecycle_state not in FLASH_ALLOWED_STATES:
        raise ManufacturingRuleError("只有已完成组装或已完成烧录的设备可以记录烧录")
    _validate_result(result)
    if not (firmware_version or "").strip():
        raise ManufacturingRuleError("必须填写固件版本")
    if not (agent_version or "").strip():
        raise ManufacturingRuleError("必须填写 AI Agent 版本")
    if result == "FAIL" and not (failure_reason or "").strip():
        raise ManufacturingRuleError("烧录失败时必须填写失败原因")


def validate_test_attempt(
    *,
    lifecycle_state: str,
    test_type: str,
    result: str,
    failure_reason: str = "",
) -> None:
    if lifecycle_state not in TEST_ALLOWED_STATES:
        raise ManufacturingRuleError("设备必须完成烧录后才能记录出厂测试")
    if test_type not in TEST_TYPES:
        raise ManufacturingRuleError(f"不支持的测试类型: {test_type}")
    _validate_result(result)
    if result == "FAIL" and not (failure_reason or "").strip():
        raise ManufacturingRuleError("测试不通过时必须填写失败原因")


def summarize_test_records(records: Iterable[Mapping[str, object]]) -> dict[str, object]:
    attempts = {test_type: 0 for test_type in TEST_TYPES}
    latest: dict[str, dict[str, object] | None] = {test_type: None for test_type in TEST_TYPES}
    for record in records:
        test_type = str(record.get("test_type") or "")
        if test_type not in attempts:
            continue
        attempts[test_type] += 1
        latest[test_type] = dict(record)

    passed = sum(1 for test_type in TEST_TYPES if _latest_result(latest[test_type]) == "PASS")
    failed = sum(1 for test_type in TEST_TYPES if _latest_result(latest[test_type]) == "FAIL")
    pending = len(TEST_TYPES) - passed - failed
    return {
        "attempts": attempts,
        "latest": latest,
        "passed": passed,
        "failed": failed,
        "pending": pending,
        "complete": passed == len(TEST_TYPES),
    }


def _validate_result(result: str) -> None:
    if result not in RESULTS:
        raise ManufacturingRuleError(f"不支持的执行结果: {result}")


def _latest_result(record: Mapping[str, object] | None) -> str:
    return str(record.get("result") or "") if record else ""
