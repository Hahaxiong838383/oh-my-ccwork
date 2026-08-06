from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "aishike_erp"
DOCTYPE_ROOT = PACKAGE_ROOT / "aishike_erp" / "doctype"
WORKSPACE_ROOT = PACKAGE_ROOT / "aishike_erp" / "workspace"
PAGE_ROOT = PACKAGE_ROOT / "aishike_erp" / "page"
DOCTOR_PATH = ROOT.parents[1] / "deploy" / "doctor.sh"
CONTAINERFILE_PATH = ROOT.parents[1] / "deploy" / "Containerfile"
HOOKS_PATH = PACKAGE_ROOT / "hooks.py"
USER_POLICY_PATH = PACKAGE_ROOT / "user_policy.py"
ACCEPTANCE_PATH = PACKAGE_ROOT / "acceptance.py"


def validate_doctype(path: Path) -> tuple[str, int]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("doctype") != "DocType":
        raise ValueError(f"{path}: doctype must be DocType")
    if data.get("module") != "Aishike ERP":
        raise ValueError(f"{path}: module must be Aishike ERP")
    if not data.get("name"):
        raise ValueError(f"{path}: name is required")

    fields = data.get("fields", [])
    fieldnames = [field["fieldname"] for field in fields]
    if len(fieldnames) != len(set(fieldnames)):
        raise ValueError(f"{path}: duplicate fieldname")
    if data.get("field_order") != fieldnames:
        raise ValueError(f"{path}: field_order must match fields order")

    folder_name = path.parent.name.replace("_", " ").title()
    if data["name"].lower() != folder_name.lower():
        raise ValueError(f"{path}: folder name does not match DocType name")
    return data["name"], len(fields)


def validate_trace_permissions(path: Path, doctype: str) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    roles = {
        permission.get("role")
        for permission in data.get("permissions", [])
        if permission.get("read")
    }
    expected_roles = {"System Manager", "Manufacturing Manager", "Quality Manager", "Stock Manager"}
    if not expected_roles.issubset(roles):
        missing = sorted(expected_roles - roles)
        raise ValueError(f"{doctype}: trace read roles are missing: {missing}")


def validate_m3_controller_guards() -> None:
    device_controller = (
        DOCTYPE_ROOT / "aishike_device_unit" / "aishike_device_unit.py"
    ).read_text(encoding="utf-8")
    event_controller = (
        DOCTYPE_ROOT
        / "aishike_device_lifecycle_event"
        / "aishike_device_lifecycle_event.py"
    ).read_text(encoding="utf-8")
    quality_controller = (
        DOCTYPE_ROOT
        / "aishike_quality_release_record"
        / "aishike_quality_release_record.py"
    ).read_text(encoding="utf-8")
    stock_controller = (
        DOCTYPE_ROOT
        / "aishike_device_stock_movement"
        / "aishike_device_stock_movement.py"
    ).read_text(encoding="utf-8")
    fulfillment_controller = (
        DOCTYPE_ROOT
        / "aishike_device_fulfillment_record"
        / "aishike_device_fulfillment_record.py"
    ).read_text(encoding="utf-8")
    expected_guards = {
        "device phase guard": (device_controller, "is_m3_device_state"),
        "event phase guard": (event_controller, "is_m3_event_type"),
        "quality actor guard": (quality_controller, "self.inspector = frappe.session.user"),
        "quality time guard": (quality_controller, "self.released_at = now_datetime()"),
        "stock actor guard": (stock_controller, "self.operator = frappe.session.user"),
        "stock time guard": (stock_controller, "self.movement_at = now_datetime()"),
        "stock source guard": (stock_controller, "self.from_warehouse = current_warehouse"),
        "fulfillment actor guard": (fulfillment_controller, "self.operator = frappe.session.user"),
        "fulfillment time guard": (fulfillment_controller, "self.action_at = now_datetime()"),
        "fulfillment order lock": (fulfillment_controller, "tabAishike Channel Order"),
        "fulfillment device lock": (fulfillment_controller, "tabAishike Device Unit"),
    }
    missing = [label for label, (content, marker) in expected_guards.items() if marker not in content]
    if missing:
        raise ValueError(f"M3 controller guards are missing: {missing}")


