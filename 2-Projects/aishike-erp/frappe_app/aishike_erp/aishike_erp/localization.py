from __future__ import annotations

import json

import frappe


SIDEBAR_LABELS = {
    "Home": "主页",
    "SKU Configuration": "SKU 配置",
    "Device Units": "设备档案",
    "Device Tests": "设备测试",
}

WORKSPACE_SHORTCUT_LABELS = {
    "Aishike SKU Configuration": "SKU 配置",
    "Aishike Device Unit": "设备档案",
    "Aishike Device Test Record": "设备测试",
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
        "id": "shortcut-device",
        "type": "shortcut",
        "data": {"shortcut_name": "设备档案", "col": 4},
    },
    {
        "id": "shortcut-test",
        "type": "shortcut",
        "data": {"shortcut_name": "设备测试", "col": 4},
    },
]


def apply_chinese_defaults() -> dict[str, str]:
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
        for item in sidebar.items:
            item.label = SIDEBAR_LABELS.get(item.label, item.label)
        sidebar.save(ignore_permissions=True)

    if frappe.db.exists("Workspace", "Aishike ERP"):
        workspace = frappe.get_doc("Workspace", "Aishike ERP")
        workspace.type = "Workspace"
        workspace.label = "Aishike ERP"
        workspace.title = "Aishike ERP"
        workspace.content = json.dumps(WORKSPACE_CONTENT, ensure_ascii=False, separators=(",", ":"))
        for shortcut in workspace.shortcuts:
            shortcut.label = WORKSPACE_SHORTCUT_LABELS.get(shortcut.link_to, shortcut.label)
        workspace.save(ignore_permissions=True)

    frappe.db.commit()
    frappe.clear_cache()
    return {"language": "zh", "user": "Administrator", "display_name": "系统管理员"}
