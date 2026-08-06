from __future__ import annotations

import json
import re

import frappe

from aishike_erp.localization import apply_chinese_defaults
from aishike_erp.phase_gate import (
    M3_ALLOWED_DEVICE_STATES,
    M3_ALLOWED_EVENT_TYPES,
    M3_DEVICE_COLUMNS,
    M3_REQUIRED_DOCTYPES,
)


EXPECTED_DOCTYPES = (
    "Aishike SKU Configuration",
    "Aishike Device Unit",
    "Aishike Device Test Record",
    "Aishike Device Lifecycle Event",
    "Aishike Firmware Flash Record",
    "Aishike Serial Number Rule",
    "Aishike Serial Number Batch",
    "Aishike Quality Release Record",
    "Aishike Device Stock Movement",
    "Aishike Channel SKU Mapping",
    "Aishike Channel Order",
    "Aishike Device Fulfillment Record",
)

ACCEPTANCE_FINISHED_ITEM = "ASK-RW-DESK-STAR-WHITE-STD"
ACCEPTANCE_COMPONENT_ITEM = "ASK-COMPONENT-MAINBOARD"
M23_MANUAL_BATCH_PREFIX = "M23-MANUAL-ACCEPT-"
M23_BROWSER_BATCH_PREFIX = "M23-BROWSER-ACCEPT-"
M23_MANUAL_GENERATION_DATE = "2026-08-06"
M23_COMPLETED_ACCEPTANCE_SERIAL = "ASK-000002"
M23_FINISHED_GOODS_WAREHOUSE = "Finished Goods - ASK"
M23_STORES_WAREHOUSE = "Stores - ASK"
M3_COMPLETED_BATCH_PREFIX = "M3-AUTO-ACCEPT-"
M3_MANUAL_BATCH_PREFIX = "M3-MANUAL-ACCEPT-"
M3_BROWSER_BATCH_PREFIX = "M3-BROWSER-ACCEPT-"
M3_NEGATIVE_BATCH_PREFIX = "M3-NEGATIVE-ACCEPT-"
M3_ROLE_BATCH_PREFIX = "M3-ROLE-ACCEPT-"
M3_COMPLETED_EXTERNAL_ORDER = "M3-AUTO-ORDER-001"
M3_MANUAL_EXTERNAL_ORDER = "M3-MANUAL-ORDER-001"
M3_BROWSER_EXTERNAL_ORDER = "M3-BROWSER-ORDER-001"
M3_NEGATIVE_EXTERNAL_ORDER = "M3-NEGATIVE-ORDER-001"
M3_ROLE_EXTERNAL_ORDER = "M3-ROLE-ORDER-001"
M3_CHANNEL = "TMALL"
M3_CHANNEL_SCOPE = "FLAGSHIP"
M3_EXTERNAL_SKU = "TMALL-ASK-RW-DESK-STAR-WHITE-STD"


def runtime_check() -> dict[str, object]:
    installed_apps = frappe.get_installed_apps()
    missing_doctypes = [
        doctype for doctype in EXPECTED_DOCTYPES if not frappe.db.exists("DocType", doctype)
    ]
    expected_pages = (
        "aishike-sn-console",
        "aishike-production-console",
        "aishike-quality-console",
        "aishike-fulfillment-console",
    )
    missing_pages = [page for page in expected_pages if not frappe.db.exists("Page", page)]
    missing_tables = [
        doctype
        for doctype in M3_REQUIRED_DOCTYPES
        if not frappe.db.table_exists(doctype, cached=False)
    ]
    missing_columns = [
        column
        for column in M3_DEVICE_COLUMNS
        if not frappe.db.has_column("Aishike Device Unit", column)
    ]
    out_of_phase_devices = frappe.get_all(
        "Aishike Device Unit",
        filters={"lifecycle_state": ["not in", sorted(M3_ALLOWED_DEVICE_STATES)]},
        pluck="name",
    )
    out_of_phase_events = frappe.get_all(
        "Aishike Device Lifecycle Event",
        filters={"event_type": ["not in", sorted(M3_ALLOWED_EVENT_TYPES)]},
        pluck="name",
    )
    incomplete = any(
        (
            "aishike_erp" not in installed_apps,
            missing_doctypes,
            missing_pages,
            missing_tables,
            missing_columns,
            out_of_phase_devices,
            out_of_phase_events,
        )
    )
    return {
        "status": "incomplete" if incomplete else "ok",
        "app_installed": "aishike_erp" in installed_apps,
        "expected_doctypes": list(EXPECTED_DOCTYPES),
        "missing_doctypes": missing_doctypes,
        "missing_pages": missing_pages,
        "missing_tables": missing_tables,
        "missing_columns": missing_columns,
        "out_of_phase_devices": out_of_phase_devices,
        "out_of_phase_events": out_of_phase_events,
        "sn_console_available": bool(frappe.db.exists("Page", "aishike-sn-console")),
        "production_console_available": bool(
            frappe.db.exists("Page", "aishike-production-console")
        ),
        "quality_console_available": bool(frappe.db.exists("Page", "aishike-quality-console")),
        "fulfillment_console_available": bool(
            frappe.db.exists("Page", "aishike-fulfillment-console")
        ),
    }


def assert_runtime_check() -> dict[str, object]:
    result = runtime_check()
    if result["status"] != "ok":
        frappe.throw(
            f"爱视可 ERP M3 运行检查未通过: {json.dumps(result, ensure_ascii=False)}"
        )
    return result


def seed_acceptance_fixture() -> dict[str, str]:
    _ensure_item(ACCEPTANCE_FINISHED_ITEM, "爱视可读写台 星光白 标准版", "Products")
    _ensure_item(ACCEPTANCE_COMPONENT_ITEM, "爱视可主板组件", "Raw Material")

    bom_name = frappe.db.get_value(
        "BOM",
        {"item": ACCEPTANCE_FINISHED_ITEM, "docstatus": 1, "is_active": 1},
        "name",
    )
    if not bom_name:
        bom = frappe.get_doc(
            {
                "doctype": "BOM",
                "item": ACCEPTANCE_FINISHED_ITEM,
                "quantity": 1,
                "is_active": 1,
                "is_default": 1,
                "items": [
                    {
                        "item_code": ACCEPTANCE_COMPONENT_ITEM,
                        "qty": 1,
                        "rate": 100,
                        "uom": "Nos",
                        "conversion_factor": 1,
                    }
                ],
            }
        )
        bom.insert(ignore_permissions=True)
        bom.submit()
        bom_name = bom.name

    sku_name = frappe.db.get_value(
        "Aishike SKU Configuration",
        {"item_code": ACCEPTANCE_FINISHED_ITEM},
        "name",
    )
    if not sku_name:
        sku = frappe.get_doc(
            {
                "doctype": "Aishike SKU Configuration",
                "item_template": ACCEPTANCE_FINISHED_ITEM,
                "item_code": ACCEPTANCE_FINISHED_ITEM,
                "status": "Draft",
                "color": "STAR_WHITE",
                "hardware_configuration": "STANDARD",
                "sales_region": "CN",
                "bom": bom_name,
            }
        )
        sku.insert(ignore_permissions=True)
        sku_name = sku.name

    frappe.db.commit()
    return {"item": ACCEPTANCE_FINISHED_ITEM, "bom": bom_name, "sku": sku_name}


def enable_chinese_ui() -> dict[str, str]:
    return apply_chinese_defaults()


