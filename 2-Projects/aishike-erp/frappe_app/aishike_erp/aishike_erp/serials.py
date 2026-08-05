from __future__ import annotations

import re
from datetime import date
from urllib.parse import unquote, urlparse


ALLOWED_TOKENS = {"PREFIX", "DATE", "SKU", "BATCH", "SEQ", "SUFFIX"}
DATE_FORMATS = {
    "": "",
    "NONE": "",
    "YYMM": "%y%m",
    "YYMMDD": "%y%m%d",
    "YYYYMMDD": "%Y%m%d",
}
RESET_POLICIES = {"NEVER", "DAILY", "MONTHLY", "BATCH"}
SERIAL_PATTERN = re.compile(r"^[A-Z0-9._-]+$")
TOKEN_PATTERN = re.compile(r"\{([A-Z]+)\}")


class SerialRuleError(ValueError):
    pass


def normalize_segment(value: str) -> str:
    return "".join(character for character in (value or "").upper() if character.isascii() and character.isalnum())


def validate_pattern(pattern: str) -> None:
    if not pattern or not pattern.strip():
        raise SerialRuleError("SN 模板不能为空")

    tokens = set(TOKEN_PATTERN.findall(pattern.upper()))
    unknown_tokens = sorted(tokens - ALLOWED_TOKENS)
    if unknown_tokens:
        raise SerialRuleError(f"SN 模板包含未知占位符: {', '.join(unknown_tokens)}")
    if "SEQ" not in tokens:
        raise SerialRuleError("SN 模板必须包含 {SEQ}")

    unresolved = re.sub(TOKEN_PATTERN, "", pattern.upper())
    if "{" in unresolved or "}" in unresolved:
        raise SerialRuleError("SN 模板占位符格式不正确")


def render_serial(
    *,
    pattern: str,
    prefix: str,
    suffix: str,
    date_format: str,
    sku: str,
    batch: str,
    sequence: int,
    sequence_digits: int,
    date_value: date | None = None,
) -> str:
    validate_pattern(pattern)
    if not 4 <= int(sequence_digits) <= 10:
        raise SerialRuleError("流水号位数必须在 4 到 10 之间")
    if int(sequence) < 1:
        raise SerialRuleError("流水号必须大于 0")

    normalized_date_format = (date_format or "NONE").upper()
    if normalized_date_format not in DATE_FORMATS:
        raise SerialRuleError(f"不支持的日期格式: {date_format}")

    current_date = date_value or date.today()
    date_token = (
        current_date.strftime(DATE_FORMATS[normalized_date_format])
        if DATE_FORMATS[normalized_date_format]
        else ""
    )
    values = {
        "PREFIX": normalize_segment(prefix),
        "DATE": date_token,
        "SKU": normalize_segment(sku),
        "BATCH": normalize_segment(batch),
        "SEQ": str(int(sequence)).zfill(int(sequence_digits)),
        "SUFFIX": normalize_segment(suffix),
    }

    serial = pattern.upper()
    for token, value in values.items():
        serial = serial.replace(f"{{{token}}}", value)
    serial = re.sub(r"-{2,}", "-", serial)
    serial = re.sub(r"_{2,}", "_", serial)
    serial = re.sub(r"\.{2,}", ".", serial)
    serial = serial.strip("-_.")

    if not serial:
        raise SerialRuleError("SN 模板生成了空编号")
    if len(serial) > 64:
        raise SerialRuleError("SN 长度不能超过 64 个字符")
    if not SERIAL_PATTERN.fullmatch(serial):
        raise SerialRuleError("SN 只能包含大写字母、数字、连字符、下划线和点")
    return serial


def get_scope_key(reset_policy: str, current_date: date, production_batch: str) -> str:
    policy = (reset_policy or "NEVER").upper()
    if policy not in RESET_POLICIES:
        raise SerialRuleError(f"不支持的序号重置策略: {reset_policy}")
    if policy == "NEVER":
        return "GLOBAL"
    if policy == "DAILY":
        return current_date.strftime("%Y%m%d")
    if policy == "MONTHLY":
        return current_date.strftime("%Y%m")

    batch = normalize_segment(production_batch)
    if not batch:
        raise SerialRuleError("按生产批次重置时必须填写生产批次")
    return f"BATCH:{batch}"


def make_qr_payload(serial_no: str) -> str:
    return f"ASK:DEVICE:{normalize_scan_value(serial_no)}"


def normalize_scan_value(scan_value: str) -> str:
    value = (scan_value or "").strip()
    if not value:
        raise SerialRuleError("扫码内容不能为空")

    qr_prefix = "ASK:DEVICE:"
    if value.upper().startswith(qr_prefix):
        value = value[len(qr_prefix) :]
    elif "://" in value:
        parsed = urlparse(value)
        value = unquote(parsed.path.rstrip("/").split("/")[-1])

    serial = value.strip().upper()
    if not serial or len(serial) > 64 or not SERIAL_PATTERN.fullmatch(serial):
        raise SerialRuleError("扫码内容不是有效的设备 SN")
    return serial
