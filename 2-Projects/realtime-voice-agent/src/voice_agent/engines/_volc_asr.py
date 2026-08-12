# mypy: ignore-errors
"""Vendored 火山流式 ASR 客户端 —— 给 doubao_speech.asr_stream 补判停参数。

⚠️ 这是 ``doubao_speech._ws_client.asr_stream`` 的 vendored 副本(对齐安装版),
**唯一改动 = 在 ``init_payload["request"]`` 注入火山原生判停参数**:

- ``end_window_size``:      句末静音判停窗(ms)。火山默认 ≈2900ms,是 cascade 判停慢的主犯。
                           dev198 真连火山 PoC 实测:判停延迟 ≈ 该值(线性),设 800 → 判停 2.9s→~0.8s。
- ``force_to_speech_time``: 强制语音起始时间(ms)。
- ``vad_segment_duration``: VAD 切句静音(ms)。

封装层 ``doubao_speech.asr_stream`` 没暴露这些字段(只传 model_name/enable_*/show_utterances),
但火山协议本身支持(官方 iOS SDK 示例 + dev198 PoC 双重实证)。
详见记忆 ``feedback_volc_asr_end_window_size_eou_tuning``。

⚠️ 切碎:``end_window_size`` 调小后,句中停顿(≥窗口,含自然尾音)会被火山误判句末切成多句。
单参数不能既快又不切碎,真机若切碎严重需上 hybrid(LiveKit turn detector 重聚合)。

🔁 同步纪律:协议原语(Message / MsgType / _send / _recv / _audio_chunks_from_source …)走 import
**复用而非复制**,故协议层升级自动跟随;仅 asr_stream 的「装配逻辑」是 vendored。doubao-speech
升级若改了 asr_stream 的装配流程,需手动比对 scratchpad 的上游副本同步本文件。
"""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import json
import logging
from collections.abc import AsyncGenerator, AsyncIterator
from pathlib import Path

import websockets

# 复用 doubao_speech 协议原语(模块级符号,协议层升级自动跟随,不复制)
from doubao_speech._ws_client import (  # type: ignore[import-not-found]
    ASR_URL,
    Compression,
    Flags,
    Message,
    MsgType,
    Serialization,
    VolcengineAuthError,
    VolcengineTimeoutError,
    VolcengineVoiceError,
    _audio_chunks_from_source,
    _build_headers,
    _recv,
    _resolve_credentials,
    _send,
)
from websockets.exceptions import WebSocketException

logger = logging.getLogger("voice_agent.volc_asr")