def reset_m2_acceptance_fixture() -> dict[str, int]:
    serials = frappe.get_all(
        "Aishike Device Unit",
        filters={"production_batch": "M2-ACCEPT-001"},
        pluck="name",
    )
    batches = frappe.get_all(
        "Aishike Serial Number Batch",
        filters={"production_batch": "M2-ACCEPT-001"},
        pluck="name",
    )
    if serials:
        frappe.db.delete("Aishike Device Stock Movement", {"device_unit": ["in", serials]})
        frappe.db.delete("Aishike Quality Release Record", {"device_unit": ["in", serials]})
        frappe.db.delete("Aishike Device Lifecycle Event", {"device_unit": ["in", serials]})
        frappe.db.delete("Aishike Firmware Flash Record", {"device_unit": ["in", serials]})
        frappe.db.delete("Aishike Device Test Record", {"device_unit": ["in", serials]})
        frappe.db.delete("Aishike Device Unit", {"name": ["in", serials]})
    if batches:
        frappe.db.delete("Aishike Serial Number Batch", {"name": ["in", batches]})
    frappe.db.set_value(
        "Aishike Serial Number Rule",
        "ASK-DEFAULT",
        {"pattern": "{PREFIX}-{SEQ}", "current_scope_key": "GLOBAL", "next_sequence": 1},
    )
    frappe.db.commit()
    return {"devices": len(serials), "batches": len(batches)}


def seed_m23_completed_acceptance_fixture() -> dict[str, object]:
    from aishike_erp.quality import (
        get_quality_console,
        record_quality_release,
        record_stock_movement,
    )

    frappe.set_user("Administrator")
    _require_m23_acceptance_warehouses()
    if not frappe.db.exists("Aishike Device Unit", M23_COMPLETED_ACCEPTANCE_SERIAL):
        frappe.throw(f"缺少 M2.3 完整验收设备: {M23_COMPLETED_ACCEPTANCE_SERIAL}")

    initial = get_quality_console(M23_COMPLETED_ACCEPTANCE_SERIAL)
    created_actions: list[str] = []
    try:
        current = initial
        decisions = [row["decision"] for row in reversed(current["quality_records"])]
        if current["device"]["lifecycle_state"] == "FLASHED":
            if not decisions:
                current = record_quality_release(
                    scan_value=M23_COMPLETED_ACCEPTANCE_SERIAL,
                    decision="REJECT",
                    release_summary="包装与标签一致性复核",
                    failure_reason="包装标签复核不一致",
                )
                created_actions.append("QUALITY_REJECTED")
                decisions = [row["decision"] for row in reversed(current["quality_records"])]
            if decisions[-1] == "REJECT":
                current = record_quality_release(
                    scan_value=M23_COMPLETED_ACCEPTANCE_SERIAL,
                    decision="PASS",
                    release_summary="整改复核通过，允许成品入库",
                )
                created_actions.append("QUALITY_PASSED")

        if current["device"]["lifecycle_state"] == "QC_PASSED":
            current = record_stock_movement(
                scan_value=M23_COMPLETED_ACCEPTANCE_SERIAL,
                movement_type="RECEIVE",
                to_warehouse=M23_FINISHED_GOODS_WAREHOUSE,
                reference_type="M2.3 自动验收成品入库",
                reference_id="M23-ACCEPT-RECEIVE-001",
            )
            created_actions.append("STOCK_RECEIVED")

        if current["device"]["lifecycle_state"] == "STOCKED" and (
            current["device"]["current_warehouse"] != M23_STORES_WAREHOUSE
        ):
            current = record_stock_movement(
                scan_value=M23_COMPLETED_ACCEPTANCE_SERIAL,
                movement_type="TRANSFER",
                to_warehouse=M23_STORES_WAREHOUSE,
                reference_type="M2.3 自动验收仓库调拨",
                reference_id="M23-ACCEPT-TRANSFER-001",
            )
            created_actions.append("STOCK_TRANSFERRED")

        _assert_completed_m23_console(current)
        frappe.db.commit()
        return {
            "serial_no": M23_COMPLETED_ACCEPTANCE_SERIAL,
            "lifecycle_state": current["device"]["lifecycle_state"],
            "current_warehouse": current["device"]["current_warehouse"],
            "quality_records": len(current["quality_records"]),
            "stock_movements": len(current["stock_movements"]),
            "created_actions": created_actions,
            "reused": not created_actions,
        }
    except Exception:
        frappe.db.rollback()
        raise


def run_m23_negative_checks() -> dict[str, str]:
    frappe.set_user("Administrator")
    results: dict[str, str] = {}

    quality_name = frappe.db.get_value(
        "Aishike Quality Release Record",
        {"device_unit": "ASK-000002", "decision": "PASS"},
        "name",
    )
    stock_name = frappe.db.get_value(
        "Aishike Device Stock Movement",
        {"device_unit": "ASK-000002", "movement_type": "RECEIVE"},
        "name",
    )
    if not quality_name or not stock_name:
        frappe.throw("请先执行 M2.3 完整验收样本初始化，再运行负向验收")

    def capture(name: str, action) -> None:
        try:
            action()
            results[name] = "UNEXPECTED_SUCCESS"
        except Exception as error:
            results[name] = str(error).splitlines()[0]
        finally:
            frappe.db.rollback()

    def incomplete_quality() -> None:
        frappe.db.set_value(
            "Aishike Device Unit",
            "ASK-000003",
            "lifecycle_state",
            "FLASHED",
            update_modified=False,
        )
        frappe.get_doc(
            {
                "doctype": "Aishike Quality Release Record",
                "device_unit": "ASK-000003",
                "decision": "PASS",
                "checklist_version": "M2.3-V1",
            }
        ).insert()

    def stock_without_receipt() -> None:
        frappe.db.set_value(
            "Aishike Device Unit",
            "ASK-000003",
            "lifecycle_state",
            "QC_PASSED",
            update_modified=False,
        )
        device = frappe.get_doc("Aishike Device Unit", "ASK-000003")
        device.lifecycle_state = "STOCKED"
        device.save(ignore_permissions=True)

    def modify_quality() -> None:
        record = frappe.get_doc("Aishike Quality Release Record", quality_name)
        record.release_summary = "篡改尝试"
        record.save()

    def modify_stock() -> None:
        record = frappe.get_doc("Aishike Device Stock Movement", stock_name)
        record.remarks = "篡改尝试"
        record.save()

    def duplicate_receipt() -> None:
        frappe.get_doc(
            {
                "doctype": "Aishike Device Stock Movement",
                "device_unit": "ASK-000002",
                "movement_type": "RECEIVE",
                "to_warehouse": "Finished Goods - ASK",
            }
        ).insert()

    def same_warehouse_transfer() -> None:
        frappe.get_doc(
            {
                "doctype": "Aishike Device Stock Movement",
                "device_unit": "ASK-000002",
                "movement_type": "TRANSFER",
                "from_warehouse": "Stores - ASK",
                "to_warehouse": "Stores - ASK",
            }
        ).insert()

    capture("incomplete_quality_blocked", incomplete_quality)
    capture("stock_without_receipt_blocked", stock_without_receipt)
    capture("quality_record_immutable", modify_quality)
    capture("stock_record_immutable", modify_stock)
    capture("duplicate_receipt_blocked", duplicate_receipt)
    capture("same_warehouse_transfer_blocked", same_warehouse_transfer)
    expected_messages = {
        "incomplete_quality_blocked": "六项测试最新结果必须全部通过",
        "stock_without_receipt_blocked": "成品入库凭证",
        "quality_record_immutable": "质量放行记录不可修改",
        "stock_record_immutable": "库存移动记录不可修改",
        "duplicate_receipt_blocked": "只有已通过质量门的设备可以执行成品入库",
        "same_warehouse_transfer_blocked": "来源仓库与目标仓库不能相同",
    }
    failures = {
        key: results.get(key, "")
        for key, expected in expected_messages.items()
        if expected not in results.get(key, "")
    }
    if failures:
        frappe.throw(f"M2.3 负向验收未通过: {failures}")
    return results


