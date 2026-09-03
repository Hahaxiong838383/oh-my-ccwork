#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path


base = Path.home() / ".codex" / "account-switch"
tool = base / "bin" / "ccswap-studio"

listing = json.loads(
    subprocess.run(
        [str(tool), "codex", "list", "--json"],
        text=True,
        capture_output=True,
        check=True,
    ).stdout
)
usage = json.loads(
    subprocess.run(
        [str(tool), "codex", "usage", "--json"],
        text=True,
        capture_output=True,
        check=True,
    ).stdout
)

accounts = listing.get("accounts", [])
usage_by_slot = {row.get("number"): row for row in usage.get("accounts", [])}
sequence_path = base / "home" / ".claude-swap-backup" / "codex" / "sequence.json"
sequence = json.loads(sequence_path.read_text(encoding="utf-8"))
account_ids = {
    row.get("accountId")
    for row in sequence.get("accounts", {}).values()
    if row.get("accountId")
}
print(f"ACCOUNT_COUNT={len(accounts)}")
print(f"DISTINCT_ACCOUNT_IDS={len(account_ids)}")
print(f"ACTIVE_SLOT={listing.get('activeAccountNumber')}")
for account in accounts:
    slot = account.get("number")
    row = usage_by_slot.get(slot, {})
    weekly = (row.get("usage") or {}).get("weekly") or {}
    resets = (row.get("usage") or {}).get("reset_credits") or {}
    print(f"SLOT_{slot}_PLAN={account.get('planType') or 'unknown'}")
    print(f"SLOT_{slot}_USAGE_OK={int(not bool(row.get('error')))}")
    print(f"SLOT_{slot}_WEEKLY_PCT={weekly.get('pct', 'unknown')}")
    print(f"SLOT_{slot}_RESET_CREDITS={resets.get('available', 'unknown')}")
