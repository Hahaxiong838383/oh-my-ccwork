"""租户 worker 侧凭据读取(薄工具)。

worker env 三件套齐(TENANT_ID/TENANT_STORE/CONSOLE_MASTER_KEY)即启用租户模式:
_build_* 每 job 调一次 load_tenant_credentials → 同事经控制面改 key 热生效,免重启。
env 不齐返回 None,各分支回退自己的直配 env(本机调试便利)。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger("voice_agent.tenant")


def tenant_id() -> str:
    return os.environ.get("TENANT_ID", "")


def load_tenant_credentials(provider: str) -> dict[str, str] | None:
    """从加密存储读当前租户的 provider 凭据;租户模式未启用/未写入返回 None。
    解密失败(master key 换过/文件损坏)不吞:抛出让 job fail fast。"""
    tid = tenant_id()
    root = os.environ.get("TENANT_STORE", "")
    if not (tid and root and os.environ.get("CONSOLE_MASTER_KEY")):
        return None
    from voice_agent.console.security import TenantStore, load_master_key

    creds = TenantStore(Path(root), load_master_key()).get_credentials(tid, provider)
    if creds is None:
        logger.warning("租户 %s 未写入 %s 凭据(等控制面 POST /v1/credentials)", tid, provider)
    return creds


__all__ = ["load_tenant_credentials", "tenant_id"]
