"""火山豆包双向流式 TTS → LiveKit TTS plugin(云 API 瘦客户端,固定音色+真流式)。

替 VoxCPM(非流式整句 + zero-shot 音色随机)。火山 ``tts_stream(text)`` 边合成边 yield
PCM chunk(24kHz),``speaker`` 固定音色 → 一次性解决音色随机 + 非流式两个症状。

协议(research Agent 两生产实现交叉验证):
- wss://openspeech.bytedance.com/api/v3/tts/bidirection(双向流式)
- 鉴权同 ASR(X-Api-App-Key/Access-Key),Resource-Id=seed-tts-2.0 或 volc.service_type.10029
封装 ``doubao_speech._ws_client.tts_stream``(MIT,事件协议已实现):
``tts_stream(text, speaker, audio_format="pcm", sample_rate=24000, ...) -> AsyncIterator[bytes]``。

streaming=False + ChunkedStream:火山 tts_stream 吃整段文本,配 LiveKit StreamAdapter 逐句喂
= 句内真流式(边到边 push)+ 首句快出。凭据走 env 注入。
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import unicodedata
from typing import Never

from livekit.agents import APIConnectOptions, tts, utils
from livekit.agents.tts import AudioEmitter
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

logger = logging.getLogger("voice_agent.volc_tts")

VOLC_TTS_SR = 24000

# 舞台指示:全/半角圆括号、方括号、成对星号包裹的短内容(≤12 字,超长视为真实内容保留)
_STAGE_RE = re.compile(r"[（(【\[][^（()）【】\[\]\n]{1,12}[)）】\]]|\*[^*\n]{1,12}\*")


def has_speakable(text: str) -> bool:
    """是否含可发声内容(任意字母/数字/汉字)。纯标点段(如切句器切出的孤立右引号 `”`)
    火山不产音频 → ChunkedStream 基类 'no audio frames were pushed' APIError → 重试全败
    把 TTS 流水线打进异常态(2026-07-02 川哥实测:局部无声 + job 半死)。发声前先判。"""
    return any(ch.isalnum() for ch in text)


def strip_stage_directions(text: str) -> str:
    """TTS 前兜底过滤(2026-07-02 川哥反馈:AI 把"(笑)"念出来)。

    删两类不该发声的内容:①括号/星号舞台指示——(笑)【叹气】*笑* 等(prompt 已禁,
    这里兜 LLM 不听话)②emoji(Unicode So 类)。全滤成空则回退原文,防空 TTS 请求。
    只影响送 TTS 的文本,字幕/契约转写不经此函数。
    """
    out = _STAGE_RE.sub("", text)
    out = "".join(ch for ch in out if unicodedata.category(ch) != "So")
    return out if out.strip() else text


class VolcTTS(tts.TTS[Never]):
    """火山豆包流式 TTS(凭据 + 音色 env 注入)。"""

    def __init__(
        self,
        *,
        app_id: str,
        access_token: str,
        speaker: str = "zh_female_vv_uranus_bigtts",
        resource_id: str = "seed-tts-2.0",
        speed_ratio: float = 1.0,
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=VOLC_TTS_SR,
            num_channels=1,
        )
        self._app_id = app_id
        self._access_token = access_token
        self._speaker = speaker
        self._resource_id = resource_id
        # 语速倍率(1.0 正常,>1 加快);火山内部转 speech_rate 整数百分比 [-50,100]
        self._speed = speed_ratio

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> VolcChunkedStream:
        # 每句入口兜底:滤舞台指示/emoji(StreamAdapter 切句后逐句到这;say() 提供
        # audio 时不合成,承接音资产不受影响)。
        # ⚠️ 句首承接词剥除已挪到 fast_llm.LeadingFillerStripper(2026-07-04):在这里
        # 句级剥只改音频不改字幕,川哥对照字幕听出"第一个字没念"——LLM 输出层剥
        # 才能让 TTS/字幕/对话历史三者一致。此处不再做。
        cleaned = strip_stage_directions(text)
        # 证据日志(与 stt final 对仗):实际送火山合成的逐句文本,"念没念某个字"
        # 直接对照此行与字幕定层位(此行有=合成/播放层问题,无=上游文本问题)。
        logger.info("tts synth: %s", cleaned)
        return VolcChunkedStream(self, cleaned, conn_options=conn_options)


class VolcChunkedStream(tts.ChunkedStream):
    """逐句调火山 tts_stream,边到边 push PCM chunk(句内真流式)。"""

    def __init__(
        self, parent: VolcTTS, text: str, *, conn_options: APIConnectOptions
    ) -> None:
        super().__init__(tts=parent, input_text=text, conn_options=conn_options)
        self._volc = parent
        self._text = text

    async def _run(self, output_emitter: AudioEmitter) -> None:
        from doubao_speech._ws_client import tts_stream  # type: ignore[import-not-found]

        # stream=False(默认):ChunkedStream 单段,直接 push 多 chunk + flush 即流式
        # (像 VoxCPM;stream=True 需先 start_segment(),不适配 ChunkedStream)
        output_emitter.initialize(
            request_id=utils.shortuuid(),
            sample_rate=VOLC_TTS_SR,
            num_channels=1,
            mime_type="audio/pcm",
        )
        if not has_speakable(self._text):
            # 纯标点/空白段:不打火山(必 0 帧报错),推 10ms 静音满足基类"至少一帧"
            output_emitter.push(b"\x00" * (VOLC_TTS_SR // 100 * 2))
            output_emitter.flush()
            return
        # R3b 连接池路径(2026-07-03):复用已握手 WS,省每句 ~150-250ms 建连税。
        # 仅"未产出任何音频"的失败才降级到一次性连接重试(半途失败降级会重复音频,
        # 那种情况直接 raise 交 livekit 基类整段 retry,同旧行为)。TTS_POOL_ENABLED=0 关。
        if os.environ.get("TTS_POOL_ENABLED", "1") == "1":
            pushed = False
            try:
                from ._volc_tts_pool import get_pool

                pool = get_pool(
                    self._volc._app_id, self._volc._access_token, self._volc._resource_id
                )
                conn = await pool.acquire()
                try:
                    async for chunk in conn.synthesize(
                        self._text,
                        speaker=self._volc._speaker,
                        audio_format="pcm",
                        sample_rate=VOLC_TTS_SR,
                        speed_ratio=self._volc._speed,
                    ):
                        if chunk:
                            pushed = True
                            output_emitter.push(bytes(chunk))
                finally:
                    pool.release(conn)
                output_emitter.flush()
                return
            except BaseException:
                if pushed:
                    raise  # 半途失败:已出音频,不可降级重跑(重复),交基类 retry
                logger.warning("tts pool 路径失败,本句降级一次性连接", exc_info=True)
        agen = tts_stream(
            self._text,
            speaker=self._volc._speaker,
            audio_format="pcm",
            sample_rate=VOLC_TTS_SR,
            speed_ratio=self._volc._speed,
            app_id=self._volc._app_id,
            access_token=self._volc._access_token,
            resource_id=self._volc._resource_id,
        )
        try:
            async for chunk in agen:
                if chunk:
                    output_emitter.push(bytes(chunk))
        finally:
            # barge-in/session 结束时显式关 WS,不泄漏(grok review)
            with contextlib.suppress(Exception):
                await agen.aclose()
        output_emitter.flush()


__all__ = [
    "VolcTTS",
    "VolcChunkedStream",
    "strip_stage_directions",
    "has_speakable",
]