def get_m23_acceptance_snapshot() -> dict[str, object]:
    device = frappe.db.get_value(
        "Aishike Device Unit",
        "ASK-000002",
        [
            "lifecycle_state",
            "quality_release_record",
            "current_warehouse",
            "latest_stock_movement",
        ],
        as_dict=True,
    )
    return {
        "device": device,
        "quality_records": frappe.db.count(
            "Aishike Quality Release Record", {"device_unit": "ASK-000002"}
        ),
        "stock_movements": frappe.db.count(
            "Aishike Device Stock Movement", {"device_unit": "ASK-000002"}
        ),
        "lifecycle_events": frappe.db.count(
            "Aishike Device Lifecycle Event", {"device_unit": "ASK-000002"}
        ),
    }


def seed_m23_manual_acceptance_fixture() -> dict[str, object]:
    return _seed_m23_ready_fixture(
        batch_prefix=M23_MANUAL_BATCH_PREFIX,
        firmware_version="FW-M23-ACCEPT-1.0",
        agent_version="AGENT-M23-ACCEPT-1.0",
        flash_tool_version="M23-ACCEPT-FLASHER-1.0",
        test_template_version="M2.3-MANUAL-V1",
        result_summary="M2.3 人工验收预置测试通过",
        raw_namespace="manual-acceptance",
    )


def seed_m23_browser_acceptance_fixture() -> dict[str, object]:
    return _seed_m23_ready_fixture(
        batch_prefix=M23_BROWSER_BATCH_PREFIX,
        firmware_version="FW-M23-BROWSER-1.0",
        agent_version="AGENT-M23-BROWSER-1.0",
        flash_tool_version="M23-BROWSER-FLASHER-1.0",
        test_template_version="M2.3-BROWSER-V1",
        result_summary="M2.3 浏览器端到端验收预置测试通过",
        raw_namespace="browser-acceptance",
    )


def _seed_m23_ready_fixture(
    *,
    batch_prefix: str,
    firmware_version: str,
    agent_version: str,
    flash_tool_version: str,
    test_template_version: str,
    result_summary: str,
    raw_namespace: str,
) -> dict[str, object]:
    from aishike_erp.manufacturing import TEST_TYPES
    from aishike_erp.production import record_flash, record_test
    from aishike_erp.quality import get_quality_console
    from aishike_erp.sn import generate_serials, mark_assembled

    frappe.set_user("Administrator")
    ready_devices = frappe.get_all(
        "Aishike Device Unit",
        filters={
            "production_batch": ["like", f"{batch_prefix}%"],
            "lifecycle_state": "FLASHED",
        },
        pluck="name",
        order_by="creation desc",
    )
    for serial_no in ready_devices:
        console = get_quality_console(serial_no)
        if (
            console["test_summary"]["complete"]
            and console["permissions"]["can_release"]
            and not console["quality_records"]
            and not console["stock_movements"]
        ):
            return _manual_acceptance_fixture_result(console, reused=True)

    existing_count = frappe.db.count(
        "Aishike Device Unit",
        {"production_batch": ["like", f"{batch_prefix}%"]},
    )
    production_batch = f"{batch_prefix}{existing_count + 1:03d}"
    sku_configuration = frappe.db.get_value(
        "Aishike SKU Configuration",
        {"status": "Approved", "item_code": ACCEPTANCE_FINISHED_ITEM},
        "name",
    )
    if not sku_configuration:
        frappe.throw("缺少已批准的 M2.3 人工验收 SKU")

    try:
        generated = generate_serials(
            serial_rule="ASK-DEFAULT",
            sku_configuration=sku_configuration,
            production_batch=production_batch,
            generation_date=M23_MANUAL_GENERATION_DATE,
            quantity=1,
        )
        serial_no = generated["serials"][0]
        mark_assembled(serial_no)
        record_flash(
            scan_value=serial_no,
            result="PASS",
            firmware_version=firmware_version,
            agent_version=agent_version,
            flash_tool_version=flash_tool_version,
            raw_log_ref=f"MES://{raw_namespace}/{serial_no}/flash/1",
        )
        for test_type in TEST_TYPES:
            record_test(
                scan_value=serial_no,
                test_type=test_type,
                result="PASS",
                test_template_version=test_template_version,
                result_summary=result_summary,
                raw_data_ref=f"QMS://{raw_namespace}/{serial_no}/{test_type.lower()}/1",
                measurement_json="{}",
            )

        console = get_quality_console(serial_no)
        if (
            console["device"]["lifecycle_state"] != "FLASHED"
            or not console["test_summary"]["complete"]
            or not console["permissions"]["can_release"]
            or console["quality_records"]
            or console["stock_movements"]
        ):
            frappe.throw("M2.3 人工验收样机未停在质量放行前的预期状态")
        frappe.db.commit()
        return _manual_acceptance_fixture_result(console, reused=False)
    except Exception:
        frappe.db.rollback()
        raise


def run_m23_role_permission_checks() -> dict[str, object]:
    from aishike_erp.quality import get_quality_console

    frappe.set_user("Administrator")
    test_users = _build_m23_role_test_users()
    results: dict[str, object] = {}
    try:
        _insert_transactional_role_users(test_users)

        for key, (email, _) in test_users.items():
            frappe.set_user(email)
            console = get_quality_console("ASK-000002")
            results[key] = {
                "device_read": frappe.has_permission("Aishike Device Unit", "read"),
                "quality_create": frappe.has_permission(
                    "Aishike Quality Release Record", "create"
                ),
                "stock_create": frappe.has_permission(
                    "Aishike Device Stock Movement", "create"
                ),
                "console_serial": console["device"]["serial_no"],
                "quality_records": len(console["quality_records"]),
                "stock_movements": len(console["stock_movements"]),
                "ui_permissions": console["permissions"],
            }

        expected_permissions = {
            "manufacturing": {"quality_create": False, "stock_create": False},
            "quality": {"quality_create": True, "stock_create": False},
            "stock": {"quality_create": False, "stock_create": True},
        }
        failures = {}
        for key, expected in expected_permissions.items():
            result = results[key]
            if not result["device_read"] or result["console_serial"] != "ASK-000002":
                failures[key] = result
                continue
            if result["quality_records"] < 2 or result["stock_movements"] < 2:
                failures[key] = result
                continue
            if any(result[field] is not value for field, value in expected.items()):
                failures[key] = result
                continue
            ui_permissions = result["ui_permissions"]
            if (
                ui_permissions["can_create_quality_record"] is not expected["quality_create"]
                or ui_permissions["can_create_stock_movement"] is not expected["stock_create"]
            ):
                failures[key] = result
        if failures:
            frappe.throw(f"M2.3 岗位权限验收未通过: {failures}")
        return results
    finally:
        _rollback_m23_role_test_context(test_users)


