"""讯飞大模型实时转写 → LiveKit STT plugin(租户 provider,2026-07-27)。

协议(官方文档 + livekit-plugins-xunfei 骨架参考,鉴权/endpoint 按大模型版重写):
- wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1?<签名 query>
  (签名见 xfyun_common.build_stt_llm_ws_url;与标准版 rtasr.xfyun.cn 不同源不同鉴权)
- 上行:裸 PCM16 16k mono 二进制帧,建议 40ms/1280B;结束发 {"end": true}
- 下行:data.cn.st.type "1"=中间(interim) "0"=确定(final);文本 rt[].ws[].cw[0].w 拼接
- interim/final 映射与字数门直接兼容(interim 无字→环境音免疫,继承生产门控)。

范围说明:demo 租户版,不带 volc_stt 的 S1 投机/声纹 ring/顺滑观测(那些是主链路深调)。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from dataclasses import dataclass
from typing import Never

import aiohttp
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

from .xfyun_common import build_stt_llm_ws_url

logger = logging.getLogger("voice_agent.xfyun_stt")

XFYUN_STT_SR = 16000
_FRAME_SAMPLES = XFYUN_STT_SR * 40 // 1000  # 官方建议 40ms/1280B


@dataclass(frozen=True)
class SttFrame:
    kind: str  # started | result | error | ignore
    text: str = ""
    is_final: bool = False
    session_id: str = ""
    detail: str = ""


def parse_stt_frame(raw: str) -> SttFrame:
    """下行帧防御式解析(纯函数,可单测)。兼容两种信封:
    标准版风格 data 为 JSON 字符串;大模型版 data 直接为对象。心跳/未知帧 → ignore。"""
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return SttFrame(kind="ignore", detail="non-json")
    if not isinstance(obj, dict):
        return SttFrame(kind="ignore")
    action = obj.get("action")
    if action == "started":
        return SttFrame(kind="started", session_id=str(obj.get("sid") or obj.get("sessionId") or ""))
    if action == "error" or (obj.get("code") not in (None, 0, "0") and "data" not in obj):
        return SttFrame(kind="error", detail=raw[:300])
    data = obj.get("data")
    if data is None:
        return SttFrame(kind="ignore")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            return SttFrame(kind="ignore", detail="data-not-json")
    if not isinstance(data, dict):
        return SttFrame(kind="ignore")
    st = data.get("cn", {}).get("st") if isinstance(data.get("cn"), dict) else None
    if not isinstance(st, dict):
        return SttFrame(kind="ignore")
    words: list[str] = []
    for rt in st.get("rt") or []:
        for ws in (rt or {}).get("ws") or []:
            cw = (ws or {}).get("cw") or []
            if cw and isinstance(cw[0], dict):
                words.append(str(cw[0].get("w") or ""))
    return SttFrame(kind="result", text="".join(words), is_final=str(st.get("type")) == "0")


class XfyunSTT(STT[Never]):
    """讯飞大模型实时转写(凭据来自租户加密存储,经 factory 注入)。"""

    def __init__(
        self,
        *,
        app_id: str,
        access_key_id: str,
        access_key_secret: str,
        lang: str = "autodialect",
        language: str = "zh-CN",
    ) -> None:
        super().__init__(capabilities=STTCapabilities(streaming=True, interim_results=True))
        self._app_id = app_id
        self._access_key_id = access_key_id
        self._access_key_secret = access_key_secret
        self._lang = lang
        self._language = language

    async def _recognize_impl(
        self,
        buffer: object,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> SpeechEvent:
        raise NotImplementedError("讯飞实时转写仅流式,请用 stream()")

    def stream(
        self,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> XfyunRecognizeStream:
        return XfyunRecognizeStream(self, conn_options=conn_options)


class XfyunRecognizeStream(RecognizeStream):
    """pump LiveKit 帧 → 40ms PCM 上行;下行 type 1/0 → INTERIM/FINAL。"""

    def __init__(self, stt_: XfyunSTT, *, conn_options: APIConnectOptions) -> None:
        super().__init__(stt=stt_, conn_options=conn_options, sample_rate=XFYUN_STT_SR)
        self._xf = stt_

    def _emit(self, text: str, *, final: bool) -> None:
        text = text.strip()
        if not text:
            return
        ev = SpeechEventType.FINAL_TRANSCRIPT if final else SpeechEventType.INTERIM_TRANSCRIPT
        if final:
            logger.info("stt final: %s", text)
        alt = SpeechData(language=LanguageCode(self._xf._language), text=text)
        self._event_ch.send_nowait(SpeechEvent(type=ev, alternatives=[alt]))

    async def _run(self) -> None:
        # 每次连接现签 URL(utc 时效);会话 id 供 end 帧回带(started 帧若提供)
        url = build_stt_llm_ws_url(
            self._xf._app_id,
            self._xf._access_key_id,
            self._xf._access_key_secret,
            lang=self._xf._lang,
            samplerate=XFYUN_STT_SR,
        )
        session_id = ""
        async with aiohttp.ClientSession() as http:
            try:
                ws = await http.ws_connect(url, timeout=aiohttp.ClientWSTimeout(ws_close=10))
            except aiohttp.WSServerHandshakeError as e:
                logger.error("讯飞转写握手失败 HTTP %s(检查 accessKey 凭据)", e.status)
                raise
            try:

                async def send_task() -> None:
                    bstream = AudioByteStream(
                        sample_rate=XFYUN_STT_SR,
                        num_channels=1,
                        samples_per_channel=_FRAME_SAMPLES,
                    )
                    async for data in self._input_ch:
                        frames = (
                            bstream.flush()
                            if isinstance(data, RecognizeStream._FlushSentinel)
                            else bstream.write(bytes(data.data))
                        )
                        for f in frames:
                            await ws.send_bytes(bytes(f.data))
                    # 输入通道关闭 = 本轮结束,通知服务端出最终结果
                    end: dict[str, object] = {"end": True}
                    if session_id:
                        end["sessionId"] = session_id
                    with contextlib.suppress(Exception):
                        await ws.send_str(json.dumps(end))

                async def recv_task() -> None:
                    nonlocal session_id
                    while True:
                        msg = await ws.receive()
                        if msg.type in (
                            aiohttp.WSMsgType.CLOSED,
                            aiohttp.WSMsgType.CLOSE,
                            aiohttp.WSMsgType.CLOSING,
                            aiohttp.WSMsgType.ERROR,
                        ):
                            return
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        frame = parse_stt_frame(msg.data)
                        if frame.kind == "started":
                            session_id = frame.session_id
                        elif frame.kind == "error":
                            logger.error("讯飞转写错误帧: %s", frame.detail)
                        elif frame.kind == "result":
                            self._emit(frame.text, final=frame.is_final)

                sender = asyncio.create_task(send_task(), name="xfyun_stt_send")
                receiver = asyncio.create_task(recv_task(), name="xfyun_stt_recv")
                try:
                    done, pending = await asyncio.wait(
                        {sender, receiver}, return_when=asyncio.FIRST_EXCEPTION
                    )
                    for t in done:
                        t.result()  # 冒泡异常给基类(其 retry 策略接管)
                finally:
                    for t in (sender, receiver):
                        if not t.done():
                            t.cancel()
                    with contextlib.suppress(BaseException):
                        await asyncio.gather(sender, receiver, return_exceptions=True)
            finally:
                with contextlib.suppress(Exception):
                    await ws.close()


__all__ = ["XfyunSTT", "XfyunRecognizeStream", "SttFrame", "parse_stt_frame"]
