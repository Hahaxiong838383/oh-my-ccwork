"""讯飞超拟人合成 → LiveKit TTS plugin(租户 provider,2026-07-27)。

协议(官方文档 + xiaozhi-esp32-server 生产实现交叉验证):
- wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6?<hmac-sha256 鉴权 query>
- 请求 payload.text.text 为 **base64(utf-8)**(文档示例含糊,生产实现实锤;发明文会 10009)
- 响应 payload.audio.audio 为 base64 PCM(encoding=raw 时);audio.status==2 = 最后一帧
- 会话约束:60s 会话上限/10s 无数据读超时 → 每句独立 ws 会话(ChunkedStream 单段
  正好一句一发,天然规避两个超时;首包建连税 ~150-250ms,慢了再学 volc 加连接池)。

模式照 volc_tts:streaming=False + ChunkedStream,StreamAdapter 逐句喂。
"""

from __future__ import annotations

import base64
import contextlib
import json
import logging
from typing import Never

import aiohttp
from livekit.agents import tts, utils
from livekit.agents.tts.tts import AudioEmitter
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, APIConnectOptions

from .volc_tts import has_speakable, strip_stage_directions
# build_tts_request/DEFAULT_VCN 在协议层 xfyun_common(与控制面探针同源),此处 re-export 兼容
from .xfyun_common import DEFAULT_VCN, build_tts_request, build_xfyun_auth_ws_url

logger = logging.getLogger("voice_agent.xfyun_tts")

XFYUN_TTS_SR = 24000  # 超拟人默认 24k(8k/16k/24k 可选),raw=PCM16


def parse_tts_frame(raw: str) -> tuple[str, bytes, bool]:
    """下行帧 → (kind, pcm, is_last)。kind: audio|error|ignore(纯函数,可单测)。"""
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return "ignore", b"", False
    header = obj.get("header") or {}
    code = header.get("code")
    if code not in (0, None):
        return "error", f"code={code} message={header.get('message', '')}".encode(), True
    audio = (obj.get("payload") or {}).get("audio") or {}
    b64 = audio.get("audio") or ""
    is_last = audio.get("status") == 2
    if not b64:
        return ("ignore", b"", is_last)
    try:
        return "audio", base64.b64decode(b64), is_last
    except (ValueError, TypeError):
        return "ignore", b"", is_last


class XfyunTTS(tts.TTS[Never]):
    """讯飞超拟人合成(凭据经 factory 从租户加密存储注入)。"""

    def __init__(
        self,
        *,
        app_id: str,
        api_key: str,
        api_secret: str,
        vcn: str = DEFAULT_VCN,
        speed: int = 50,
        sample_rate: int = XFYUN_TTS_SR,
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=sample_rate,
            num_channels=1,
        )
        self._app_id = app_id
        self._api_key = api_key
        self._api_secret = api_secret
        self._vcn = vcn
        self._speed = speed
        self._sr = sample_rate

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> XfyunChunkedStream:
        return XfyunChunkedStream(self, strip_stage_directions(text), conn_options=conn_options)


class XfyunChunkedStream(tts.ChunkedStream):
    """每句一个 ws 会话:单帧发完文本,流式收 PCM 推 emitter。"""

    def __init__(self, parent: XfyunTTS, text: str, *, conn_options: APIConnectOptions) -> None:
        super().__init__(tts=parent, input_text=text, conn_options=conn_options)
        self._xf = parent
        self._text = text

    async def _run(self, output_emitter: AudioEmitter) -> None:
        # 诊断遥测(2026-08-03"只说一句"排查):每段合成一行——数这行=数实际进
        # 讯飞的句子数,与 "llm stream done: chars" 对齐即可定层
        logger.info("xfyun tts synthesize: %d chars %.24r", len(self._text), self._text)
        output_emitter.initialize(
            request_id=utils.shortuuid(),
            sample_rate=self._xf._sr,
            num_channels=1,
            mime_type="audio/pcm",
        )
        if not has_speakable(self._text):
            # 纯标点/空白段:不打讯飞,推 10ms 静音满足基类"至少一帧"(同 volc 处理)
            output_emitter.push(b"\x00" * (self._xf._sr // 100 * 2))
            output_emitter.flush()
            return
        url = build_xfyun_auth_ws_url(self._xf._api_key, self._xf._api_secret)
        request = build_tts_request(
            self._text,
            app_id=self._xf._app_id,
            vcn=self._xf._vcn,
            sample_rate=self._xf._sr,
            speed=self._xf._speed,
        )
        async with aiohttp.ClientSession() as http:
            try:
                ws = await http.ws_connect(url, timeout=aiohttp.ClientWSTimeout(ws_close=10))
            except aiohttp.WSServerHandshakeError as e:
                logger.error("讯飞合成握手失败 HTTP %s(检查 api_key/api_secret)", e.status)
                raise
            try:
                await ws.send_str(json.dumps(request, ensure_ascii=False))
                while True:
                    msg = await ws.receive(timeout=15)
                    if msg.type in (
                        aiohttp.WSMsgType.CLOSED,
                        aiohttp.WSMsgType.CLOSE,
                        aiohttp.WSMsgType.CLOSING,
                        aiohttp.WSMsgType.ERROR,
                    ):
                        break
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    kind, payload, is_last = parse_tts_frame(msg.data)
                    if kind == "error":
                        # raise 交基类 retry(整段重合成无重复音频风险,同 volc 半途策略前提)
                        raise RuntimeError(f"讯飞合成错误: {payload.decode(errors='replace')}")
                    if kind == "audio" and payload:
                        output_emitter.push(payload)
                    if is_last:
                        break
            finally:
                with contextlib.suppress(Exception):
                    await ws.close()
        output_emitter.flush()


__all__ = [
    "XfyunTTS",
    "XfyunChunkedStream",
    "build_tts_request",
    "parse_tts_frame",
    "DEFAULT_VCN",
]
