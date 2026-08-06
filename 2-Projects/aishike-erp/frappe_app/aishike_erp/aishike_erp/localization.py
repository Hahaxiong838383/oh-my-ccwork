from __future__ import annotations

import json

import frappe

from aishike_erp.phase_gate import (
    M2_ALLOWED_EVENT_TYPES,
    M23_DEVICE_COLUMNS,
    M23_FIXTURE_BATCH_PREFIX,
    M23_ORPHAN_DOCTYPES,
    derive_m2_device_state,
)


SIDEBAR_LABELS = {
    "Home": "主页",
    "SKU Configuration": "SKU 配置",
    "SN Console": "SN 工作台",
    "Production Console": "生产测试",
    "Device Units": "设备档案",
    "Device Tests": "设备测试",
}

WORKSPACE_SHORTCUT_LABELS = {
    "Aishike SKU Configuration": "SKU 配置",
    "aishike-sn-console": "SN 工作台",
    "aishike-production-console": "生产测试",
    "Aishike Device Unit": "设备档案",
    "Aishike Device Test Record": "设备测试",
}

M23_NAVIGATION_TARGETS = {
    "aishike-quality-console",
    "Aishike Quality Release Record",
    "Aishike Device Stock Movement",
}

WORKSPACE_CONTENT = [
    {
        "id": "header-masters",
        "type": "header",
        "data": {"text": '<span class="h4"><b>产品与设备主数据</b></span>', "col": 12},
    },
    {
        "id": "shortcut-sku",
        "type": "shortcut",
        "data": {"shortcut_name": "SKU 配置", "col": 4},
    },
    {
        "id": "shortcut-sn",
        "type": "shortcut",
        "data": {"shortcut_name": "SN 工作台", "col": 4},
    },
    {
        "id": "shortcut-device",
        "type": "shortcut",
        "data": {"shortcut_name": "设备档案", "col": 4},
    },
    {
        "id": "shortcut-production",
        "type": "shortcut",
        "data": {"shortcut_name": "生产测试", "col": 4},
    },
    {
        "id": "shortcut-test",
        "type": "shortcut",
        "data": {"shortcut_name": "设备测试", "col": 4},
    },
]


def apply_chinese_defaults() -> dict[str, str]:
    phase_cleanup = cleanup_m23_artifacts()

    if frappe.db.exists("Language", "zh"):
        frappe.db.set_value("Language", "zh", "enabled", 1)

    system_settings = frappe.get_single("System Settings")
    system_settings.language = "zh"
    system_settings.save(ignore_permissions=True)

    administrator = frappe.get_doc("User", "Administrator")
    administrator.first_name = "系统管理员"
    administrator.last_name = ""
    administrator.language = "zh"
    administrator.default_workspace = "Aishike ERP"
    administrator.save(ignore_permissions=True)

    if frappe.db.exists("Workspace Sidebar", "Aishike ERP"):
        sidebar = frappe.get_doc("Workspace Sidebar", "Aishike ERP")
        sidebar.title = "爱视可 ERP"
        sidebar.set(
            "items",
            [item for item in sidebar.items if item.link_to not in M23_NAVIGATION_TARGETS],
        )
        for item in sidebar.items:
            item.label = SIDEBAR_LABELS.get(item.label, item.label)
        if not any(item.link_to == "aishike-sn-console" for item in sidebar.items):
            sidebar.append(
                "items",
                {
                    "type": "Link",
                    "label": "SN 工作台",
                    "link_type": "Page",
                    "link_to": "aishike-sn-console",
                },
            )
        if not any(item.link_to == "aishike-production-console" for item in sidebar.items):
            sidebar.append(
                "items",
                {
                    "type": "Link",
                    "label": "生产测试",
                    "link_type": "Page",
                    "link_to": "aishike-production-console",
                },
            )
        sidebar.save(ignore_permissions=True)

    if frappe.db.exists("Workspace", "Aishike ERP"):
        workspace = frappe.get_doc("Workspace", "Aishike ERP")
        workspace.type = "Workspace"
        workspace.label = "Aishike ERP"
        workspace.title = "Aishike ERP"
        workspace.content = json.dumps(WORKSPACE_CONTENT, ensure_ascii=False, separators=(",", ":"))
        workspace.set(
            "shortcuts",
            [
                shortcut
                for shortcut in workspace.shortcuts
                if shortcut.link_to not in M23_NAVIGATION_TARGETS
            ],
        )
        if not any(shortcut.link_to == "aishike-sn-console" for shortcut in workspace.shortcuts):
            workspace.append(
                "shortcuts",
                {
                    "type": "Page",
                    "link_to": "aishike-sn-console",
                    "label": "SN 工作台",
                    "color": "Blue",
                },
            )
        if not any(
            shortcut.link_to == "aishike-production-console" for shortcut in workspace.shortcuts
        ):
            workspace.append(
                "shortcuts",
                {
                    "type": "Page",
                    "link_to": "aishike-production-console",
                    "label": "生产测试",
                    "color": "Orange",
                },
            )
        for shortcut in workspace.shortcuts:
            shortcut.label = WORKSPACE_SHORTCUT_LABELS.get(shortcut.link_to, shortcut.label)
        workspace.save(ignore_permissions=True)

    frappe.db.commit()
    frappe.clear_cache()
    return {
        "language": "zh",
        "user": "Administrator",
        "display_name": "系统管理员",
        "phase_cleanup": phase_cleanup,
    }


