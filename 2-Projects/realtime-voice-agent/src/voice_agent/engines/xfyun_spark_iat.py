"""讯飞中文识别大模型(spark iat) → LiveKit STT plugin(对话线,解碎句,2026-07-28)。

为什么换这条线(同事 cc 调研 + 官方文档 + RedAlert/websdk-java 生产实现交叉验证):
"实时语音转写大模型"是会议转写定位,逐小句 definite 且无断句参数 → 碎句风暴;
spark iat(wss://iat.xf-yun.com/v1)有 **parameter.iat.eos 静音断句(毫秒)**——服务端
等真停顿才出最终结果,天然对齐"turn"语义。

回合制会话模型(60s 单会话上限天然碰不到):
  IDLE(静音,零会话零计费) --幅度检测到说话--> ACTIVE(开 ws,首帧带预滚 buffer 防吃字)
  ACTIVE 持续发 status=1 帧(短停顿也发,服务端 eos 管断句)
  服务端 eos 到 → status=2 最终结果 → FINAL emit → 关会话回 IDLE
安全阀:会话 >50s 主动收尾重开(防撞 60s 硬限)。

协议要点(生产实现实锤):
- 鉴权与超拟人 TTS 同套(build_xfyun_auth_ws_url,endpoint 换 iat);
- parameter.iat: domain=slm/language=zh_cn/accent=mandarin/dwa=wpgs/eos=毫秒/
  result={encoding:utf8,compress:raw,format:plain}(⚠️ plain 非 json,RedAlert 实锤);
- 响应 payload.result.text = base64(JSON),解出 ws[].cw[].w 拼文本,sn/pgs/rg 同层;
- dwa=wpgs 必开:流式中间结果是字数门(防误打断)的生命线,不开=无 interim=打不断。
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Never

import aiohttp
import numpy as np
from livekit.agents.language import LanguageCode
from livekit.agents.stt import (
    STT,
    RecognizeStream,
    SpeechData,
    SpeechEvent,
    SpeechEventType,
    STTCapabilities,
)
from livekit.agents.types import (
    DEFAULT_API_CONNECT_OPTIONS,
    NOT_GIVEN,
    APIConnectOptions,
    NotGivenOr,
)
from livekit.agents.utils.audio import AudioByteStream

from .xfyun_common import build_xfyun_auth_ws_url

logger = logging.getLogger("voice_agent.xfyun_spark_iat")

SPARK_IAT_WS_URL = "wss://iat.xf-yun.com/v1"
IAT_SR = 16000
_FRAME_SAMPLES = IAT_SR * 40 // 1000  # 官方建议 40ms/1280B
_PREROLL_FRAMES = 10  # 预滚 ~400ms:说话检测有滞后,首帧连预滚一起发防吃首字
_SESSION_HARD_LIMIT_S = 50.0  # 60s 硬限前主动收尾


def _mean_abs_amp(chunk: bytes) -> float:
    if len(chunk) < 2:
        return 0.0
    arr = np.frombuffer(chunk[: len(chunk) // 2 * 2], dtype=np.int16)
    return float(np.abs(arr.astype(np.int32)).mean())


class WpgsAssembler:
    """dwa=wpgs 动态修正拼接:segs[sn]=text,pgs=rpl 时作废 rg=[a,b] 范围旧句(纯逻辑可单测)。"""

    def __init__(self) -> None:
        self._segs: dict[int, str] = {}

    def feed(self, sn: int, pgs: str | None, rg: list[int] | None, text: str) -> str:
        if pgs == "rpl" and rg and len(rg) == 2:
            for k in [k for k in self._segs if rg[0] <= k <= rg[1]]:
                del self._segs[k]
        self._segs[sn] = text
        return "".join(self._segs[k] for k in sorted(self._segs))

    def current(self) -> str:
        return "".join(self._segs[k] for k in sorted(self._segs))


@dataclass(frozen=True)
class IatFrame:
    kind: str  # result | error | ignore
    status: int = 0  # header.status: 2=会话结束
    sn: int = 0
    pgs: str | None = None
    rg: list[int] | None = None
    text: str = ""
    detail: str = ""


def parse_iat_frame(raw: str) -> IatFrame:
    """下行帧解析(纯函数):payload.result.text 是 base64(JSON),sn/pgs/rg/ws 都在解码后 JSON 里。"""
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return IatFrame(kind="ignore", detail="non-json")
    header = obj.get("header") or {}
    code = header.get("code")
    if code not in (0, None):
        return IatFrame(kind="error", detail=f"code={code} message={header.get('message', '')}")
    status = int(header.get("status") or 0)
    b64 = ((obj.get("payload") or {}).get("result") or {}).get("text") or ""
    if not b64:
        return IatFrame(kind="result" if status == 2 else "ignore", status=status)
    try:
        inner = json.loads(base64.b64decode(b64).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return IatFrame(kind="ignore", status=status, detail="text-not-json")
    words: list[str] = []
    for ws in inner.get("ws") or []:
        for cw in (ws or {}).get("cw") or []:
            words.append(str(cw.get("w") or ""))
    return IatFrame(
        kind="result",
        status=status,
        sn=int(inner.get("sn") or 0),
        pgs=inner.get("pgs"),
        rg=inner.get("rg"),
        text="".join(words),
    )


def build_iat_frame_payload(
    *,
    app_id: str,
    status: int,
    audio_b64: str,
    eos_ms: int,
    with_parameter: bool,
) -> dict:
    """上行帧(纯函数):首帧 status=0 必带 parameter.iat(eos 在此);后续帧只发音频。"""
    d: dict[str, Any] = {
        "header": {"app_id": app_id, "status": status},
        "payload": {
            "audio": {
                "audio": audio_b64,
                "sample_rate": IAT_SR,
                "encoding": "raw",
                "channels": 1,
                "bit_depth": 16,
                "status": status,
            }
        },
    }
    if with_parameter:
        d["parameter"] = {
            "iat": {
                "domain": "slm",
                "language": "zh_cn",
                "accent": "mandarin",
                "dwa": "wpgs",  # 流式中间结果=字数门生命线,必开
                "eos": eos_ms,
                "result": {"encoding": "utf8", "compress": "raw", "format": "plain"},
            }
        }
    return d


class XfyunSparkIatSTT(STT[Never]):
    """讯飞中文识别大模型(凭据经 factory 从租户加密存储注入)。"""

    def __init__(
        self,
        *,
        app_id: str,
        api_key: str,
        api_secret: str,
        eos_ms: int = 700,
        speech_amp: float = 250.0,
        language: str = "zh-CN",
    ) -> None:
        super().__init__(capabilities=STTCapabilities(streaming=True, interim_results=True))
        self._app_id = app_id
        self._api_key = api_key
        self._api_secret = api_secret
        self._eos_ms = eos_ms
        self._speech_amp = speech_amp
        self._language = language

    async def _recognize_impl(
        self,
        buffer: object,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> SpeechEvent:
        raise NotImplementedError("spark iat 仅流式,请用 stream()")

    def stream(
        self,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> XfyunSparkIatStream:
        return XfyunSparkIatStream(self, conn_options=conn_options)


@dataclass
class _Session:
    ws: aiohttp.ClientWebSocketResponse
    recv_task: asyncio.Task
    assembler: WpgsAssembler = field(default_factory=WpgsAssembler)
    started_at: float = field(default_factory=time.monotonic)
    first_frame_sent: bool = False
    closed: bool = False


class XfyunSparkIatStream(RecognizeStream):
    """回合制:说话触发开会话(带预滚),服务端 eos 出 final 即收会话,静音期零连接。"""

    def __init__(self, stt_: XfyunSparkIatSTT, *, conn_options: APIConnectOptions) -> None:
        super().__init__(stt=stt_, conn_options=conn_options, sample_rate=IAT_SR)
        self._xf = stt_
        self._preroll: deque[bytes] = deque(maxlen=_PREROLL_FRAMES)
        self._session: _Session | None = None
        self._http: aiohttp.ClientSession | None = None

    def _emit(self, text: str, *, final: bool) -> None:
        text = text.strip()
        if not text:
            return
        if final:
            logger.info("stt final: %s", text)
        ev = SpeechEventType.FINAL_TRANSCRIPT if final else SpeechEventType.INTERIM_TRANSCRIPT
        alt = SpeechData(language=LanguageCode(self._xf._language), text=text)
        self._event_ch.send_nowait(SpeechEvent(type=ev, alternatives=[alt]))

    async def _open_session(self) -> None:
        assert self._http is not None
        url = build_xfyun_auth_ws_url(self._xf._api_key, self._xf._api_secret, SPARK_IAT_WS_URL)
        ws = await self._http.ws_connect(url, timeout=aiohttp.ClientWSTimeout(ws_close=10))
        session = _Session(ws=ws, recv_task=None)  # type: ignore[arg-type]
        session.recv_task = asyncio.create_task(
            self._recv_loop(session), name="xfyun_iat_recv"
        )
        self._session = session

    async def _recv_loop(self, session: _Session) -> None:
        try:
            while True:
                msg = await session.ws.receive()
                if msg.type in (
                    aiohttp.WSMsgType.CLOSED,
                    aiohttp.WSMsgType.CLOSE,
                    aiohttp.WSMsgType.CLOSING,
                    aiohttp.WSMsgType.ERROR,
                ):
                    break
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                frame = parse_iat_frame(msg.data)
                if frame.kind == "error":
                    logger.error("spark iat 错误帧: %s", frame.detail)
                    break
                if frame.kind != "result":
                    if frame.status == 2:
                        break
                    continue
                if frame.text:
                    merged = session.assembler.feed(frame.sn, frame.pgs, frame.rg, frame.text)
                    self._emit(merged, final=False)
                if frame.status == 2:
                    final_text = session.assembler.current()
                    self._emit(final_text, final=True)
                    break
        finally:
            session.closed = True
            with contextlib.suppress(Exception):
                await session.ws.close()

    async def _send_audio(self, chunk: bytes) -> None:
        """ACTIVE 会话内发帧;首帧 status=0 带 parameter+预滚。"""
        session = self._session
        if session is None or session.closed:
            return
        try:
            if not session.first_frame_sent:
                preroll = b"".join(self._preroll)
                self._preroll.clear()
                payload = build_iat_frame_payload(
                    app_id=self._xf._app_id,
                    status=0,
                    audio_b64=base64.b64encode(preroll + chunk).decode("ascii"),
                    eos_ms=self._xf._eos_ms,
                    with_parameter=True,
                )
                session.first_frame_sent = True
            else:
                payload = build_iat_frame_payload(
                    app_id=self._xf._app_id,
                    status=1,
                    audio_b64=base64.b64encode(chunk).decode("ascii"),
                    eos_ms=self._xf._eos_ms,
                    with_parameter=False,
                )
            await session.ws.send_str(json.dumps(payload))
        except (ConnectionError, aiohttp.ClientError):
            session.closed = True

    async def _finalize_session(self) -> None:
        """主动收尾(超时保护/流关闭):发 status=2 空帧,等 recv 收 final。"""
        session = self._session
        if session is None:
            return
        self._session = None
        if not session.closed and session.first_frame_sent:
            with contextlib.suppress(Exception):
                await session.ws.send_str(
                    json.dumps(
                        build_iat_frame_payload(
                            app_id=self._xf._app_id,
                            status=2,
                            audio_b64="",
                            eos_ms=self._xf._eos_ms,
                            with_parameter=False,
                        )
                    )
                )
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(session.recv_task), timeout=3)
        if not session.recv_task.done():
            session.recv_task.cancel()
        with contextlib.suppress(BaseException):
            await session.recv_task

    async def _run(self) -> None:
        self._http = aiohttp.ClientSession()
        bstream = AudioByteStream(
            sample_rate=IAT_SR, num_channels=1, samples_per_channel=_FRAME_SAMPLES
        )
        try:
            async for data in self._input_ch:
                frames = (
                    bstream.flush()
                    if isinstance(data, RecognizeStream._FlushSentinel)
                    else bstream.write(bytes(data.data))
                )
                for f in frames:
                    chunk = bytes(f.data)
                    session = self._session
                    # 会话结束(服务端 eos 出了 final)→ 清引用回 IDLE
                    if session is not None and session.closed:
                        await self._finalize_session()
                        session = None
                    if session is None:
                        if _mean_abs_amp(chunk) >= self._xf._speech_amp:
                            await self._open_session()
                            await self._send_audio(chunk)
                        else:
                            self._preroll.append(chunk)  # IDLE:攒预滚,零连接零计费
                        continue
                    # 超时保护:60s 硬限前主动收尾,下一帧有声再开新会话
                    if time.monotonic() - session.started_at > _SESSION_HARD_LIMIT_S:
                        await self._finalize_session()
                        self._preroll.append(chunk)
                        continue
                    await self._send_audio(chunk)
        finally:
            await self._finalize_session()
            if self._http is not None:
                with contextlib.suppress(Exception):
                    await self._http.close()


__all__ = [
    "IatFrame",
    "SPARK_IAT_WS_URL",
    "WpgsAssembler",
    "XfyunSparkIatSTT",
    "XfyunSparkIatStream",
    "build_iat_frame_payload",
    "parse_iat_frame",
]
