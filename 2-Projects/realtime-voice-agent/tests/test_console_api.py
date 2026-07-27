"""控制面契约测试:租户鉴权/加密落盘/永不回显/活性校验门/会话签发。"""

from __future__ import annotations

import base64
import json
import secrets
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from voice_agent.console.app import create_app
from voice_agent.console.security import TenantStore, fingerprint

MASTER = secrets.token_bytes(32)

STT_CREDS = {"app_id": "app1", "access_key_id": "AK1234567890", "access_key_secret": "SK0987654321"}


@pytest.fixture()
def store(tmp_path: Path) -> TenantStore:
    return TenantStore(tmp_path, MASTER)


@pytest.fixture()
def tenant(store: TenantStore) -> tuple[str, str]:
    t, key = store.create_tenant("demo")
    return t.tenant_id, key


def make_client(store: TenantStore, verifiers=None, sdk_path=None) -> TestClient:
    async def _ok(creds):
        return True, "ok"

    v = verifiers if verifiers is not None else {p: _ok for p in ("xfyun_stt", "xfyun_tts", "brain")}
    return TestClient(create_app(store=store, verifiers=v, sdk_path=sdk_path))


class TestSecurity:
    def test_encrypt_roundtrip_and_file_permissions(self, store: TenantStore, tenant) -> None:
        tid, _ = tenant
        store.put_credentials(tid, "xfyun_stt", STT_CREDS)
        assert store.get_credentials(tid, "xfyun_stt") == STT_CREDS

    def test_ciphertext_bound_to_tenant_and_provider(self, store: TenantStore, tenant, tmp_path) -> None:
        # AAD 绑定:密文文件挪给别的租户/别的 provider 解不开
        tid, _ = tenant
        t2, _ = store.create_tenant("other")
        store.put_credentials(tid, "xfyun_stt", STT_CREDS)
        src = tmp_path / tid / "xfyun_stt.enc"
        (tmp_path / t2.tenant_id).mkdir(exist_ok=True)
        (tmp_path / t2.tenant_id / "xfyun_stt.enc").write_bytes(src.read_bytes())
        with pytest.raises(Exception):
            store.get_credentials(t2.tenant_id, "xfyun_stt")

    def test_authenticate(self, store: TenantStore, tenant) -> None:
        tid, key = tenant
        assert store.authenticate(key) == tid
        assert store.authenticate("jv_wrong") is None

    def test_fingerprint_never_leaks_secret(self) -> None:
        fp = fingerprint(STT_CREDS)
        assert "SK0987654321" not in json.dumps(fp)
        assert fp["access_key_secret"] == "****4321"
        assert fp["app_id"] == "app1"  # 非敏感原样

    def test_schema_rejects_missing_and_unknown(self, store: TenantStore, tenant) -> None:
        tid, _ = tenant
        with pytest.raises(ValueError):
            store.put_credentials(tid, "xfyun_stt", {"app_id": "x"})
        with pytest.raises(ValueError):
            store.put_credentials(tid, "xfyun_stt", {**STT_CREDS, "hax": "1"})