async def asr_stream(
    audio_source: AsyncIterator[bytes] | bytes | str | Path,
    *,
    audio_format: str = "wav",
    codec: str = "raw",
    sample_rate: int = 16000,
    bits: int = 16,
    channel: int = 1,
    model_name: str = "bigmodel",
    enable_itn: bool = True,
    enable_punc: bool = True,
    enable_ddc: bool = True,
    show_utterances: bool = True,
    segment_duration_ms: int = 200,
    end_window_size: int | None = None,
    force_to_speech_time: int | None = None,
    vad_segment_duration: int | None = None,
    hotwords: list[str] | None = None,
    app_id: str | None = None,
    access_token: str | None = None,
    api_key: str | None = None,
    resource_id: str = "volc.bigasr.sauc.duration",
    request_id: str | None = None,
    timeout: float = 30.0,  # noqa: ASYNC109 — vendored:保持 doubao_speech.asr_stream 签名兼容
) -> AsyncGenerator[dict, None]:
    """同 ``doubao_speech.asr_stream``:额外支持 ``end_window_size`` 判停参数 + 新版 X-Api-Key。"""
    import uuid as _uuid

    if api_key:
        # 新版控制台单 key 鉴权(X-Api-Key)。seedasr 2.0(豆包 ASR 2.0)实测必须走此方式——
        # 旧版 app_id+access_token 对 seedasr 报 "resourceId not allowed"(2026-06-29 实测)。
        headers = {
            "X-Api-Key": api_key,
            "X-Api-Resource-Id": resource_id,
            "X-Api-Request-Id": request_id or str(_uuid.uuid4()),
            "X-Api-Connect-Id": str(_uuid.uuid4()),
        }
    else:
        app_id, access_token = _resolve_credentials(app_id, access_token)
        headers = _build_headers(app_id, access_token, resource_id, request_id)

    wire_format = audio_format
    wire_codec = codec
    if not hasattr(audio_source, "__aiter__"):
        wire_format = "pcm"
        wire_codec = "raw"

    segment_bytes = max(1, sample_rate * (bits // 8) * channel * segment_duration_ms // 1000)

    request = {
        "model_name": model_name,
        "enable_itn": enable_itn,
        "enable_punc": enable_punc,
        "enable_ddc": enable_ddc,
        "show_utterances": show_utterances,
        "enable_nonstream": False,
    }
    # ★ vendored 唯一改动:注入火山原生判停参数(None 则不传,保持上游默认行为)
    if end_window_size is not None:
        request["end_window_size"] = end_window_size
    if force_to_speech_time is not None:
        request["force_to_speech_time"] = force_to_speech_time
    if vad_segment_duration is not None:
        request["vad_segment_duration"] = vad_segment_duration
    if hotwords:
        # 热词(2026-08-12 矩阵实验):火山话语检测对孤立短指令(停/好/对)经常整段丢弃
        # (ddc/force_to_speech_time/增益全无效,唯热词能捞回);语气词不配=环境音免疫保留。
        # 形状单源在 volc_stt.build_hotwords_corpus(懒加载防循环,该模块无重依赖可单测)。
        from .volc_stt import build_hotwords_corpus

        request["corpus"] = build_hotwords_corpus(hotwords)

    init_payload = {
        "user": {"uid": headers["X-Api-Request-Id"]},
        "audio": {
            "format": wire_format,
            "codec": wire_codec,
            "rate": sample_rate,
            "bits": bits,
            "channel": channel,
        },
        "request": request,
    }

    logger.info(
        "asr: connecting (model=%s, rate=%d, end_window_size=%s, hotwords=%d)",
        model_name,
        sample_rate,
        end_window_size,
        len(hotwords or []),
    )
    try:
        ws = await asyncio.wait_for(
            websockets.connect(
                ASR_URL,
                additional_headers=headers,
                max_size=16 * 1024 * 1024,
                open_timeout=timeout,
                ping_interval=20,
                ping_timeout=20,
                proxy=None,
            ),
            timeout=timeout,
        )
    except TimeoutError as e:
        raise VolcengineTimeoutError(f"asr connect timed out ({timeout}s)") from e
    except WebSocketException as e:
        text_ = str(e)
        if "401" in text_ or "403" in text_ or "auth" in text_.lower():
            raise VolcengineAuthError(f"asr handshake rejected: {e}") from e
        raise VolcengineVoiceError(f"asr handshake failed: {e}") from e
    except OSError as e:
        raise VolcengineVoiceError(f"asr connection failed: {e}") from e

    seq = 1
    init_bytes = gzip.compress(json.dumps(init_payload, ensure_ascii=False).encode("utf-8"))
    init_msg = Message(
        type=MsgType.FullClientRequest,
        flag=Flags.PositiveSeq,
        serialization=Serialization.JSON,
        compression=Compression.Gzip,
        sequence=seq,
        payload=init_bytes,
    )

    recv_queue: asyncio.Queue[dict | Exception | None] = asyncio.Queue()

    async def receiver() -> None:
        try:
            while True:
                msg = await _recv(ws, timeout)
                payload = msg.json_payload()
                if msg.type == MsgType.FullServerResponse and isinstance(payload, dict):
                    result = payload.get("result")
                    if isinstance(result, dict):
                        out = {
                            "text": result.get("text", ""),
                            "is_final": bool(result.get("is_final", False))
                            or bool(msg.flag & Flags.LastNoSeq),
                            "utterances": result.get("utterances", []) or [],
                            "raw": payload,
                        }
                        await recv_queue.put(out)
                        if out["is_final"] or (msg.flag & Flags.LastNoSeq):
                            break
                    elif msg.flag & Flags.LastNoSeq:
                        break
                elif msg.type == MsgType.Error:
                    # _recv already raises; unreachable
                    break
        except (TimeoutError, VolcengineVoiceError, WebSocketException) as e:
            await recv_queue.put(e if isinstance(e, Exception) else Exception(str(e)))
        except Exception as e:
            await recv_queue.put(VolcengineVoiceError(f"asr receiver failed: {e}"))
        finally:
            await recv_queue.put(None)

    async def sender() -> None:
        nonlocal seq
        try:
            await _send(ws, init_msg)
            seq += 1

            # Buffer one chunk ahead so we can flag the *last* one correctly.
            prev: bytes | None = None
            async for chunk in _audio_chunks_from_source(
                audio_source,
                audio_format=audio_format,
                segment_bytes=segment_bytes,
                sample_rate=sample_rate,
            ):
                if prev is not None:
                    await _send(
                        ws,
                        Message(
                            type=MsgType.AudioOnlyClient,
                            flag=Flags.PositiveSeq,
                            serialization=Serialization.JSON,
                            compression=Compression.Gzip,
                            sequence=seq,
                            payload=gzip.compress(prev),
                        ),
                    )
                    seq += 1
                prev = chunk

            # Final chunk (empty if source was empty)
            final_bytes = prev if prev is not None else b""
            await _send(
                ws,
                Message(
                    type=MsgType.AudioOnlyClient,
                    flag=Flags.NegativeSeq,
                    serialization=Serialization.JSON,
                    compression=Compression.Gzip,
                    sequence=-seq,
                    payload=gzip.compress(final_bytes),
                ),
            )
        except (TimeoutError, VolcengineVoiceError, WebSocketException) as e:
            await recv_queue.put(e if isinstance(e, Exception) else Exception(str(e)))
        except Exception as e:
            await recv_queue.put(VolcengineVoiceError(f"asr sender failed: {e}"))

    recv_task = asyncio.create_task(receiver(), name="volc-asr-recv")
    send_task = asyncio.create_task(sender(), name="volc-asr-send")

    try:
        while True:
            item = await recv_queue.get()
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            yield item
            if item.get("is_final"):
                break
    finally:
        for t in (send_task, recv_task):
            if not t.done():
                t.cancel()
        for t in (send_task, recv_task):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        with contextlib.suppress(WebSocketException):
            await ws.close()


__all__ = ["asr_stream"]
