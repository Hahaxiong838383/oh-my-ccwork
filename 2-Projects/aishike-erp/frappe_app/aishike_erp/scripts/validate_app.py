from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "aishike_erp"
DOCTYPE_ROOT = PACKAGE_ROOT / "aishike_erp" / "doctype"
WORKSPACE_ROOT = PACKAGE_ROOT / "aishike_erp" / "workspace"
PAGE_ROOT = PACKAGE_ROOT / "aishike_erp" / "page"
DOCTOR_PATH = ROOT.parents[1] / "deploy" / "doctor.sh"


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

    pages = list(PAGE_ROOT.glob("*/*.json"))
    page_names = {json.loads(path.read_text(encoding="utf-8"))["name"] for path in pages}
    expected_pages = {"aishike-sn-console", "aishike-production-console"}
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
    }
    if set(doctypes) != expected:
        raise ValueError(f"DocType set mismatch: {doctypes}")

    doctor_script = DOCTOR_PATH.read_text(encoding="utf-8")
    if "aishike_erp.acceptance.assert_runtime_check" not in doctor_script:
        raise ValueError("doctor.sh must use the fail-closed runtime assertion")

    print(
        f"OK: {len(doctypes)} DocTypes, {field_count} fields, "
        f"{len(workspaces)} workspace, {len(pages)} pages"
    )


if __name__ == "__main__":
    main()
