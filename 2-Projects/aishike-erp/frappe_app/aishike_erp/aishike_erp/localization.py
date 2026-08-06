from __future__ import annotations

import json

import frappe


SIDEBAR_LABELS = {
    "Home": "主页",
    "SKU Configuration": "SKU 配置",
    "SN Console": "SN 工作台",
    "Production Console": "生产测试",
    "Quality Console": "质量与入库",
    "Fulfillment Console": "销售履约",
    "Device Units": "设备档案",
    "Device Tests": "设备测试",
    "Quality Releases": "质量放行记录",
    "Stock Movements": "库存移动记录",
    "Channel SKU Mappings": "渠道 SKU 映射",
    "Channel Orders": "渠道订单",
    "Fulfillment Records": "设备履约凭证",
}

WORKSPACE_SHORTCUT_LABELS = {
    "Aishike SKU Configuration": "SKU 配置",
    "aishike-sn-console": "SN 工作台",
    "aishike-production-console": "生产测试",
    "aishike-quality-console": "质量与入库",
    "aishike-fulfillment-console": "销售履约",
    "Aishike Device Unit": "设备档案",
    "Aishike Device Test Record": "设备测试",
    "Aishike Quality Release Record": "质量放行记录",
    "Aishike Device Stock Movement": "库存移动记录",
    "Aishike Channel SKU Mapping": "渠道 SKU 映射",
    "Aishike Channel Order": "渠道订单",
    "Aishike Device Fulfillment Record": "设备履约凭证",
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
    {
        "id": "header-quality-stock",
        "type": "header",
        "data": {"text": '<span class="h4"><b>质量、库存与追溯</b></span>', "col": 12},
    },
    {
        "id": "shortcut-quality-console",
        "type": "shortcut",
        "data": {"shortcut_name": "质量与入库", "col": 4},
    },
    {
        "id": "shortcut-quality-record",
        "type": "shortcut",
        "data": {"shortcut_name": "质量放行记录", "col": 4},
    },
    {
        "id": "shortcut-stock-movement",
        "type": "shortcut",
        "data": {"shortcut_name": "库存移动记录", "col": 4},
    },
    {
        "id": "header-fulfillment",
        "type": "header",
        "data": {"text": '<span class="h4"><b>渠道订单与设备履约</b></span>', "col": 12},
    },
    {
        "id": "shortcut-fulfillment-console",
        "type": "shortcut",
        "data": {"shortcut_name": "销售履约", "col": 4},
    },
    {
        "id": "shortcut-channel-mapping",
        "type": "shortcut",
        "data": {"shortcut_name": "渠道 SKU 映射", "col": 4},
    },
    {
        "id": "shortcut-channel-order",
        "type": "shortcut",
        "data": {"shortcut_name": "渠道订单", "col": 4},
    },
    {
        "id": "shortcut-fulfillment-record",
        "type": "shortcut",
        "data": {"shortcut_name": "设备履约凭证", "col": 4},
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
        if not any(item.link_to == "aishike-quality-console" for item in sidebar.items):
            sidebar.append(
                "items",
                {
                    "type": "Link",
                    "label": "质量与入库",
                    "link_type": "Page",
                    "link_to": "aishike-quality-console",
                },
            )
        if not any(item.link_to == "aishike-fulfillment-console" for item in sidebar.items):
            sidebar.append(
                "items",
                {
                    "type": "Link",
                    "label": "销售履约",
                    "link_type": "Page",
                    "link_to": "aishike-fulfillment-console",
                },
            )
        sidebar.save(ignore_permissions=True)

    if frappe.db.exists("Workspace", "Aishike ERP"):
        workspace = frappe.get_doc("Workspace", "Aishike ERP")
        workspace.type = "Workspace"
        workspace.label = "Aishike ERP"
        workspace.title = "Aishike ERP"
        workspace.content = json.dumps(WORKSPACE_CONTENT, ensure_ascii=False, separators=(",", ":"))
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
        if not any(
            shortcut.link_to == "aishike-quality-console" for shortcut in workspace.shortcuts
        ):
            workspace.append(
                "shortcuts",
                {
                    "type": "Page",
                    "link_to": "aishike-quality-console",
                    "label": "质量与入库",
                    "color": "Green",
                },
            )
        if not any(
            shortcut.link_to == "aishike-fulfillment-console"
            for shortcut in workspace.shortcuts
        ):
            workspace.append(
                "shortcuts",
                {
                    "type": "Page",
                    "link_to": "aishike-fulfillment-console",
                    "label": "销售履约",
                    "color": "Blue",
                },
            )
        for doctype, label, color in (
            ("Aishike Quality Release Record", "质量放行记录", "Green"),
            ("Aishike Device Stock Movement", "库存移动记录", "Blue"),
            ("Aishike Channel SKU Mapping", "渠道 SKU 映射", "Blue"),
            ("Aishike Channel Order", "渠道订单", "Orange"),
            ("Aishike Device Fulfillment Record", "设备履约凭证", "Green"),
        ):
            if not any(shortcut.link_to == doctype for shortcut in workspace.shortcuts):
                workspace.append(
                    "shortcuts",
                    {"type": "DocType", "link_to": doctype, "label": label, "color": color},
                )
        for shortcut in workspace.shortcuts:
            shortcut.label = WORKSPACE_SHORTCUT_LABELS.get(shortcut.link_to, shortcut.label)
        workspace.save(ignore_permissions=True)

    frappe.db.commit()
    frappe.clear_cache()
    return {"language": "zh", "user": "Administrator", "display_name": "系统管理员"}
