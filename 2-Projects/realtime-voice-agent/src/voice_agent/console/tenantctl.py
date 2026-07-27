"""租户管理 CLI(川哥侧,服务器上跑):

  python -m voice_agent.console.tenantctl add <名字>     # 建租户,打印 api_key(仅此一次)
  python -m voice_agent.console.tenantctl list
  python -m voice_agent.console.tenantctl revoke <tenant_id>
"""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

from .security import TenantStore, load_master_key


def main() -> None:
    parser = argparse.ArgumentParser(prog="tenantctl")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_add = sub.add_parser("add")
    p_add.add_argument("name")
    sub.add_parser("list")
    p_rev = sub.add_parser("revoke")
    p_rev.add_argument("tenant_id")
    args = parser.parse_args()

    store = TenantStore(
        Path(os.environ.get("TENANT_STORE", "/opt/voice-agent/tenants")),
        load_master_key(),
    )
    if args.cmd == "add":
        tenant, api_key = store.create_tenant(args.name)
        print(f"tenant_id : {tenant.tenant_id}")
        print(f"api_key   : {api_key}")
        print("⚠️ api_key 只显示这一次,存储只留 hash——现在就交给租户。")
    elif args.cmd == "list":
        for t in store.list_tenants():
            created = time.strftime("%Y-%m-%d %H:%M", time.localtime(t.created_at))
            print(f"{t.tenant_id}\t{t.name}\t{created}")
    elif args.cmd == "revoke":
        ok = store.revoke_tenant(args.tenant_id)
        print("revoked" if ok else f"未找到租户 {args.tenant_id}")


if __name__ == "__main__":
    main()