def run_m23_role_action_flow_checks() -> dict[str, object]:
    from aishike_erp.quality import (
        get_quality_console,
        record_quality_release,
        record_stock_movement,
    )

    frappe.set_user("Administrator")
    _require_m23_acceptance_warehouses()
    manual_fixture = seed_m23_manual_acceptance_fixture()
    manual_serial = manual_fixture["serial_no"]
    baseline = get_quality_console(manual_serial)
    if (
        baseline["device"]["lifecycle_state"] != "FLASHED"
        or not baseline["test_summary"]["complete"]
        or baseline["quality_records"]
        or baseline["stock_movements"]
    ):
        frappe.throw("M2.3 岗位动作验收样机不在可回滚的质量放行前状态")

    test_users = _build_m23_role_test_users()
    results: dict[str, object] = {}
    try:
        _insert_transactional_role_users(test_users)

        manufacturing_email = test_users["manufacturing"][0]
        frappe.set_user(manufacturing_email)
        manufacturing_console = get_quality_console(manual_serial)
        _expect_permission_denied(
            "制造经理创建质量判定",
            lambda: record_quality_release(
                scan_value=manual_serial,
                decision="PASS",
            ),
        )
        _expect_permission_denied(
            "制造经理创建库存凭证",
            lambda: record_stock_movement(
                scan_value=manual_serial,
                movement_type="RECEIVE",
                to_warehouse=M23_FINISHED_GOODS_WAREHOUSE,
            ),
        )
        results["manufacturing"] = {
            "console_serial": manufacturing_console["device"]["serial_no"],
            "quality_denied": True,
            "stock_denied": True,
        }

        quality_email = test_users["quality"][0]
        frappe.set_user(quality_email)
        quality_console = record_quality_release(
            scan_value=manual_serial,
            decision="PASS",
            release_summary="岗位动作验收：质量经理实际放行",
        )
        _expect_permission_denied(
            "质量经理创建库存凭证",
            lambda: record_stock_movement(
                scan_value=manual_serial,
                movement_type="RECEIVE",
                to_warehouse=M23_FINISHED_GOODS_WAREHOUSE,
            ),
        )
        if quality_console["device"]["lifecycle_state"] != "QC_PASSED":
            frappe.throw("质量经理实际放行未驱动设备进入 QC_PASSED")
        results["quality"] = {
            "lifecycle_state": quality_console["device"]["lifecycle_state"],
            "quality_records": len(quality_console["quality_records"]),
            "stock_denied": True,
        }

        stock_email = test_users["stock"][0]
        frappe.set_user(stock_email)
        _expect_permission_denied(
            "库存经理创建质量判定",
            lambda: record_quality_release(
                scan_value=manual_serial,
                decision="PASS",
            ),
        )
        received_console = record_stock_movement(
            scan_value=manual_serial,
            movement_type="RECEIVE",
            to_warehouse=M23_FINISHED_GOODS_WAREHOUSE,
            reference_type="岗位动作验收",
            reference_id="M23-ROLE-RECEIVE",
        )
        transferred_console = record_stock_movement(
            scan_value=manual_serial,
            movement_type="TRANSFER",
            to_warehouse=M23_STORES_WAREHOUSE,
            reference_type="岗位动作验收",
            reference_id="M23-ROLE-TRANSFER",
        )
        if (
            received_console["device"]["lifecycle_state"] != "STOCKED"
            or received_console["device"]["current_warehouse"]
            != M23_FINISHED_GOODS_WAREHOUSE
            or transferred_console["device"]["current_warehouse"] != M23_STORES_WAREHOUSE
            or len(transferred_console["quality_records"]) != 1
            or len(transferred_console["stock_movements"]) != 2
            or len(transferred_console["lifecycle_events"])
            < len(baseline["lifecycle_events"]) + 3
        ):
            frappe.throw("库存经理实际入库与调拨结果不符合预期")
        results["stock"] = {
            "lifecycle_state": transferred_console["device"]["lifecycle_state"],
            "current_warehouse": transferred_console["device"]["current_warehouse"],
            "stock_movements": len(transferred_console["stock_movements"]),
            "quality_denied": True,
        }
    finally:
        _rollback_m23_role_test_context(test_users)

    restored = get_quality_console(manual_serial)
    if (
        restored["device"]["lifecycle_state"] != "FLASHED"
        or not restored["test_summary"]["complete"]
        or restored["quality_records"]
        or restored["stock_movements"]
        or len(restored["lifecycle_events"]) != len(baseline["lifecycle_events"])
    ):
        frappe.throw("岗位动作验收回滚失败，人工验收样机状态被污染")
    results["rollback"] = {
        "lifecycle_state": restored["device"]["lifecycle_state"],
        "quality_records": 0,
        "stock_movements": 0,
        "temporary_users": _count_m23_role_test_users(),
    }
    if results["rollback"]["temporary_users"]:
        frappe.throw("岗位动作验收结束后仍有临时用户残留")
    return results


def run_m23_projection_integrity_checks() -> dict[str, int]:
    checked = 0
    failures: dict[str, str] = {}
    devices = frappe.get_all(
        "Aishike Device Unit",
        filters={"lifecycle_state": ["in", ["QC_PASSED", "STOCKED"]]},
        fields=[
            "name",
            "lifecycle_state",
            "quality_release_record",
            "current_warehouse",
            "latest_stock_movement",
        ],
        limit_page_length=10000,
    )
    for device in devices:
        checked += 1
        release = frappe.db.get_value(
            "Aishike Quality Release Record",
            device.quality_release_record,
            ["device_unit", "decision"],
            as_dict=True,
        )
        if not release or release.device_unit != device.name or release.decision != "PASS":
            failures[device.name] = "质量放行投影无有效通过凭证"
            continue
        if device.lifecycle_state == "STOCKED":
            movement = frappe.db.get_value(
                "Aishike Device Stock Movement",
                device.latest_stock_movement,
                ["device_unit", "to_warehouse"],
                as_dict=True,
            )
            if (
                not movement
                or movement.device_unit != device.name
                or movement.to_warehouse != device.current_warehouse
            ):
                failures[device.name] = "当前仓库投影与最近库存凭证不一致"
    if failures:
        frappe.throw(f"M2.3 设备投影完整性验收未通过: {failures}")
    return {"checked": checked, "failed": 0}


def run_m23_full_acceptance_checks() -> dict[str, object]:
    return {
        "snapshot": get_m23_acceptance_snapshot(),
        "projection_integrity": run_m23_projection_integrity_checks(),
        "negative_checks": run_m23_negative_checks(),
        "role_permissions": run_m23_role_permission_checks(),
        "role_actions": run_m23_role_action_flow_checks(),
        "temporary_users": _count_m23_role_test_users(),
    }


def seed_m3_completed_acceptance_fixture() -> dict[str, object]:
    from aishike_erp.fulfillment import record_fulfillment_action

    frappe.set_user("Administrator")
    fixture = _seed_m3_order_fixture(
        batch_prefix=M3_COMPLETED_BATCH_PREFIX,
        external_order_id=M3_COMPLETED_EXTERNAL_ORDER,
    )
    serial_no = fixture["serial_no"]
    order_name = fixture["order_name"]
    created_actions: list[str] = []
    try:
        state = frappe.db.get_value("Aishike Device Unit", serial_no, "lifecycle_state")
        if state == "STOCKED":
            record_fulfillment_action(
                channel_order=order_name,
                scan_value=serial_no,
                action="ALLOCATE",
                source_record_id="M3-AUTO-ALLOCATE-001",
                remarks="M3 自动验收设备分配",
            )
            created_actions.append("ALLOCATED")
            state = "ALLOCATED"
        if state == "ALLOCATED":
            record_fulfillment_action(
                channel_order=order_name,
                scan_value=serial_no,
                action="SHIP",
                logistics_carrier="顺丰",
                tracking_no="SF-M3-AUTO-001",
                source_record_id="M3-AUTO-SHIP-001",
                remarks="M3 自动验收发货",
            )
            created_actions.append("SHIPPED")
            state = "SHIPPED"
        if state == "SHIPPED":
            console = record_fulfillment_action(
                channel_order=order_name,
                scan_value=serial_no,
                action="ACTIVATE",
                activation_ref="IOT-ACT-M3-AUTO-001",
                customer_ref="CUSTOMER-HASH-M3-AUTO-001",
                source_record_id="M3-AUTO-ACTIVATE-001",
                remarks="M3 自动验收激活",
            )
            created_actions.append("ACTIVATED")
        else:
            from aishike_erp.fulfillment import get_fulfillment_console

            console = get_fulfillment_console(order_name)
        _assert_completed_m3_console(console, serial_no)
        frappe.db.commit()
        return {
            "serial_no": serial_no,
            "order_name": order_name,
            "order_status": console["order"]["order_status"],
            "lifecycle_state": console["devices"][0]["lifecycle_state"],
            "created_actions": created_actions,
            "reused": not created_actions,
            "route": "/desk/aishike-fulfillment-console",
        }
    except Exception:
        frappe.db.rollback()
        raise


def seed_m3_manual_acceptance_fixture() -> dict[str, object]:
    return _seed_m3_manual_fixture(
        batch_prefix=M3_MANUAL_BATCH_PREFIX,
        external_order_id=M3_MANUAL_EXTERNAL_ORDER,
    )