def cleanup_m23_artifacts() -> dict[str, int]:
    fixture_devices = frappe.get_all(
        "Aishike Device Unit",
        filters={"production_batch": ["like", f"{M23_FIXTURE_BATCH_PREFIX}%"]},
        pluck="name",
    )
    fixture_batches = frappe.get_all(
        "Aishike Serial Number Batch",
        filters={"production_batch": ["like", f"{M23_FIXTURE_BATCH_PREFIX}%"]},
        pluck="name",
    )

    if fixture_devices:
        for doctype in (
            "Aishike Device Lifecycle Event",
            "Aishike Firmware Flash Record",
            "Aishike Device Test Record",
        ):
            frappe.db.delete(doctype, {"device_unit": ["in", fixture_devices]})
        frappe.db.delete("Aishike Device Unit", {"name": ["in", fixture_devices]})

    if fixture_batches:
        frappe.db.delete("Aishike Serial Number Batch", {"name": ["in", fixture_batches]})

    stale_events = frappe.get_all(
        "Aishike Device Lifecycle Event",
        filters={"event_type": ["not in", sorted(M2_ALLOWED_EVENT_TYPES)]},
        pluck="name",
    )
    if stale_events:
        frappe.db.delete("Aishike Device Lifecycle Event", {"name": ["in", stale_events]})

    restored_devices = 0
    for device in frappe.get_all(
        "Aishike Device Unit",
        fields=["name", "lifecycle_state"],
    ):
        target_state = derive_m2_device_state(
            has_passed_flash=bool(
                frappe.db.exists(
                    "Aishike Firmware Flash Record",
                    {"device_unit": device.name, "result": "PASS"},
                )
            ),
            has_assembly_event=bool(
                frappe.db.exists(
                    "Aishike Device Lifecycle Event",
                    {"device_unit": device.name, "event_type": "ASSEMBLED"},
                )
            ),
        )
        latest_event_at = frappe.db.get_value(
            "Aishike Device Lifecycle Event",
            {"device_unit": device.name},
            "occurred_at",
            order_by="occurred_at desc, creation desc",
        )
        if device.lifecycle_state != target_state:
            restored_devices += 1
        frappe.db.set_value(
            "Aishike Device Unit",
            device.name,
            {"lifecycle_state": target_state, "last_event_at": latest_event_at},
            update_modified=False,
        )

    dropped_columns = 0
    for column in M23_DEVICE_COLUMNS:
        if frappe.db.has_column("Aishike Device Unit", column):
            frappe.db.sql_ddl(
                f"ALTER TABLE `tabAishike Device Unit` DROP COLUMN `{column}`"
            )
            dropped_columns += 1

    dropped_tables = 0
    for doctype in M23_ORPHAN_DOCTYPES:
        if frappe.db.table_exists(doctype, cached=False):
            frappe.db.sql_ddl(f"DROP TABLE `tab{doctype}`")
            dropped_tables += 1

    return {
        "fixture_devices": len(fixture_devices),
        "fixture_batches": len(fixture_batches),
        "stale_events": len(stale_events),
        "restored_devices": restored_devices,
        "dropped_columns": dropped_columns,
        "dropped_tables": dropped_tables,
    }
