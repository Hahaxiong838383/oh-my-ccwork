"""租户注册表 + 凭据加密存储(控制面与 worker 共用读取层)。

设计要点:
- 租户 api key 只存 sha256,验证走 hmac.compare_digest(防时序);明文仅创建时返回一次。
- 凭据 AES-GCM 加密落盘:nonce(12B) + ciphertext,AAD 绑定 tenant_id/provider——
  文件挪到别的租户/别的 provider 目录下解不开(防拷贝挪用)。
- 诚实边界:root 可读 master key(env)与密文,加密防的是备份/离机泄露,不防本机 root。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# 凭据 schema:provider → (必填字段, 可选字段)。控制面写入时校验,worker 读取时信任。
PROVIDER_SCHEMAS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    # 大模型实时转写(iflyaisol 系凭据,与 TTS 三件套不是一套!)
    "xfyun_stt": (("app_id", "access_key_id", "access_key_secret"), ()),
    # 超拟人合成(开放平台三件套)
    "xfyun_tts": (("app_id", "api_key", "api_secret"), ("vcn",)),
    # 模式 B 大脑:同事自己的 OpenAI 兼容端点
    "brain": (("base_url", "api_key"), ("model",)),
}

_SENSITIVE_KEYS = frozenset(
    {"access_key_secret", "api_secret", "api_key", "access_key_id"}
)


def load_master_key(env: str = "CONSOLE_MASTER_KEY") -> bytes:
    """从 env 读 base64 的 32B master key;缺失即 fail fast(绝不静默降级明文)。"""
    raw = os.environ.get(env, "")
    if not raw:
        raise RuntimeError(f"{env} 未设置(base64 编码的 32 字节)")
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise RuntimeError(f"{env} 解码后须 32 字节,实际 {len(key)}")
    return key


def fingerprint(creds: dict[str, str]) -> dict[str, str]:
    """敏感值 → ****后4位;非敏感(base_url/vcn/model/app_id)原样。永不返回明文敏感值。"""
    out: dict[str, str] = {}
    for k, v in creds.items():
        if k in _SENSITIVE_KEYS:
            out[k] = f"****{v[-4:]}" if len(v) > 6 else "****"
        else:
            out[k] = v
    return out


@dataclass(frozen=True)
class Tenant:
    tenant_id: str
    name: str
    created_at: float


class TenantStore:
    """文件型租户/凭据存储。root 目录结构:
    tenants.json                     租户注册表(key 只存 hash)
    <tenant_id>/<provider>.enc       AES-GCM 凭据密文
    """

    def __init__(self, root: Path, master_key: bytes) -> None:
        self._root = root
        self._aes = AESGCM(master_key)
        self._root.mkdir(parents=True, exist_ok=True)

    # ---- 租户注册表 ----

    @property
    def _registry_path(self) -> Path:
        return self._root / "tenants.json"

    def _load_registry(self) -> dict[str, dict]:
        if not self._registry_path.exists():
            return {}
        return json.loads(self._registry_path.read_text("utf-8"))

    def _save_registry(self, reg: dict[str, dict]) -> None:
        tmp = self._registry_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(reg, ensure_ascii=False, indent=2), "utf-8")
        os.replace(tmp, self._registry_path)  # 原子替换,防写一半损坏

    def create_tenant(self, name: str) -> tuple[Tenant, str]:
        """建租户,返回 (Tenant, 明文 api_key)。明文只在此刻存在,存储只留 hash。"""
        reg = self._load_registry()
        slug = "".join(c for c in name.lower() if c.isalnum())[:12] or "tenant"
        tenant_id = f"{slug}-{secrets.token_hex(3)}"
        api_key = f"jv_{secrets.token_urlsafe(24)}"
        reg[tenant_id] = {
            "name": name,
            "key_sha256": hashlib.sha256(api_key.encode()).hexdigest(),
            "created_at": time.time(),
        }
        self._save_registry(reg)
        (self._root / tenant_id).mkdir(exist_ok=True)
        return Tenant(tenant_id, name, reg[tenant_id]["created_at"]), api_key

    def authenticate(self, bearer: str) -> str | None:
        """api key → tenant_id;不命中返回 None。全表常数时间比较。"""
        digest = hashlib.sha256(bearer.encode()).hexdigest()
        found: str | None = None
        for tid, meta in self._load_registry().items():
            if hmac.compare_digest(meta.get("key_sha256", ""), digest):
                found = tid  # 不 break:扫全表,时序不泄露命中位置
        return found

    def list_tenants(self) -> list[Tenant]:
        return [
            Tenant(tid, m["name"], m["created_at"])
            for tid, m in sorted(self._load_registry().items())
        ]

    def revoke_tenant(self, tenant_id: str) -> bool:
        reg = self._load_registry()
        if tenant_id not in reg:
            return False
        del reg[tenant_id]
        self._save_registry(reg)
        return True

    # ---- 凭据加密存储 ----

    def _cred_path(self, tenant_id: str, provider: str) -> Path:
        return self._root / tenant_id / f"{provider}.enc"

    def put_credentials(self, tenant_id: str, provider: str, creds: dict[str, str]) -> None:
        if provider not in PROVIDER_SCHEMAS:
            raise ValueError(f"未知 provider: {provider}")
        required, optional = PROVIDER_SCHEMAS[provider]
        missing = [k for k in required if not creds.get(k)]
        if missing:
            raise ValueError(f"{provider} 缺少必填字段: {missing}")
        unknown = [k for k in creds if k not in required + optional]
        if unknown:
            raise ValueError(f"{provider} 不认识的字段: {unknown}")
        nonce = secrets.token_bytes(12)
        aad = f"{tenant_id}/{provider}".encode()
        blob = nonce + self._aes.encrypt(
            nonce, json.dumps(creds, ensure_ascii=False).encode(), aad
        )
        path = self._cred_path(tenant_id, provider)
        path.parent.mkdir(exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(blob)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)

    def get_credentials(self, tenant_id: str, provider: str) -> dict[str, str] | None:
        """worker 每 job 调用 → 改 key 热生效。解密失败抛异常(不静默吞)。"""
        path = self._cred_path(tenant_id, provider)
        if not path.exists():
            return None
        blob = path.read_bytes()
        aad = f"{tenant_id}/{provider}".encode()
        plain = self._aes.decrypt(blob[:12], blob[12:], aad)
        return json.loads(plain)

    def list_credentials(self, tenant_id: str) -> list[dict[str, object]]:
        """回显安全清单:只有 provider + 指纹 + 更新时间,永无明文。"""
        out: list[dict[str, object]] = []
        for provider in PROVIDER_SCHEMAS:
            path = self._cred_path(tenant_id, provider)
            if path.exists():
                creds = self.get_credentials(tenant_id, provider) or {}
                out.append(
                    {
                        "provider": provider,
                        "fingerprint": fingerprint(creds),
                        "updated_at": path.stat().st_mtime,
                    }
                )
        return out


__all__ = [
    "PROVIDER_SCHEMAS",
    "Tenant",
    "TenantStore",
    "fingerprint",
    "load_master_key",
]