def seed_m3_browser_acceptance_fixture() -> dict[str, object]:
    return _seed_m3_manual_fixture(
        batch_prefix=M3_BROWSER_BATCH_PREFIX,
        external_order_id=M3_BROWSER_EXTERNAL_ORDER,
    )


def run_m3_negative_checks() -> dict[str, str]:
    from aishike_erp.fulfillment import (
        create_channel_order,
        record_fulfillment_action,
    )

    frappe.set_user("Administrator")
    fixture = _seed_m3_order_fixture(
        batch_prefix=M3_NEGATIVE_BATCH_PREFIX,
        external_order_id=M3_NEGATIVE_EXTERNAL_ORDER,
    )
    order_name = fixture["order_name"]
    serial_no = fixture["serial_no"]
    mapping_name = fixture["mapping_name"]
    results: dict[str, str] = {}

    duplicate = create_channel_order(
        channel=M3_CHANNEL,
        channel_scope=M3_CHANNEL_SCOPE,
        external_order_id=M3_NEGATIVE_EXTERNAL_ORDER,
        channel_sku_mapping=mapping_name,
        order_quantity=1,
        recipient_ref=f"RECIPIENT-HASH-{M3_NEGATIVE_EXTERNAL_ORDER}",
    )
    if not duplicate.get("reused") or duplicate["order"]["name"] != order_name:
        frappe.throw("重复渠道订单没有幂等返回原订单")
    results["duplicate_order_idempotency"] = "PASS"

    def capture(label: str, expected_text: str, action) -> None:
        try:
            action()
        except Exception as error:
            message = str(error).splitlines()[0]
            if expected_text not in message:
                frappe.db.rollback()
                frappe.throw(f"{label}返回了非预期错误: {message}")
            results[label] = message
        else:
            frappe.db.rollback()
            frappe.throw(f"{label}未被业务规则阻止")
        finally:
            frappe.set_user("Administrator")
            frappe.db.rollback()

    capture(
        "duplicate_order_conflict",
        "冲突",
        lambda: create_channel_order(
            channel=M3_CHANNEL,
            channel_scope=M3_CHANNEL_SCOPE,
            external_order_id=M3_NEGATIVE_EXTERNAL_ORDER,
            channel_sku_mapping=mapping_name,
            order_quantity=2,
            recipient_ref=f"RECIPIENT-HASH-{M3_NEGATIVE_EXTERNAL_ORDER}",
        ),
    )

    def wrong_sku() -> None:
        frappe.db.set_value("Aishike Channel Order", order_name, "sku_configuration", "MISMATCH-SKU")
        record_fulfillment_action(order_name, serial_no, "ALLOCATE")

    capture("wrong_sku_allocate", "SKU 不一致", wrong_sku)

    def non_stocked() -> None:
        frappe.db.set_value("Aishike Device Unit", serial_no, "lifecycle_state", "FLASHED")
        record_fulfillment_action(order_name, serial_no, "ALLOCATE")

    capture("non_stocked_allocate", "只有在库设备", non_stocked)

    def full_order() -> None:
        frappe.db.set_value("Aishike Channel Order", order_name, "allocated_count", 1)
        record_fulfillment_action(order_name, serial_no, "ALLOCATE")

    capture("over_quantity_allocate", "达到设备分配数量", full_order)

    def unallocated_ship() -> None:
        frappe.db.set_value(
            "Aishike Device Unit",
            serial_no,
            {"channel_order_id": order_name, "current_channel": M3_CHANNEL},
        )
        record_fulfillment_action(
            order_name,
            serial_no,
            "SHIP",
            logistics_carrier="顺丰",
            tracking_no="SF-M3-NEG-001",
        )

    capture("unallocated_ship", "先完成订单分配", unallocated_ship)

    def missing_logistics() -> None:
        record_fulfillment_action(order_name, serial_no, "ALLOCATE")
        record_fulfillment_action(order_name, serial_no, "SHIP")

    capture("missing_logistics", "物流承运商", missing_logistics)

    def unshipped_activate() -> None:
        record_fulfillment_action(order_name, serial_no, "ALLOCATE")
        record_fulfillment_action(
            order_name,
            serial_no,
            "ACTIVATE",
            activation_ref="IOT-ACT-M3-NEG-001",
        )

    capture("unshipped_activate", "完成发货", unshipped_activate)

    capture(
        "recipient_pii",
        "直接个人信息",
        lambda: create_channel_order(
            channel=M3_CHANNEL,
            channel_scope=M3_CHANNEL_SCOPE,
            external_order_id=f"M3-PII-{frappe.generate_hash(length=8).upper()}",
            channel_sku_mapping=mapping_name,
            order_quantity=1,
            recipient_ref="parent@example.com",
        ),
    )

    capture(
        "raw_payload_pii",
        "直接个人信息",
        lambda: create_channel_order(
            channel=M3_CHANNEL,
            channel_scope=M3_CHANNEL_SCOPE,
            external_order_id=f"M3-RAW-PII-{frappe.generate_hash(length=8).upper()}",
            channel_sku_mapping=mapping_name,
            order_quantity=1,
            recipient_ref="RECIPIENT-HASH-M3-RAW-PII",
            raw_payload_ref="OMS://orders/parent@example.com",
        ),
    )

    def activation_pii() -> None:
        record_fulfillment_action(order_name, serial_no, "ALLOCATE")
        record_fulfillment_action(
            order_name,
            serial_no,
            "SHIP",
            logistics_carrier="顺丰",
            tracking_no="SF-M3-NEG-002",
        )
        record_fulfillment_action(
            order_name,
            serial_no,
            "ACTIVATE",
            activation_ref="13800138000",
        )

    capture("activation_pii", "直接个人信息", activation_pii)

    def customer_pii() -> None:
        record_fulfillment_action(order_name, serial_no, "ALLOCATE")
        record_fulfillment_action(
            order_name,
            serial_no,
            "SHIP",
            logistics_carrier="顺丰",
            tracking_no="SF-M3-NEG-003",
        )
        record_fulfillment_action(
            order_name,
            serial_no,
            "ACTIVATE",
            activation_ref="IOT-ACT-M3-NEG-003",
            customer_ref="parent@example.com",
        )

    capture("customer_pii", "直接个人信息", customer_pii)

    completed = seed_m3_completed_acceptance_fixture()
    record_name = frappe.db.get_value(
        "Aishike Device Fulfillment Record",
        {"device_unit": completed["serial_no"], "action": "ALLOCATE"},
        "name",
    )

    def edit_record() -> None:
        record = frappe.get_doc("Aishike Device Fulfillment Record", record_name)
        record.remarks = "试图覆盖履约凭证"
        record.save()

    capture("immutable_record_update", "不可修改", edit_record)
    capture(
        "immutable_record_delete",
        "不可删除",
        lambda: frappe.delete_doc("Aishike Device Fulfillment Record", record_name),
    )

    def direct_allocated() -> None:
        device = frappe.get_doc("Aishike Device Unit", serial_no)
        device.lifecycle_state = "ALLOCATED"
        device.save()

    capture("direct_allocated", "ALLOCATE", direct_allocated)

    def direct_shipped() -> None:
        record_fulfillment_action(order_name, serial_no, "ALLOCATE")
        device = frappe.get_doc("Aishike Device Unit", serial_no)
        device.lifecycle_state = "SHIPPED"
        device.save()

    capture("direct_shipped", "SHIP", direct_shipped)

    def direct_activated() -> None:
        record_fulfillment_action(order_name, serial_no, "ALLOCATE")
        record_fulfillment_action(
            order_name,
            serial_no,
            "SHIP",
            logistics_carrier="顺丰",
            tracking_no="SF-M3-NEG-004",
        )
        device = frappe.get_doc("Aishike Device Unit", serial_no)
        device.lifecycle_state = "ACTIVATED"
        device.activation_ref = "IOT-ACT-M3-DIRECT"
        device.save()

    capture("direct_activated", "ACTIVATE", direct_activated)
    return results


