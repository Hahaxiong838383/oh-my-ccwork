from __future__ import annotations


QUALITY_DECISIONS = {"PASS", "REJECT"}
STOCK_MOVEMENT_TYPES = {"RECEIVE", "TRANSFER"}


class QualityInventoryRuleError(ValueError):
    pass


def validate_quality_release(
    *,
    lifecycle_state: str,
    decision: str,
    tests_complete: bool,
    failure_reason: str = "",
) -> None:
    if lifecycle_state != "FLASHED":
        raise QualityInventoryRuleError("只有已完成烧录且未质量放行的设备可以执行质量判定")
    if decision not in QUALITY_DECISIONS:
        raise QualityInventoryRuleError(f"不支持的质量判定: {decision}")
    if not tests_complete:
        raise QualityInventoryRuleError("六项测试最新结果必须全部通过才能执行质量判定")
    if decision == "REJECT" and not (failure_reason or "").strip():
        raise QualityInventoryRuleError("质量驳回时必须填写原因")


def validate_stock_movement(
    *,
    lifecycle_state: str,
    movement_type: str,
    current_warehouse: str = "",
    from_warehouse: str = "",
    to_warehouse: str = "",
) -> None:
    if movement_type not in STOCK_MOVEMENT_TYPES:
        raise QualityInventoryRuleError(f"不支持的库存移动类型: {movement_type}")
    if not (to_warehouse or "").strip():
        raise QualityInventoryRuleError("必须选择目标仓库")

    if movement_type == "RECEIVE":
        if lifecycle_state != "QC_PASSED":
            raise QualityInventoryRuleError("只有已通过质量门的设备可以执行成品入库")
        if current_warehouse:
            raise QualityInventoryRuleError("设备已经在库，不能重复执行成品入库")
        if from_warehouse:
            raise QualityInventoryRuleError("成品入库不应填写来源仓库")
        return

    if lifecycle_state != "STOCKED":
        raise QualityInventoryRuleError("只有在库设备可以执行仓库调拨")
    if not current_warehouse:
        raise QualityInventoryRuleError("在库设备缺少当前仓库，不能执行调拨")
    if from_warehouse != current_warehouse:
        raise QualityInventoryRuleError("来源仓库必须与设备当前仓库一致")
    if from_warehouse == to_warehouse:
        raise QualityInventoryRuleError("来源仓库与目标仓库不能相同")
