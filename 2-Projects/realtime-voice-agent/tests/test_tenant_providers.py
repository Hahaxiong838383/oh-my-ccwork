"""租户 provider 接线测试:加密存储 → factory 端到端拉通(不联网)。"""

from __future__ import annotations

import base64
import secrets
from pathlib import Path

import pytest

from voice_agent.config import Settings
from voice_agent.console.security import TenantStore
from voice_agent.engines.tier_a_cascade import _build_llm, _build_stt, _build_tts

MASTER = secrets.token_bytes(32)


@pytest.fixture()
def tenant_env(tmp_path: Path, monkeypatch) -> tuple[str, TenantStore]:
    store = TenantStore(tmp_path, MASTER)
    tenant, _ = store.create_tenant("demo")
    monkeypatch.setenv("TENANT_ID", tenant.tenant_id)
    monkeypatch.setenv("TENANT_STORE", str(tmp_path))
    monkeypatch.setenv("CONSOLE_MASTER_KEY", base64.b64encode(MASTER).decode())
    return tenant.tenant_id, store


class TestXfyunWiring:
    def test_stt_from_tenant_store(self, tenant_env) -> None:
        tid, store = tenant_env
        store.put_credentials(
            tid, "xfyun_stt",
            {"app_id": "a1", "access_key_id": "k1", "access_key_secret": "s1"},
        )
        stt = _build_stt(Settings(stt_provider="xfyun"))
        assert type(stt).__name__ == "XfyunSTT"
        assert stt._app_id == "a1" and stt._access_key_id == "k1"

    def test_stt_env_fallback_without_tenant(self, monkeypatch) -> None:
        for k in ("TENANT_ID", "TENANT_STORE", "CONSOLE_MASTER_KEY"):
            monkeypatch.delenv(k, raising=False)
        monkeypatch.setenv("XFYUN_STT_APP_ID", "envapp")
        monkeypatch.setenv("XFYUN_STT_ACCESS_KEY_ID", "envak")
        monkeypatch.setenv("XFYUN_STT_ACCESS_KEY_SECRET", "envsk")
        stt = _build_stt(Settings(stt_provider="xfyun"))
        assert stt._app_id == "envapp"

    def test_stt_missing_creds_fail_fast(self, monkeypatch) -> None:
        for k in (
            "TENANT_ID", "TENANT_STORE", "CONSOLE_MASTER_KEY",
            "XFYUN_STT_APP_ID", "XFYUN_STT_ACCESS_KEY_ID", "XFYUN_STT_ACCESS_KEY_SECRET",
        ):
            monkeypatch.delenv(k, raising=False)
        with pytest.raises(RuntimeError, match="凭据缺失"):
            _build_stt(Settings(stt_provider="xfyun"))

    def test_tts_from_tenant_store_with_vcn(self, tenant_env) -> None:
        tid, store = tenant_env
        store.put_credentials(
            tid, "xfyun_tts",
            {"app_id": "a1", "api_key": "k1", "api_secret": "s1", "vcn": "x6_lingfeiyi_pro"},
        )
        tts = _build_tts(Settings(tts_provider="xfyun"))
        # 2026-08-03 切句对齐:xfyun 与 volc 同包 StreamAdapter,不再裸返回
        assert type(tts).__name__ == "StreamAdapter"
        assert type(tts._wrapped_tts).__name__ == "XfyunTTS"
        assert tts._wrapped_tts._vcn == "x6_lingfeiyi_pro"

    def test_tts_default_vcn_when_absent(self, tenant_env) -> None:
        tid, store = tenant_env
        store.put_credentials(
            tid, "xfyun_tts", {"app_id": "a1", "api_key": "k1", "api_secret": "s1"}
        )
        tts = _build_tts(Settings(tts_provider="xfyun"))
        assert tts._wrapped_tts._vcn == "x6_lingxiaoxuan_pro"

    def test_tts_sentence_split_aligned_with_volc_line(self, tenant_env, monkeypatch) -> None:
        """守护切句对齐(飞书 §12.5):min_sentence_len 默认 6、TTS_MIN_SENTENCE_LEN 可调。
        裸返回会被框架用官方默认 min=20 包装,短首句晚开播 ~300-800ms——此测试防回退。"""
        tid, store = tenant_env
        store.put_credentials(
            tid, "xfyun_tts", {"app_id": "a1", "api_key": "k1", "api_secret": "s1"}
        )
        monkeypatch.delenv("TTS_MIN_SENTENCE_LEN", raising=False)
        tts = _build_tts(Settings(tts_provider="xfyun"))
        assert tts._sentence_tokenizer._config.min_sentence_len == 6
        monkeypatch.setenv("TTS_MIN_SENTENCE_LEN", "9")
        tts2 = _build_tts(Settings(tts_provider="xfyun"))
        assert tts2._sentence_tokenizer._config.min_sentence_len == 9


class TestTenantBrainWiring:
    def test_llm_points_to_tenant_endpoint(self, tenant_env) -> None:
        tid, store = tenant_env
        store.put_credentials(
            tid, "brain",
            {"base_url": "https://brain.example.com/v1", "api_key": "bk1", "model": "qwen-plus"},
        )
        llm = _build_llm(Settings(llm_provider="tenant-brain"))
        assert type(llm).__name__ == "FastLLM"
        assert llm._base_url == "https://brain.example.com/v1"
        assert llm._model == "qwen-plus"

    def test_llm_fail_fast_without_brain(self, tenant_env) -> None:
        with pytest.raises(RuntimeError, match="brain"):
            _build_llm(Settings(llm_provider="tenant-brain"))

    def test_participant_identity_becomes_openai_user(self, tenant_env) -> None:
        # 租户记忆诉求(2026-07-29):participantName(激活码)→ OpenAI 标准 user 字段
        tid, store = tenant_env
        store.put_credentials(
            tid, "brain", {"base_url": "https://brain.example.com/v1", "api_key": "bk1"}
        )
        llm = _build_llm(
            Settings(llm_provider="tenant-brain"), participant_identity="P3ZSUH6J"
        )
        assert llm._user == "P3ZSUH6J"
        # 不传身份(超时降级)→ 空串,不注入 user 字段
        llm2 = _build_llm(Settings(llm_provider="tenant-brain"))
        assert llm2._user == ""