def run_m3_role_permission_checks() -> dict[str, object]:
    from aishike_erp.fulfillment import get_fulfillment_console

    frappe.set_user("Administrator")
    fixture = _seed_m3_order_fixture(
        batch_prefix=M3_NEGATIVE_BATCH_PREFIX,
        external_order_id=M3_NEGATIVE_EXTERNAL_ORDER,
    )
    test_users = _build_m3_role_test_users()
    results: dict[str, object] = {}
    try:
        _insert_transactional_role_users(test_users)
        for key, (email, _) in test_users.items():
            frappe.set_user(email)
            console = get_fulfillment_console(fixture["order_name"])
            permissions = console["setup"]["permissions"]
            results[key] = {
                "mapping_create": frappe.has_permission(
                    "Aishike Channel SKU Mapping", "create"
                ),
                "order_create": frappe.has_permission("Aishike Channel Order", "create"),
                "fulfillment_create": frappe.has_permission(
                    "Aishike Device Fulfillment Record", "create"
                ),
                "can_allocate_ship": permissions["can_allocate_ship"],
                "can_activate": permissions["can_activate"],
                "console_order": console["order"]["name"],
            }

        expected = {
            "sales": (True, True, False, False, False),
            "stock": (False, False, True, True, False),
            "manufacturing": (False, False, False, False, False),
            "quality": (False, False, False, False, False),
            "system": (True, True, True, False, True),
        }
        failures = {}
        for key, values in expected.items():
            result = results[key]
            actual = (
                result["mapping_create"],
                result["order_create"],
                result["fulfillment_create"],
                result["can_allocate_ship"],
                result["can_activate"],
            )
            if actual != values or result["console_order"] != fixture["order_name"]:
                failures[key] = result
        if failures:
            frappe.throw(f"M3 岗位权限验收未通过: {failures}")
        return results
    finally:
        _rollback_m23_role_test_context(test_users)


def run_m3_role_action_flow_checks() -> dict[str, object]:
    from aishike_erp.fulfillment import (
        create_channel_mapping,
        create_channel_order,
        get_fulfillment_console,
        record_fulfillment_action,
    )

    frappe.set_user("Administrator")
    fixture = _seed_m3_order_fixture(
        batch_prefix=M3_ROLE_BATCH_PREFIX,
        external_order_id=M3_ROLE_EXTERNAL_ORDER,
    )
    test_users = _build_m3_role_test_users()
    suffix = frappe.generate_hash(length=8).upper()
    results: dict[str, object] = {}
    try:
        _insert_transactional_role_users(test_users)
        sales_email = test_users["sales"][0]
        stock_email = test_users["stock"][0]
        manufacturing_email = test_users["manufacturing"][0]
        quality_email = test_users["quality"][0]
        system_email = test_users["system"][0]

        frappe.set_user(sales_email)
        sales_mapping = create_channel_mapping(
            channel="DEALER",
            channel_scope=f"ROLE-{suffix}",
            external_sku=f"ROLE-SKU-{suffix}",
            sku_configuration=fixture["sku_configuration"],
        )
        sales_order = create_channel_order(
            channel="DEALER",
            channel_scope=f"ROLE-{suffix}",
            external_order_id=f"ROLE-ORDER-{suffix}",
            channel_sku_mapping=sales_mapping["mapping"]["name"],
            order_quantity=1,
            recipient_ref=f"RECIPIENT-HASH-ROLE-{suffix}",
        )
        _expect_permission_denied(
            "销售岗位执行设备分配",
            lambda: record_fulfillment_action(
                fixture["order_name"], fixture["serial_no"], "ALLOCATE"
            ),
        )
        results["sales"] = {
            "mapping_created": sales_mapping["mapping"]["name"],
            "order_created": sales_order["order"]["name"],
            "fulfillment_denied": True,
        }

        for label, email in (
            ("生产岗位", manufacturing_email),
            ("质量岗位", quality_email),
        ):
            frappe.set_user(email)
            console = get_fulfillment_console(fixture["order_name"])
            _expect_permission_denied(
                f"{label}执行设备分配",
                lambda: record_fulfillment_action(
                    fixture["order_name"], fixture["serial_no"], "ALLOCATE"
                ),
            )
            results[label] = {
                "order_read": console["order"]["name"],
                "fulfillment_denied": True,
            }

        frappe.set_user(system_email)
        _expect_permission_denied(
            "系统管理员执行仓库分配",
            lambda: record_fulfillment_action(
                fixture["order_name"], fixture["serial_no"], "ALLOCATE"
            ),
        )

        frappe.set_user(stock_email)
        _expect_permission_denied(
            "仓库岗位创建渠道映射",
            lambda: create_channel_mapping(
                channel="JD",
                channel_scope=f"ROLE-{suffix}",
                external_sku=f"ROLE-STOCK-SKU-{suffix}",
                sku_configuration=fixture["sku_configuration"],
            ),
        )
        _expect_permission_denied(
            "仓库岗位创建渠道订单",
            lambda: create_channel_order(
                channel=M3_CHANNEL,
                channel_scope=M3_CHANNEL_SCOPE,
                external_order_id=f"ROLE-STOCK-ORDER-{suffix}",
                channel_sku_mapping=fixture["mapping_name"],
                order_quantity=1,
            ),
        )
        allocated = record_fulfillment_action(
            channel_order=fixture["order_name"],
            scan_value=f"ASK:DEVICE:{fixture['serial_no']}",
            action="ALLOCATE",
            source_record_id=f"ROLE-ALLOCATE-{suffix}",
        )
        if allocated["order"]["order_status"] != "ALLOCATED":
            frappe.throw("仓库岗位未能完成扫码设备分配")

        frappe.set_user(system_email)
        _expect_permission_denied(
            "系统管理员执行仓库发货",
            lambda: record_fulfillment_action(
                fixture["order_name"],
                fixture["serial_no"],
                "SHIP",
                logistics_carrier="顺丰",
                tracking_no=f"SF-ROLE-{suffix}",
            ),
        )

        frappe.set_user(stock_email)
        shipped = record_fulfillment_action(
            channel_order=fixture["order_name"],
            scan_value=fixture["serial_no"],
            action="SHIP",
            logistics_carrier="顺丰",
            tracking_no=f"SF-ROLE-{suffix}",
            source_record_id=f"ROLE-SHIP-{suffix}",
        )
        if shipped["order"]["order_status"] != "SHIPPED":
            frappe.throw("仓库岗位未能完成设备发货")
        _expect_permission_denied(
            "仓库岗位执行设备激活",
            lambda: record_fulfillment_action(
                fixture["order_name"],
                fixture["serial_no"],
                "ACTIVATE",
                activation_ref=f"IOT-ROLE-{suffix}",
            ),
        )
        results["stock"] = {
            "allocated": allocated["order"]["allocated_count"],
            "shipped": shipped["order"]["shipped_count"],
            "activation_denied": True,
        }

        frappe.set_user(system_email)
        activated = record_fulfillment_action(
            channel_order=fixture["order_name"],
            scan_value=fixture["serial_no"],
            action="ACTIVATE",
            activation_ref=f"IOT-ROLE-{suffix}",
            customer_ref=f"CUSTOMER-HASH-ROLE-{suffix}",
            source_record_id=f"ROLE-ACTIVATE-{suffix}",
        )
        device_state = activated["devices"][0]["lifecycle_state"]
        if activated["order"]["order_status"] != "ACTIVATED" or device_state != "ACTIVATED":
            frappe.throw("系统管理员未能完成设备激活")
        results["system"] = {
            "warehouse_actions_denied": True,
            "activated": activated["order"]["activated_count"],
            "device_state": device_state,
        }
        return results
    finally:
        _rollback_m23_role_test_context(test_users)


