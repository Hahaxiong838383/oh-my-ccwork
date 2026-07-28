"""讯飞两套 WebSocket 鉴权签名(纯函数,供 adapter 与控制面活性校验共用)。

两个服务鉴权体系完全不同(2026-07-27 官方文档查证,勿混用):
- 大模型实时转写(office-api-ast-dx.iflyaisol.com):appId/accessKeyId/accessKeySecret,
  全参数升序排序 urlencode 拼接 → HmacSHA1(secret) → base64 → signature query 参数。
  文档: https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html
- 超拟人合成(cbm01.cn-huabei-1.xf-yun.com):app_id/api_key/api_secret,
  "host: ...\\ndate: ...\\nGET path HTTP/1.1" → HmacSHA256(api_secret) → base64
  → authorization 明文再整体 base64 进 query。
  文档: https://www.xfyun.cn/doc/spark/super%20smart-tts.html
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from datetime import datetime, timezone
from email.utils import format_datetime
from urllib.parse import quote, urlencode, urlparse

# 大模型实时转写默认 endpoint(与标准版 rtasr.xfyun.cn 不是一个服务)
STT_LLM_WS_URL = "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1"
# 超拟人合成 endpoint(path 含产品固定路由段)
TTS_SMART_WS_URL = "wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6"


def build_stt_llm_ws_url(
    app_id: str,
    access_key_id: str,
    access_key_secret: str,
    *,
    base_url: str = STT_LLM_WS_URL,
    lang: str = "autodialect",
    samplerate: int = 16000,
    utc_now: datetime | None = None,
    extra: dict[str, str] | None = None,
) -> str:
    """大模型实时转写握手 URL(含签名)。

    签名规则(官方):所有参数(不含 signature)按参数名升序,
    "urlencode(k)=urlencode(v)" 以 & 拼接为 baseString,
    HmacSHA1(accessKeySecret, baseString) → base64 → signature。
    utc 参数格式 ISO8601 带 +0800 时区(如 2025-09-04T15:38:07+0800)。
    """
    now = utc_now if utc_now is not None else datetime.now(timezone.utc)
    utc_str = now.strftime("%Y-%m-%dT%H:%M:%S%z")  # +0000 / +0800 无冒号,符合示例
    params: dict[str, str] = {
        "appId": app_id,
        "accessKeyId": access_key_id,
        "utc": utc_str,
        "lang": lang,
        "audio_encode": "pcm_s16le",
        "samplerate": str(samplerate),
    }
    if extra:
        params.update(extra)
    base_string = "&".join(
        f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in sorted(params.items())
    )
    digest = hmac.new(
        access_key_secret.encode("utf-8"), base_string.encode("utf-8"), hashlib.sha1
    ).digest()
    signature = base64.b64encode(digest).decode("utf-8")
    query = urlencode({**params, "signature": signature})
    return f"{base_url}?{query}"


def build_xfyun_auth_ws_url(
    api_key: str,
    api_secret: str,
    endpoint: str = TTS_SMART_WS_URL,
    *,
    utc_now: datetime | None = None,
) -> str:
    """讯飞通用 hmac-sha256 鉴权 URL(超拟人 TTS 等 xf-yun.com 系服务)。

    signature_origin = "host: {host}\\ndate: {date}\\nGET {path} HTTP/1.1",
    date 为 RFC1123 GMT;authorization 明文拼好后整体 base64 进 query。
    """
    parsed = urlparse(endpoint)
    host, path = parsed.netloc, parsed.path
    now = utc_now if utc_now is not None else datetime.now(timezone.utc)
    date = format_datetime(now, usegmt=True)
    signature_origin = f"host: {host}\ndate: {date}\nGET {path} HTTP/1.1"
    digest = hmac.new(
        api_secret.encode("utf-8"), signature_origin.encode("utf-8"), hashlib.sha256
    ).digest()
    signature = base64.b64encode(digest).decode("utf-8")
    authorization_origin = (
        f'api_key="{api_key}", algorithm="hmac-sha256", '
        f'headers="host date request-line", signature="{signature}"'
    )
    authorization = base64.b64encode(authorization_origin.encode("utf-8")).decode("utf-8")
    query = urlencode({"host": host, "date": date, "authorization": authorization})
    return f"{endpoint}?{query}"


DEFAULT_VCN = "x6_lingxiaoxuan_pro"


def build_tts_request(
    text: str,
    *,
    app_id: str,
    vcn: str,
    sample_rate: int = 24000,
    speed: int = 50,
    volume: int = 50,
    pitch: int = 50,
    oral_level: str = "mid",
) -> dict:
    """超拟人单帧完整合成请求(status 全 2:一句一会话)。

    放协议层(无 livekit 依赖)供 adapter 与控制面活性校验探针共用——
    2026-07-27 同事实测教训:探针曾手拼一份明文 text 版,讯飞报 10163;
    text 必须 base64(生产实现实锤),单一构造源杜绝再漂移。
    """
    return {
        "header": {"app_id": app_id, "status": 2},
        "parameter": {
            "oral": {"oral_level": oral_level},
            "tts": {
                "vcn": vcn,
                "speed": speed,
                "volume": volume,
                "pitch": pitch,
                "audio": {
                    "encoding": "raw",  # raw=PCM16,免 mp3 解码
                    "sample_rate": sample_rate,
                    "channels": 1,
                    "bit_depth": 16,
                    "frame_size": 0,
                },
            },
        },
        "payload": {
            "text": {
                "encoding": "utf8",
                "compress": "raw",
                "format": "plain",
                "status": 2,
                "seq": 1,
                "text": base64.b64encode(text.encode("utf-8")).decode("ascii"),
            }
        },
    }


__all__ = [
    "DEFAULT_VCN",
    "STT_LLM_WS_URL",
    "TTS_SMART_WS_URL",
    "build_stt_llm_ws_url",
    "build_tts_request",
    "build_xfyun_auth_ws_url",
]
