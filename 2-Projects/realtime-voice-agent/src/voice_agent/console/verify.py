"""凭据活性校验:写入即真调一次目标服务,无效当场拒绝(不落盘)。

返回 (ok, detail):ok=False 时 detail 是给同事看的可读原因。
分级:鉴权失败=拒;鉴权过但授权面问题(如 TTS vcn 未开通 11200)=收下+warning,
毕竟 key 本身是对的,发音人开通是他控制台里的事。
"""

from __future__ import annotations

import asyncio
import json
from typing import Awaitable, Callable

import aiohttp

from voice_agent.engines.xfyun_common import (
    DEFAULT_VCN,
    build_stt_llm_ws_url,
    build_tts_request,
    build_xfyun_auth_ws_url,
)

_TIMEOUT = aiohttp.ClientTimeout(total=10)

VerifyResult = tuple[bool, str]
Verifier = Callable[[dict[str, str]], Awaitable[VerifyResult]]


async def verify_xfyun_stt(creds: dict[str, str]) -> VerifyResult:
    """大模型实时转写:签名握手成功即凭据有效(立即关闭,不产生转写计费时长)。"""
    url = build_stt_llm_ws_url(
        creds["app_id"], creds["access_key_id"], creds["access_key_secret"]
    )
    try:
        async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
            async with session.ws_connect(url) as ws:
                # 握手 101 已过鉴权;尽力等首帧确认(action=started/msg_type),等不到也算过
                try:
                    msg = await ws.receive(timeout=3)
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        if data.get("action") not in (None, "started") and data.get("code"):
                            return False, f"讯飞返回错误帧: {msg.data[:200]}"
                except asyncio.TimeoutError:
                    pass
                return True, "握手通过"
    except aiohttp.WSServerHandshakeError as e:
        return False, f"鉴权失败(HTTP {e.status}): appId/accessKeyId/accessKeySecret 有误"
    except aiohttp.ClientError as e:
        return False, f"连接失败: {e}"


async def verify_xfyun_tts(creds: dict[str, str]) -> VerifyResult:
    """超拟人合成:最小合成请求("你")一发即收。11200=key 对但发音人未开通→收下+warning。"""
    url = build_xfyun_auth_ws_url(creds["api_key"], creds["api_secret"])
    vcn = creds.get("vcn") or DEFAULT_VCN
    # 探针请求与 adapter 同一构造源(2026-07-27 同事实测 10163 教训:曾手拼明文 text
    # 版——text 必须 base64,手拼副本必然漂移,统一走 build_tts_request)
    request = build_tts_request("你", app_id=creds["app_id"], vcn=vcn, sample_rate=16000)
    try:
        async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
            async with session.ws_connect(url) as ws:
                await ws.send_str(json.dumps(request, ensure_ascii=False))
                msg = await ws.receive(timeout=8)
                if msg.type != aiohttp.WSMsgType.TEXT:
                    return False, f"非预期响应类型: {msg.type}"
                data = json.loads(msg.data)
                code = data.get("header", {}).get("code")
                if code == 0:
                    return True, "合成通过"
                if code == 11200:
                    return True, f"key 有效,但发音人 {vcn} 未开通(11200)——去控制台开通后即可用"
                return False, f"讯飞错误 code={code}: {data.get('header', {}).get('message', '')}"
    except aiohttp.WSServerHandshakeError as e:
        return False, f"鉴权失败(HTTP {e.status}): api_key/api_secret 有误"
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        return False, f"连接失败: {e}"


async def verify_brain(creds: dict[str, str]) -> VerifyResult:
    """模式 B 大脑端点:OpenAI 兼容 chat/completions 最小请求(max_tokens=1)。"""
    base = creds["base_url"].rstrip("/")
    body = {
        "model": creds.get("model", "default"),
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
    }
    try:
        async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
            async with session.post(
                f"{base}/chat/completions",
                json=body,
                headers={"Authorization": f"Bearer {creds['api_key']}"},
            ) as resp:
                if resp.status < 300:
                    return True, "端点连通"
                if resp.status in (401, 403):
                    return False, f"端点拒绝鉴权(HTTP {resp.status}): api_key 有误"
                if resp.status == 404:
                    return False, "端点 404: base_url 应指向 OpenAI 兼容根(不含 /chat/completions)"
                text = (await resp.text())[:200]
                return False, f"端点异常 HTTP {resp.status}: {text}"
    except aiohttp.ClientError as e:
        return False, f"端点不可达: {e}"


VERIFIERS: dict[str, Verifier] = {
    "xfyun_stt": verify_xfyun_stt,
    "xfyun_tts": verify_xfyun_tts,
    "brain": verify_brain,
}

__all__ = ["VERIFIERS", "VerifyResult", "verify_brain", "verify_xfyun_stt", "verify_xfyun_tts"]