def run_m3_projection_integrity_checks() -> dict[str, object]:
    from aishike_erp.fulfillment_projection import refresh_order_projection

    completed = seed_m3_completed_acceptance_fixture()
    order_name = completed["order_name"]
    serial_no = completed["serial_no"]
    order = frappe.db.get_value(
        "Aishike Channel Order",
        order_name,
        [
            "name",
            "channel_sku_mapping",
            "order_status",
            "allocated_count",
            "shipped_count",
            "activated_count",
        ],
        as_dict=True,
    )
    device = frappe.db.get_value(
        "Aishike Device Unit",
        serial_no,
        [
            "lifecycle_state",
            "current_warehouse",
            "latest_stock_movement",
            "latest_fulfillment_record",
            "channel_order_id",
            "logistics_carrier",
            "tracking_no",
            "activation_ref",
            "current_customer_ref",
        ],
        as_dict=True,
    )
    records = frappe.get_all(
        "Aishike Device Fulfillment Record",
        filters={"channel_order": order_name, "device_unit": serial_no},
        fields=["name", "action", "operation_warehouse"],
        order_by="action_no asc",
    )
    actions = [row.action for row in records]
    failures: list[str] = []
    if not re.fullmatch(r"ASK-ORD-\d{5}", order.name or ""):
        failures.append("渠道订单 autoname 不符合 ASK-ORD-#####")
    if (
        order.order_status != "ACTIVATED"
        or [order.allocated_count, order.shipped_count, order.activated_count] != [1, 1, 1]
    ):
        failures.append("渠道订单履约进度投影不一致")
    if actions != ["ALLOCATE", "SHIP", "ACTIVATE"]:
        failures.append("设备履约凭证顺序不一致")
    if (
        device.lifecycle_state != "ACTIVATED"
        or device.current_warehouse
        or device.channel_order_id != order_name
        or device.latest_fulfillment_record != records[-1].name
        or not device.latest_stock_movement
        or not device.logistics_carrier
        or not device.tracking_no
        or not device.activation_ref
        or not device.current_customer_ref
    ):
        failures.append("设备履约投影不完整")
    if records[1].operation_warehouse != M23_STORES_WAREHOUSE:
        failures.append("发货凭证未保留实际出库仓库")
    event_types = frappe.get_all(
        "Aishike Device Lifecycle Event",
        filters={"device_unit": serial_no},
        pluck="event_type",
    )
    if not {"ALLOCATED", "SHIPPED", "ACTIVATED"}.issubset(set(event_types)):
        failures.append("设备生命周期事件缺少 M3 履约节点")

    try:
        frappe.db.set_value(
            "Aishike Channel SKU Mapping", order.channel_sku_mapping, "status", "DISABLED"
        )
        projection = refresh_order_projection(order_name)
        if projection["order_status"] != "ACTIVATED":
            failures.append("映射停用后历史订单投影刷新失败")
    except Exception as error:
        failures.append(f"映射停用后历史订单不可继续履约: {str(error).splitlines()[0]}")
    finally:
        frappe.db.rollback()

    if failures:
        frappe.throw(f"M3 投影完整性验收未通过: {failures}")
    return {
        "order_name": order_name,
        "serial_no": serial_no,
        "actions": actions,
        "events": sorted(set(event_types) & {"ALLOCATED", "SHIPPED", "ACTIVATED"}),
        "failed": 0,
    }


def run_m3_full_acceptance_checks() -> dict[str, object]:
    completed = seed_m3_completed_acceptance_fixture()
    return {
        "runtime": assert_runtime_check(),
        "completed_fixture": completed,
        "projection_integrity": run_m3_projection_integrity_checks(),
        "negative_checks": run_m3_negative_checks(),
        "role_permissions": run_m3_role_permission_checks(),
        "role_actions": run_m3_role_action_flow_checks(),
        "temporary_users": _count_m3_role_test_users(),
    }


def _seed_m3_order_fixture(*, batch_prefix: str, external_order_id: str) -> dict[str, str]:
    from aishike_erp.fulfillment import create_channel_mapping, create_channel_order

    frappe.set_user("Administrator")
    sku_configuration = frappe.db.get_value(
        "Aishike SKU Configuration",
        {"status": "Approved", "item_code": ACCEPTANCE_FINISHED_ITEM},
        "name",
    )
    if not sku_configuration:
        frappe.throw("缺少已批准的 M3 验收 SKU")
    mapping_result = create_channel_mapping(
        channel=M3_CHANNEL,
        channel_scope=M3_CHANNEL_SCOPE,
        external_sku=M3_EXTERNAL_SKU,
        sku_configuration=sku_configuration,
    )
    mapping_name = mapping_result["mapping"]["name"]
    order_key = f"{M3_CHANNEL}|{M3_CHANNEL_SCOPE}|{external_order_id}"
    order_name = frappe.db.get_value(
        "Aishike Channel Order", {"external_order_key": order_key}, "name"
    )
    serial_no = None
    if order_name:
        serial_no = frappe.db.get_value(
            "Aishike Device Unit", {"channel_order_id": order_name}, "name"
        )
    if not serial_no:
        serial_no = _ensure_m3_stocked_device(batch_prefix)
    order_result = create_channel_order(
        channel=M3_CHANNEL,
        channel_scope=M3_CHANNEL_SCOPE,
        external_order_id=external_order_id,
        channel_sku_mapping=mapping_name,
        order_quantity=1,
        recipient_ref=f"RECIPIENT-HASH-{external_order_id}",
        raw_payload_ref=f"OMS://M3-ACCEPTANCE/{external_order_id}",
    )
    order_name = order_result["order"]["name"]
    frappe.db.commit()
    return {
        "serial_no": serial_no,
        "order_name": order_name,
        "mapping_name": mapping_name,
        "sku_configuration": sku_configuration,
    }


def _ensure_m3_stocked_device(batch_prefix: str) -> str:
    from aishike_erp.quality import record_quality_release, record_stock_movement

    existing = frappe.get_all(
        "Aishike Device Unit",
        filters={"production_batch": ["like", f"{batch_prefix}%"]},
        fields=["name", "lifecycle_state", "current_warehouse", "channel_order_id"],
        order_by="creation asc",
        limit_page_length=1,
    )
    if existing:
        device = existing[0]
    else:
        ready = _seed_m23_ready_fixture(
            batch_prefix=batch_prefix,
            firmware_version="M3-ACCEPTANCE-FW-1.0.0",
            agent_version="M3-ACCEPTANCE-AI-1.0.0",
            flash_tool_version="M3-ACCEPTANCE-FLASH-1.0.0",
            test_template_version="M3-ACCEPTANCE-V1",
            result_summary="M3 渠道履约验收预置六项测试通过",
            raw_namespace="M3-ACCEPTANCE",
        )
        device = frappe._dict(
            name=ready["serial_no"],
            lifecycle_state=ready["lifecycle_state"],
            current_warehouse=None,
            channel_order_id=None,
        )

    try:
        if device.lifecycle_state == "FLASHED":
            console = record_quality_release(
                scan_value=device.name,
                decision="PASS",
                checklist_version="M3-ACCEPTANCE-V1",
                release_summary="M3 渠道履约验收质量放行通过",
            )
            device.lifecycle_state = console["device"]["lifecycle_state"]
        if device.lifecycle_state == "QC_PASSED":
            console = record_stock_movement(
                scan_value=device.name,
                movement_type="RECEIVE",
                to_warehouse=M23_STORES_WAREHOUSE,
                reference_type="M3 验收成品入库",
                reference_id=f"M3-RECEIVE-{device.name}",
            )
            device.lifecycle_state = console["device"]["lifecycle_state"]
            device.current_warehouse = console["device"]["current_warehouse"]
        if (
            device.lifecycle_state == "STOCKED"
            and device.current_warehouse != M23_STORES_WAREHOUSE
            and not device.channel_order_id
        ):
            console = record_stock_movement(
                scan_value=device.name,
                movement_type="TRANSFER",
                to_warehouse=M23_STORES_WAREHOUSE,
                reference_type="M3 验收库存归位",
                reference_id=f"M3-TRANSFER-{device.name}",
            )
            device.current_warehouse = console["device"]["current_warehouse"]
        if device.lifecycle_state not in {"STOCKED", "ALLOCATED", "SHIPPED", "ACTIVATED"}:
            frappe.throw(
                f"M3 验收设备 {device.name} 状态异常: {device.lifecycle_state}"
            )
        frappe.db.commit()
        return device.name
    except Exception:
        frappe.db.rollback()
        raise


