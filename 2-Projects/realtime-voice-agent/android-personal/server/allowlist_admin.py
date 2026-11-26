#!/usr/bin/env python3
"""维护诊断接口的 SHA256 允许表（从不回显、从不记录明文凭据）。

凭据只走 stdin，绝不进 argv / 环境变量 / 日志：

    # 单设备：一行凭据
    vw get password "小可个人语音 · phone-01 设备凭据" | \
        python3 allowlist_admin.py add --device phone-01 --file /srv/night/private/allowlist.json

    # 批量：每行 "device<TAB>credential"
    python3 allowlist_admin.py add --lines --file ...

    # 撤销（与 ECS 签票侧 revoke 联动，见 README「撤销联动」）
    python3 allowlist_admin.py revoke --device phone-01 --file ...

    # 只看设备与指纹（sha256 前 12 位），用于核对
    python3 allowlist_admin.py list --file ...

文件格式：{"schema":1,"entries":[{"device":"phone-01","sha256":"<64 hex>"}]}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile

DEVICE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def load(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        return {"schema": 1, "entries": []}
    if not isinstance(raw, dict) or not isinstance(raw.get("entries"), list):
        raise SystemExit("allowlist 文件结构不合法，停止写入")
    return raw


def save(path: str, data: dict) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".allowlist.")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_credentials(lines_mode: bool) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    data = sys.stdin.read()
    for lineno, line in enumerate(data.splitlines(), 1):
        if not line.strip():
            continue
        if lines_mode:
            if "\t" not in line:
                raise SystemExit(f"第 {lineno} 行缺少 TAB 分隔的 device")
            device, cred = line.split("\t", 1)
            device, cred = device.strip(), cred.strip()
        else:
            device, cred = None, line.strip()
        if not cred:
            raise SystemExit(f"第 {lineno} 行凭据为空")
        out.append((device or "", cred))
    if not out:
        raise SystemExit("stdin 没有读到凭据")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("action", choices=["add", "revoke", "list"])
    ap.add_argument("--file", required=True)
    ap.add_argument("--device")
    ap.add_argument("--lines", action="store_true", help="每行 device<TAB>credential")
    args = ap.parse_args()

    data = load(args.file)

    if args.action == "list":
        entries = data.get("entries", [])
        if not entries:
            print("(空)")
            return 0
        for item in sorted(entries, key=lambda x: x.get("device", "")):
            print(f"{item.get('device','?'):<16} sha256:{str(item.get('sha256',''))[:12]}…")
        print(f"共 {len(entries)} 条")
        return 0

    if args.action == "revoke":
        if not args.device or not DEVICE_RE.match(args.device):
            raise SystemExit("--device 非法")
        before = len(data.get("entries", []))
        data["entries"] = [e for e in data.get("entries", []) if e.get("device") != args.device]
        save(args.file, data)
        print(f"撤销 {args.device}：{before} → {len(data['entries'])} 条")
        return 0

    # add
    pairs = read_credentials(args.lines)
    entries = [e for e in data.get("entries", []) if isinstance(e, dict)]
    by_device = {e.get("device"): e for e in entries if e.get("device")}
    for device, cred in pairs:
        device = (args.device or device or "").strip()
        if not DEVICE_RE.match(device):
            raise SystemExit(f"device 非法：{device!r}（需小写字母数字与 - . _，最长 32）")
        digest = hashlib.sha256(cred.encode("utf-8")).hexdigest()
        if not SHA256_RE.match(digest):  # 理论不可达，防御性检查
            raise SystemExit("摘要异常")
        by_device[device] = {"device": device, "sha256": digest}
        print(f"{device}: 已写入 sha256:{digest[:12]}…")
    data["schema"] = 1
    data["entries"] = [by_device[k] for k in sorted(by_device)]
    save(args.file, data)
    print(f"共 {len(data['entries'])} 条 → {args.file} (0600)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