def validate_employee_email_policy() -> None:
    hooks = HOOKS_PATH.read_text(encoding="utf-8")
    policy = USER_POLICY_PATH.read_text(encoding="utf-8")
    acceptance = ACCEPTANCE_PATH.read_text(encoding="utf-8")
    expected_markers = {
        "User validation hook": (
            hooks,
            "aishike_erp.user_policy.validate_system_user_email_domain",
        ),
        "employee domain": (policy, 'ALLOWED_EMPLOYEE_EMAIL_DOMAIN = "futurus.co"'),
        "employee domain error": (policy, "员工系统账号必须使用 @futurus.co 飞书企业邮箱"),
        "runtime user audit": (acceptance, '"noncompliant_system_users"'),
    }
    missing = [label for label, (content, marker) in expected_markers.items() if marker not in content]
    if missing:
        raise ValueError(f"employee email policy guards are missing: {missing}")


def main() -> None:
    doctypes = []
    field_count = 0
    for path in sorted(DOCTYPE_ROOT.glob("*/*.json")):
        name, count = validate_doctype(path)
        doctypes.append(name)
        field_count += count

    workspaces = list(WORKSPACE_ROOT.glob("*/*.json"))
    for path in workspaces:
        data = json.loads(path.read_text(encoding="utf-8"))
        json.loads(data["content"])
        if data.get("app") != "aishike_erp":
            raise ValueError(f"{path}: workspace app mismatch")
        if data.get("type") != "Workspace":
            raise ValueError(f"{path}: workspace type must be Workspace")
        if data.get("label") != "Aishike ERP" or data.get("title") != "Aishike ERP":
            raise ValueError(f"{path}: workspace route identity must stay canonical")
        shortcuts = {(row.get("type"), row.get("link_to")) for row in data.get("shortcuts", [])}
        if ("Page", "aishike-sn-console") not in shortcuts:
            raise ValueError(f"{path}: SN console shortcut is required")
        if ("Page", "aishike-production-console") not in shortcuts:
            raise ValueError(f"{path}: production console shortcut is required")
        if ("Page", "aishike-quality-console") not in shortcuts:
            raise ValueError(f"{path}: quality console shortcut is required")
        if ("Page", "aishike-fulfillment-console") not in shortcuts:
            raise ValueError(f"{path}: fulfillment console shortcut is required")

    pages = list(PAGE_ROOT.glob("*/*.json"))
    page_names = {json.loads(path.read_text(encoding="utf-8"))["name"] for path in pages}
    expected_pages = {
        "aishike-sn-console",
        "aishike-production-console",
        "aishike-quality-console",
        "aishike-fulfillment-console",
    }
    if not expected_pages.issubset(page_names):
        raise ValueError(f"Required pages are missing: {sorted(expected_pages - page_names)}")

    expected = {
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
    }
    if set(doctypes) != expected:
        raise ValueError(f"DocType set mismatch: {doctypes}")

    trace_doctypes = {
        "Aishike SKU Configuration",
        "Aishike Device Unit",
        "Aishike Device Test Record",
        "Aishike Device Lifecycle Event",
        "Aishike Firmware Flash Record",
        "Aishike Serial Number Batch",
        "Aishike Quality Release Record",
        "Aishike Device Stock Movement",
        "Aishike Channel SKU Mapping",
        "Aishike Channel Order",
        "Aishike Device Fulfillment Record",
    }
    for path in sorted(DOCTYPE_ROOT.glob("*/*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data["name"] in trace_doctypes:
            validate_trace_permissions(path, data["name"])

    validate_m3_controller_guards()
    validate_employee_email_policy()

    doctor_script = DOCTOR_PATH.read_text(encoding="utf-8")
    if "aishike_erp.acceptance.assert_runtime_check" not in doctor_script:
        raise ValueError("doctor.sh must use the fail-closed runtime assertion")

    containerfile = CONTAINERFILE_PATH.read_text(encoding="utf-8")
    if 'socket.request.headers["x-forwarded-host"] || socket.request.headers.host' not in containerfile:
        raise ValueError("Containerfile must validate realtime Origin against forwarded public host")

    print(
        f"OK: {len(doctypes)} DocTypes, {field_count} fields, "
        f"{len(workspaces)} workspace, {len(pages)} pages"
    )


if __name__ == "__main__":
    main()