def _seed_m3_manual_fixture(*, batch_prefix: str, external_order_id: str) -> dict[str, object]:
    from aishike_erp.fulfillment import get_fulfillment_console

    fixture = _seed_m3_order_fixture(
        batch_prefix=batch_prefix,
        external_order_id=external_order_id,
    )
    console = get_fulfillment_console(fixture["order_name"])
    device = frappe.db.get_value(
        "Aishike Device Unit",
        fixture["serial_no"],
        ["name", "lifecycle_state", "current_warehouse", "production_batch"],
        as_dict=True,
    )
    return {
        "serial_no": device.name,
        "production_batch": device.production_batch,
        "lifecycle_state": device.lifecycle_state,
        "current_warehouse": device.current_warehouse,
        "order_name": console["order"]["name"],
        "external_order_id": console["order"]["external_order_id"],
        "order_status": console["order"]["order_status"],
        "mapping_name": fixture["mapping_name"],
        "route": "/desk/aishike-fulfillment-console",
    }


def _assert_completed_m3_console(console: dict[str, object], serial_no: str) -> None:
    devices = [row for row in console["devices"] if row["name"] == serial_no]
    actions = [
        row["action"]
        for row in reversed(console["records"])
        if row["device_unit"] == serial_no
    ]
    if (
        console["order"]["order_status"] != "ACTIVATED"
        or console["order"]["allocated_count"] != 1
        or console["order"]["shipped_count"] != 1
        or console["order"]["activated_count"] != 1
        or len(devices) != 1
        or devices[0]["lifecycle_state"] != "ACTIVATED"
        or devices[0]["current_warehouse"]
        or actions != ["ALLOCATE", "SHIP", "ACTIVATE"]
    ):
        frappe.throw("M3 完整验收样本未达到分配、发货、激活闭环")


def _build_m3_role_test_users() -> dict[str, tuple[str, str]]:
    suffix = frappe.generate_hash(length=6).lower()
    return {
        "sales": (f"m3-sales-{suffix}@test.local", "Sales Manager"),
        "stock": (f"m3-stock-{suffix}@test.local", "Stock Manager"),
        "manufacturing": (
            f"m3-manufacturing-{suffix}@test.local",
            "Manufacturing Manager",
        ),
        "quality": (f"m3-quality-{suffix}@test.local", "Quality Manager"),
        "system": (f"m3-system-{suffix}@test.local", "System Manager"),
    }


def _count_m3_role_test_users() -> int:
    return frappe.db.count("User", {"name": ["like", "m3-%@test.local"]})


def cleanup_m23_role_test_failures() -> dict[str, int]:
    from rq.job import Job

    from frappe.utils.background_jobs import get_queues

    scanned = 0
    removed = 0
    for queue in get_queues():
        registry = queue.failed_job_registry
        for job_id in registry.get_job_ids():
            scanned += 1
            job = Job.fetch(job_id, connection=queue.connection)
            payload = str(job.kwargs)
            if "m23-" not in payload or "@test.local" not in payload:
                continue
            registry.remove(job, delete_job=True)
            removed += 1
    return {"scanned": scanned, "removed": removed}


def _build_m23_role_test_users() -> dict[str, tuple[str, str]]:
    suffix = frappe.generate_hash(length=6).lower()
    return {
        "manufacturing": (f"m23-manufacturing-{suffix}@test.local", "Manufacturing Manager"),
        "quality": (f"m23-quality-{suffix}@test.local", "Quality Manager"),
        "stock": (f"m23-stock-{suffix}@test.local", "Stock Manager"),
    }


def _insert_transactional_role_users(test_users: dict[str, tuple[str, str]]) -> None:
    for email, role in test_users.values():
        now = frappe.utils.now_datetime()
        frappe.db.sql(
            """
            insert into `tabUser`
                (name, creation, modified, modified_by, owner, docstatus, idx,
                 enabled, email, first_name, full_name, send_welcome_email, user_type)
            values (%s, %s, %s, 'Administrator', 'Administrator', 0, 0,
                    1, %s, '阶段验收', '阶段验收', 0, 'System User')
            """,
            (email, now, now, email),
        )
        frappe.db.sql(
            """
            insert into `tabHas Role`
                (name, creation, modified, modified_by, owner, docstatus, idx,
                 role, parent, parentfield, parenttype)
            values (%s, %s, %s, 'Administrator', 'Administrator', 0, 1,
                    %s, %s, 'roles', 'User')
            """,
            (frappe.generate_hash(length=10), now, now, role, email),
        )
        frappe.clear_cache(user=email)


def _rollback_m23_role_test_context(test_users: dict[str, tuple[str, str]]) -> None:
    frappe.set_user("Administrator")
    for email, _ in test_users.values():
        frappe.clear_cache(user=email)
    frappe.db.rollback()


def _expect_permission_denied(label: str, action) -> None:
    try:
        action()
    except frappe.PermissionError:
        return
    except Exception as error:
        frappe.throw(f"{label}返回了非权限错误: {str(error).splitlines()[0]}")
    frappe.throw(f"{label}未被权限系统阻止")


def _require_m23_acceptance_warehouses() -> None:
    missing = [
        warehouse
        for warehouse in (M23_FINISHED_GOODS_WAREHOUSE, M23_STORES_WAREHOUSE)
        if not frappe.db.exists("Warehouse", warehouse)
    ]
    if missing:
        frappe.throw(f"缺少 M2.3 验收仓库: {', '.join(missing)}")


def _assert_completed_m23_console(console: dict[str, object]) -> None:
    decisions = {row["decision"] for row in console["quality_records"]}
    movement_types = {row["movement_type"] for row in console["stock_movements"]}
    if (
        console["device"]["lifecycle_state"] != "STOCKED"
        or console["device"]["current_warehouse"] != M23_STORES_WAREHOUSE
        or not {"REJECT", "PASS"}.issubset(decisions)
        or not {"RECEIVE", "TRANSFER"}.issubset(movement_types)
    ):
        frappe.throw("M2.3 完整验收样本未达到驳回、放行、入库和调拨闭环")


def _count_m23_role_test_users() -> int:
    return frappe.db.count("User", {"name": ["like", "m23-%@test.local"]})


def _manual_acceptance_fixture_result(
    console: dict[str, object], *, reused: bool
) -> dict[str, object]:
    device = console["device"]
    return {
        "serial_no": device["serial_no"],
        "production_batch": device["production_batch"],
        "lifecycle_state": device["lifecycle_state"],
        "tests_passed": console["test_summary"]["passed"],
        "tests_total": console["test_summary"]["total"],
        "quality_records": len(console["quality_records"]),
        "stock_movements": len(console["stock_movements"]),
        "can_release": console["permissions"]["can_release"],
        "reused": reused,
        "route": "/desk/aishike-quality-console",
    }


def _ensure_item(item_code: str, item_name: str, item_group: str) -> None:
    if frappe.db.exists("Item", item_code):
        return

    frappe.get_doc(
        {
            "doctype": "Item",
            "item_code": item_code,
            "item_name": item_name,
            "item_group": item_group,
            "stock_uom": "Nos",
            "is_stock_item": 1,
        }
    ).insert(ignore_permissions=True)
