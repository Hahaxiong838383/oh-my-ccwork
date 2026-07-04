# mypy: ignore-errors
"""火山 TTS WebSocket 连接池(R3b,2026-07-03)—— 每句合成不再新建连接。

现状痛点:``doubao_speech.tts_stream`` 一次调用 = 新 WS(TCP+TLS+握手 ~150-250ms)
+ StartConnection + session + FinishConnection + 关闭。每句回复都付一次建连税。

协议依据(_ws_client.py 精读,connection/session 两层分离):
    StartConnection → ConnectionStarted            # 连接级,一次
    ┌ StartSession(uuid) → SessionStarted          # 会话级,可循环
    │ TaskRequest(text) → FinishSession
    │ AudioOnlyServer... → TTSEnded/SessionFinished
    └───────────────────────────────────────────── # 不发 FinishConnection,连接保留
⚠️ 复用铁律:**每个 session 必须收到 SessionFinished 才算干净**(TTSEnded 后若直接开
下一 session,残留的 SessionFinished 帧会污染下一句的接收循环)。

风控:任何池路径异常 → 标记连接 dead → 上层(volc_tts)降级走原 tts_stream 一次性
连接,保可用;TTS_POOL_ENABLED=0 整体关闭。进程级单例池(同 LLM client pool 模式,
livekit job 进程内跨句/跨 turn 复用);websockets ping 20s 保活,闲置被服务端断开
靠"用时检测+丢弃重建"兜底。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

logger = logging.getLogger("voice_agent.volc_tts_pool")

_POOL_MAX = 4  # 弹性上限(StreamAdapter 并发句一般 ≤2-3)


class PooledTTSConnection:
    """一条已完成 StartConnection 握手的火山 TTS 连接;串行跑多个 session。"""

    def __init__(self, app_id: str, access_token: str, resource_id: str) -> None:
        self._app_id = app_id
        self._access_token = access_token
        self._resource_id = resource_id
        self._ws: Any = None
        self._lock = asyncio.Lock()  # 一条连接同时只跑一个 session
        self.dead = False

    async def connect(self, timeout: float = 10.0) -> None:  # noqa: ASYNC109 — 透传 doubao_speech 签名
        import websockets
        from doubao_speech._ws_client import (
            TTS_URL,
            Event,
            Flags,
            Message,
            MsgType,
            _build_headers,
            _recv,
            _send,
        )

        headers = _build_headers(self._app_id, self._access_token, self._resource_id, None)
        self._ws = await asyncio.wait_for(
            websockets.connect(
                TTS_URL,
                additional_headers=headers,
                max_size=16 * 1024 * 1024,
                open_timeout=timeout,
                ping_interval=20,
                ping_timeout=20,
                proxy=None,
            ),
            timeout=timeout,
        )
        await _send(
            self._ws,
            Message(
                type=MsgType.FullClientRequest,
                flag=Flags.WithEvent,
                event=Event.StartConnection,
                payload=b"{}",
            ),
        )
        msg = await _recv(self._ws, timeout)
        if msg.event != Event.ConnectionStarted:
            raise RuntimeError(f"tts pool: expected ConnectionStarted, got {msg.event!r}")
        logger.info("tts pool: connection ready")

    async def synthesize(
        self,
        text: str,
        *,
        speaker: str,
        audio_format: str,
        sample_rate: int,
        speed_ratio: float,
        timeout: float = 30.0,  # noqa: ASYNC109 — 透传 doubao_speech 签名
    ) -> AsyncIterator[bytes]:
        """在既有连接上跑一个完整 session,逐 chunk yield 音频。异常时置 dead。"""
        from doubao_speech._ws_client import Event, Flags, Message, MsgType, _recv, _send

        speech_rate = max(-50, min(100, round((speed_ratio - 1.0) * 100)))
        req_params: dict[str, Any] = {
            "speaker": speaker,
            "audio_params": {
                "format": audio_format,
                "sample_rate": sample_rate,
                "speech_rate": speech_rate,
            },
        }
        session_id = str(uuid.uuid4())
        base_payload = {
            "user": {"uid": session_id},
            "namespace": "BidirectionalTTS",
            "req_params": req_params,
        }
        async with self._lock:
            if self.dead or self._ws is None:
                raise RuntimeError("tts pool: connection dead")
            try:
                # StartSession
                start_payload = dict(base_payload, event=int(Event.StartSession))
                await _send(
                    self._ws,
                    Message(
                        type=MsgType.FullClientRequest,
                        flag=Flags.WithEvent,
                        event=Event.StartSession,
                        session_id=session_id,
                        payload=json.dumps(start_payload, ensure_ascii=False).encode("utf-8"),
                    ),
                )
                msg = await _recv(self._ws, timeout)
                if msg.event != Event.SessionStarted:
                    raise RuntimeError(f"tts pool: expected SessionStarted, got {msg.event!r}")
                # TaskRequest + FinishSession(告知无更多文本)
                task_payload = dict(base_payload, event=int(Event.TaskRequest))
                task_payload["req_params"] = dict(req_params, text=text)
                await _send(
                    self._ws,
                    Message(
                        type=MsgType.FullClientRequest,
                        flag=Flags.WithEvent,
                        event=Event.TaskRequest,
                        session_id=session_id,
                        payload=json.dumps(task_payload, ensure_ascii=False).encode("utf-8"),
                    ),
                )
                await _send(
                    self._ws,
                    Message(
                        type=MsgType.FullClientRequest,
                        flag=Flags.WithEvent,
                        event=Event.FinishSession,
                        session_id=session_id,
                        payload=b"{}",
                    ),
                )
                # 收音频;复用铁律:必须收到 SessionFinished 才把连接放回池
                got_session_finished = False
                while True:
                    msg = await _recv(self._ws, timeout)
                    if msg.type == MsgType.AudioOnlyServer:
                        if msg.payload:
                            yield msg.payload
                    elif msg.type == MsgType.FullServerResponse:
                        if msg.event == Event.SessionFinished:
                            got_session_finished = True
                            break
                        if msg.event == Event.TTSEnded:
                            continue  # 等 SessionFinished 收尾
                        if msg.event in (
                            Event.TTSResponse,
                            Event.TTSSentenceStart,
                            Event.TTSSentenceEnd,
                        ):
                            continue
                if not got_session_finished:  # pragma: no cover — 防御
                    raise RuntimeError("tts pool: session not finished cleanly")
            except BaseException:
                # 协议错/超时/取消(barge-in 中途弃流)→ 连接内有残留帧,不可复用
                self.dead = True
                with contextlib.suppress(Exception):
                    await self._ws.close()
                raise

    async def aclose(self) -> None:
        self.dead = True
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()


class TTSConnectionPool:
    """进程级连接池:acquire 复用/新建,release 活连接回池、死连接丢弃。"""

    def __init__(self, app_id: str, access_token: str, resource_id: str) -> None:
        self._app_id = app_id
        self._access_token = access_token
        self._resource_id = resource_id
        self._idle: list[PooledTTSConnection] = []

    async def acquire(self) -> PooledTTSConnection:
        while self._idle:
            conn = self._idle.pop()
            if not conn.dead:
                return conn
        conn = PooledTTSConnection(self._app_id, self._access_token, self._resource_id)
        await conn.connect()
        return conn

    def release(self, conn: PooledTTSConnection) -> None:
        if not conn.dead and len(self._idle) < _POOL_MAX:
            self._idle.append(conn)
        else:
            asyncio.get_event_loop().create_task(conn.aclose())

    async def prewarm(self, n: int = 1) -> None:
        """job 启动时预建连接(藏进用户说首句的窗口,首句 TTS 零建连)。静默失败。"""
        try:
            conns = []
            for _ in range(n):
                conn = PooledTTSConnection(self._app_id, self._access_token, self._resource_id)
                await conn.connect()
                conns.append(conn)
            self._idle.extend(conns)
            logger.info("tts pool: prewarmed %d connection(s)", len(conns))
        except Exception:
            logger.warning("tts pool: prewarm failed(首句将现场建连,不影响可用)", exc_info=True)


_POOL: TTSConnectionPool | None = None


def get_pool(app_id: str, access_token: str, resource_id: str) -> TTSConnectionPool:
    """进程级单例(凭据首个使用者锁定;本项目单一凭据,无冲突)。"""
    global _POOL
    if _POOL is None:
        _POOL = TTSConnectionPool(app_id, access_token, resource_id)
    return _POOL


__all__ = ["PooledTTSConnection", "TTSConnectionPool", "get_pool"]
