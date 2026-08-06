from __future__ import annotations


ALLOWED_EMPLOYEE_EMAIL_DOMAIN = "futurus.co"
STANDARD_USERS = {"Administrator", "Guest"}


def is_allowed_employee_email(email: str | None) -> bool:
    normalized = (email or "").strip().casefold()
    local_part, separator, domain = normalized.rpartition("@")
    return bool(local_part and separator and domain == ALLOWED_EMPLOYEE_EMAIL_DOMAIN)


def validate_system_user_email_domain(doc, method: str | None = None) -> None:
    if doc.name in STANDARD_USERS or doc.user_type != "System User":
        return

    email = doc.email or doc.name
    if is_allowed_employee_email(email):
        return

    import frappe

    frappe.throw(
        "员工系统账号必须使用 @futurus.co 飞书企业邮箱。",
        title="企业邮箱要求",
    )


def find_noncompliant_system_users() -> list[str]:
    import frappe

    users = frappe.get_all(
        "User",
        filters={"enabled": 1, "user_type": "System User"},
        fields=["name", "email"],
    )
    return sorted(
        user.name
        for user in users
        if user.name not in STANDARD_USERS
        and not is_allowed_employee_email(user.email or user.name)
    )
