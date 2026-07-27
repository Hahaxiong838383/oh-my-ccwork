"""讯飞签名纯函数契约测试(固定时间注入,输出确定性回归)。"""

from __future__ import annotations

import base64
import hashlib
import hmac
from datetime import datetime, timezone
from urllib.parse import parse_qs, quote, urlparse

from voice_agent.engines.xfyun_common import (
    STT_LLM_WS_URL,
    TTS_SMART_WS_URL,
    build_stt_llm_ws_url,
    build_xfyun_auth_ws_url,
)

_NOW = datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)


class TestSttLlmSignature:
    def test_url_contains_required_params(self) -> None:
        url = build_stt_llm_ws_url("app1", "ak1", "sk1", utc_now=_NOW)
        parsed = urlparse(url)
        assert url.startswith(STT_LLM_WS_URL)
        q = parse_qs(parsed.query)
        # 官方必填七参数齐全
        for key in ("appId", "accessKeyId", "utc", "lang", "audio_encode", "samplerate", "signature"):
            assert key in q, f"missing {key}"
        assert q["audio_encode"] == ["pcm_s16le"]
        assert q["samplerate"] == ["16000"]
        assert q["utc"] == ["2026-07-27T12:00:00+0000"]

    def test_signature_matches_manual_construction(self) -> None:
        """按官方规则手工复算签名:升序 + urlencode(k)=urlencode(v) 拼接 + HmacSHA1 + base64。"""
        url = build_stt_llm_ws_url("app1", "ak1", "sk1", utc_now=_NOW)
        q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
        sig = q.pop("signature")
        base_string = "&".join(
            f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in sorted(q.items())
        )
        expect = base64.b64encode(
            hmac.new(b"sk1", base_string.encode(), hashlib.sha1).digest()
        ).decode()
        assert sig == expect

    def test_extra_params_participate_in_signature(self) -> None:
        # extra(如 role_type)改变签名——证明进了 baseString
        a = build_stt_llm_ws_url("app1", "ak1", "sk1", utc_now=_NOW)
        b = build_stt_llm_ws_url("app1", "ak1", "sk1", utc_now=_NOW, extra={"role_type": "2"})
        sig_a = parse_qs(urlparse(a).query)["signature"]
        sig_b = parse_qs(urlparse(b).query)["signature"]
        assert sig_a != sig_b


class TestXfyunAuthSignature:
    def test_url_shape(self) -> None:
        url = build_xfyun_auth_ws_url("key1", "secret1", utc_now=_NOW)
        parsed = urlparse(url)
        assert url.startswith(TTS_SMART_WS_URL)
        q = parse_qs(parsed.query)
        assert q["host"] == ["cbm01.cn-huabei-1.xf-yun.com"]
        assert "date" in q and "authorization" in q

    def test_authorization_decodes_to_expected_signature(self) -> None:
        url = build_xfyun_auth_ws_url("key1", "secret1", utc_now=_NOW)
        q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
        auth = base64.b64decode(q["authorization"]).decode()
        assert 'api_key="key1"' in auth
        assert 'algorithm="hmac-sha256"' in auth
        # 手工复算 signature
        origin = (
            f"host: cbm01.cn-huabei-1.xf-yun.com\ndate: {q['date']}\n"
            f"GET /v1/private/mcd9m97e6 HTTP/1.1"
        )
        expect = base64.b64encode(
            hmac.new(b"secret1", origin.encode(), hashlib.sha256).digest()
        ).decode()
        assert f'signature="{expect}"' in auth

    def test_custom_endpoint_signs_its_own_path(self) -> None:
        url = build_xfyun_auth_ws_url(
            "k", "s", "wss://other.xf-yun.com/v2/foo", utc_now=_NOW
        )
        q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
        auth = base64.b64decode(q["authorization"]).decode()
        origin = f"host: other.xf-yun.com\ndate: {q['date']}\nGET /v2/foo HTTP/1.1"
        expect = base64.b64encode(
            hmac.new(b"s", origin.encode(), hashlib.sha256).digest()
        ).decode()
        assert f'signature="{expect}"' in auth