class TestCredentialsApi:
    def test_401_without_or_wrong_token(self, store: TenantStore) -> None:
        client = make_client(store)
        assert client.post("/v1/credentials", json={"provider": "brain", "credentials": {}}).status_code == 401
        r = client.post(
            "/v1/credentials",
            json={"provider": "brain", "credentials": {}},
            headers={"Authorization": "Bearer jv_bad"},
        )
        assert r.status_code == 401

    def test_put_and_list_never_echoes_secret(self, store: TenantStore, tenant) -> None:
        tid, key = tenant
        client = make_client(store)
        r = client.post(
            "/v1/credentials",
            json={"provider": "xfyun_stt", "credentials": STT_CREDS},
            headers={"Authorization": f"Bearer {key}"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["verified"] is True
        assert "SK0987654321" not in r.text
        # 落盘可被 worker 读到
        assert store.get_credentials(tid, "xfyun_stt") == STT_CREDS
        # 列表同样无明文
        r2 = client.get("/v1/credentials", headers={"Authorization": f"Bearer {key}"})
        assert r2.status_code == 200
        assert "SK0987654321" not in r2.text
        assert r2.json()[0]["provider"] == "xfyun_stt"

    def test_failed_verify_does_not_persist(self, store: TenantStore, tenant) -> None:
        tid, key = tenant

        async def _fail(creds):
            return False, "鉴权失败(HTTP 401)"

        client = make_client(store, verifiers={"xfyun_stt": _fail})
        r = client.post(
            "/v1/credentials",
            json={"provider": "xfyun_stt", "credentials": STT_CREDS},
            headers={"Authorization": f"Bearer {key}"},
        )
        assert r.status_code == 422
        assert store.get_credentials(tid, "xfyun_stt") is None

    def test_unknown_provider_and_bad_schema(self, store: TenantStore, tenant) -> None:
        _, key = tenant
        client = make_client(store)
        auth = {"Authorization": f"Bearer {key}"}
        assert client.post(
            "/v1/credentials", json={"provider": "nope", "credentials": {}}, headers=auth
        ).status_code == 422
        assert client.post(
            "/v1/credentials",
            json={"provider": "brain", "credentials": {"base_url": "http://x"}},
            headers=auth,
        ).status_code == 422  # 缺 api_key

    def test_tts_warning_surfaced(self, store: TenantStore, tenant) -> None:
        _, key = tenant

        async def _warn(creds):
            return True, "key 有效,但发音人 x6 未开通(11200)——去控制台开通后即可用"

        client = make_client(store, verifiers={"xfyun_tts": _warn})
        r = client.post(
            "/v1/credentials",
            json={
                "provider": "xfyun_tts",
                "credentials": {"app_id": "a", "api_key": "k123456789", "api_secret": "s123456789"},
            },
            headers={"Authorization": f"Bearer {key}"},
        )
        assert r.status_code == 200
        assert "未开通" in r.json().get("warning", "")


class TestSessionsApi:
    def test_session_token_contains_room_and_agent_dispatch(
        self, store: TenantStore, tenant, monkeypatch
    ) -> None:
        tid, key = tenant
        monkeypatch.setenv("LIVEKIT_WS_URL", "wss://voice-hk.example.com")
        monkeypatch.setenv("LIVEKIT_API_KEY", "lkkey")
        monkeypatch.setenv("LIVEKIT_API_SECRET", "lksecret-lksecret-lksecret-32b!!")
        client = make_client(store)
        r = client.post(
            "/v1/sessions",
            json={"participant_name": "colleague"},
            headers={"Authorization": f"Bearer {key}"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["url"] == "wss://voice-hk.example.com"
        assert body["room"].startswith(f"t-{tid}-")
        # 解 JWT payload(不验签):room grant + agent dispatch 指向租户专属 worker
        payload_b64 = body["token"].split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
        assert payload["video"]["room"] == body["room"]
        assert payload["roomConfig"]["agents"][0]["agentName"] == f"javis-{tid}"
        # 未配 provider → warning 提示
        assert "warning" in body

    def test_session_503_without_livekit_env(self, store: TenantStore, tenant, monkeypatch) -> None:
        _, key = tenant
        monkeypatch.delenv("LIVEKIT_WS_URL", raising=False)
        client = make_client(store)
        r = client.post("/v1/sessions", json={}, headers={"Authorization": f"Bearer {key}"})
        assert r.status_code == 503


class TestCors:
    def test_preflight_allows_foreign_origin(self, store: TenantStore) -> None:
        # 同事页面在他自己域名下直调控制面——preflight 必须放行
        client = make_client(store)
        r = client.options(
            "/v1/sessions",
            headers={
                "Origin": "https://colleague-demo.example.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        assert r.status_code == 200
        assert r.headers["access-control-allow-origin"] == "*"


class TestSdkRoute:
    def test_sdk_served_when_built(self, store: TenantStore, tmp_path: Path) -> None:
        sdk = tmp_path / "v1.js"
        sdk.write_text("// JavisVoice SDK\n", "utf-8")
        client = make_client(store, sdk_path=sdk)
        r = client.get("/sdk/v1.js")
        assert r.status_code == 200
        assert "JavisVoice" in r.text
        assert r.headers["content-type"].startswith("application/javascript")
