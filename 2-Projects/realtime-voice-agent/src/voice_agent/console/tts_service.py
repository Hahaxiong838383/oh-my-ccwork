"""TTS-only 场景语音合成(2026-07-30 同事需求 §四方案 A)。

租户 BYOK 凭据 → 讯飞超拟人 ws → 流式 mp3。不开房间、不占 worker 名额;
100+ 条固定台词按文本落盘缓存,二次请求(及批量预热后的首次播放)近零延迟。

与 adapter/探针同构造源(build_tts_request/parse_tts_frame)——10163 教训:
凡是"另一份手拼的讯飞请求"必然漂移,这里只改 encoding=lame(mp3)。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import AsyncIterator
from pathlib import Path

import aiohttp

from ..engines.xfyun_common import DEFAULT_VCN, build_tts_request, build_xfyun_auth_ws_url
from ..engines.xfyun_tts import parse_tts_frame

logger = logging.getLogger("voice_agent.console.tts")

_TIMEOUT = aiohttp.ClientTimeout(total=30)
MAX_TEXT_LEN = 500

# 每租户同时只跑一路合成:讯飞侧并发配额有限,批量预热也靠它天然排队
_tenant_locks: dict[str, asyncio.Lock] = {}


def tenant_lock(tenant_id: str) -> asyncio.Lock:
    lock = _tenant_locks.get(tenant_id)
    if lock is None:
        lock = _tenant_locks[tenant_id] = asyncio.Lock()
    return lock


def cache_path(root: Path, tenant_id: str, vcn: str, text: str) -> Path:
    """缓存键=音色+文本(mp3 固定):同文本换音色不串音。"""
    digest = hashlib.sha256(f"{vcn}|{text}".encode("utf-8")).hexdigest()
    return root / tenant_id / f"{digest}.mp3"


async def synthesize_mp3(creds: dict[str, str], text: str) -> AsyncIterator[bytes]:
    """单句合成,流式产出 mp3 字节块;讯飞报错抛 RuntimeError。"""
    url = build_xfyun_auth_ws_url(creds["api_key"], creds["api_secret"])
    vcn = creds.get("vcn") or DEFAULT_VCN
    request = build_tts_request(
        text, app_id=creds["app_id"], vcn=vcn, sample_rate=24000, encoding="lame"
    )
    async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
        async with session.ws_connect(url) as ws:
            await ws.send_json(request)
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    break
                kind, payload, is_last = parse_tts_frame(msg.data)
                if kind == "error":
                    raise RuntimeError(f"讯飞合成失败: {payload.decode(errors='replace')}")
                if kind == "audio" and payload:
                    yield payload
                if is_last:
                    return


async def synthesize_to_cache(
    creds: dict[str, str], text: str, target: Path
) -> AsyncIterator[bytes]:
    """边流式产出边累积,正常走完后原子落缓存(半截失败不留脏文件)。"""
    chunks: list[bytes] = []
    async for chunk in synthesize_mp3(creds, text):
        chunks.append(chunk)
        yield chunk
    if not chunks:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_bytes(b"".join(chunks))
    tmp.replace(target)


async def prewarm_texts(
    creds: dict[str, str], texts: list[str], root: Path, tenant_id: str
) -> None:
    """批量预合成入缓存(后台任务):串行+单租户锁,失败逐条记日志不中断。"""
    vcn = creds.get("vcn") or DEFAULT_VCN
    done = skipped = failed = 0
    for text in texts:
        target = cache_path(root, tenant_id, vcn, text)
        if target.exists():
            skipped += 1
            continue
        try:
            async with tenant_lock(tenant_id):
                async for _ in synthesize_to_cache(creds, text, target):
                    pass
            done += 1
        except Exception:
            failed += 1
            logger.exception("tts prewarm 单条失败(继续): %.30r", text)
    logger.info(
        "tts prewarm done: tenant=%s synthesized=%d cached_already=%d failed=%d",
        tenant_id, done, skipped, failed,
    )


__all__ = [
    "MAX_TEXT_LEN",
    "cache_path",
    "prewarm_texts",
    "synthesize_mp3",
    "synthesize_to_cache",
    "tenant_lock",
]
