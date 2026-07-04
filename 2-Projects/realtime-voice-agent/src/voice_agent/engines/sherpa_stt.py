"""Sherpa-onnx 流式 STT → LiveKit ``stt.STT`` 适配器(Tier A 本地 STT)。

paraformer 中英混说 int8,RTF~0.05(Studio M2 Max,纯 CPU),数据不出端、零 API 成本。
本模块顶层 import livekit/sherpa——**只在 ``tier_a_cascade.start_livekit_job`` 方法体内
延迟 import**,保持包级零依赖可测(同 ``livekit_bridge`` 的纪律,不进 ``__init__``)。

API 依据(2026-06-24 实测,见 feedback_sherpa_onnx_streaming_stt_server):
- ``OnlineRecognizer.from_paraformer(...,enable_endpoint_detection=True)``
- ``create_stream``→``accept_waveform``→``decode_stream``→``get_result``→``is_endpoint``(实测)
livekit-agents 1.6.3:自定义流式 STT = 重写 ``stream()`` 返回 ``RecognizeStream`` 子类;
``_run`` 内从 ``self._input_ch`` 消费(``rtc.AudioFrame`` | ``_FlushSentinel``),
向 ``self._event_ch`` 发 ``SpeechEvent``(INTERIM/FINAL)。
🔑 **FINAL 必须靠 sherpa endpoint 主动发**:livekit cascade 不主动 flush STT(deepgram 那类
靠服务端 is_final),paraformer 流式需自判静音 endpoint 发 FINAL,否则 user turn 永不提交
(M1 真根因,2026-06-24)。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Never

import numpy as np
from livekit.agents import NOT_GIVEN, APIConnectOptions, NotGivenOr, stt
from livekit.agents.language import LanguageCode
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

SHERPA_SR = 16000  # paraformer 输入采样率;基类设 sample_rate 后自动重采样到此值
# PREFLIGHT 投机:增量前缀达最短字数首次 → 发 PREFLIGHT_TRANSCRIPT 触发 LLM(说话中途起,不等
# 静音 endpoint 发 FINAL),把判停+LLM 重叠(team 调研 livekit 原生 PREFLIGHT 通道,stt.py:39)。
# ⚠️实测:sherpa endpoint 切碎中文口语,"连续不变"窗口不存在,故用长度门;中文前缀回退由框架
# 认领校验(PREFLIGHT 与 FINAL transcript 不一致则丢弃重生,agent_activity.py:2248)兜底。
PREFLIGHT_MIN_CHARS = 5


def build_sherpa_recognizer(model_dir: str, *, num_threads: int = 2) -> Any:
    """从模型目录建 sherpa ``OnlineRecognizer``(int8 文件优先,缺则回退 fp32)。"""
    import sherpa_onnx

    base = Path(model_dir).expanduser()

    def pick(stem: str) -> str:
        int8 = base / f"{stem}.int8.onnx"
        return str(int8 if int8.exists() else base / f"{stem}.onnx")

    return sherpa_onnx.OnlineRecognizer.from_paraformer(
        tokens=str(base / "tokens.txt"),
        encoder=pick("encoder"),
        decoder=pick("decoder"),
        num_threads=num_threads,
        enable_endpoint_detection=True,  # 静音 endpoint → 主动发 FINAL(livekit turn 提交需要)
        # 判停头号瓶颈:默认 trailing silence 太长(rule1 2.4 / rule2 1.2)→STT final 慢~2s,
        # 判停时钟卡在等 STT final(实测 transcription_delay 1987ms)。调短让 final 快出
        # (语义 turn detector v1-mini + endpointing delay 兜底防句中停顿切碎)。
        rule1_min_trailing_silence=0.8,
        rule2_min_trailing_silence=0.4,
    )


class SherpaSTT(stt.STT[Never]):
    """本地 sherpa 流式 STT(包一个已建好的 ``OnlineRecognizer``)。"""

    def __init__(self, recognizer: Any) -> None:
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=True, interim_results=True)
        )
        self._recognizer = recognizer

    async def _recognize_impl(
        self,
        buffer: Any,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> stt.SpeechEvent:
        # cascade 只走流式;整段识别留空。
        raise NotImplementedError("SherpaSTT 仅支持流式 stream()")

    def stream(
        self,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> SherpaStream:
        return SherpaStream(self, self._recognizer, conn_options=conn_options)


class SherpaStream(stt.RecognizeStream):
    """单条流式识别:逐帧喂 sherpa,文本增量发 INTERIM,静音 endpoint 发 FINAL。"""

    def __init__(
        self, parent: SherpaSTT, recognizer: Any, *, conn_options: APIConnectOptions
    ) -> None:
        # 设 sample_rate → 基类 push_frame 自动把进来的帧重采样到 16k。
        super().__init__(stt=parent, conn_options=conn_options, sample_rate=SHERPA_SR)
        self._recognizer = recognizer

    def _emit(self, event_type: Any, text: str) -> None:
        self._event_ch.send_nowait(
            stt.SpeechEvent(
                type=event_type,
                alternatives=[stt.SpeechData(language=LanguageCode("zh"), text=text)],
            )
        )

    async def _run(self) -> None:
        rec = self._recognizer
        s = rec.create_stream()
        last = ""
        preflight_sent = False
        async for data in self._input_ch:
            if isinstance(data, self._FlushSentinel):
                final = self._drain(rec, s, final=True)
                if final:
                    self._emit(stt.SpeechEventType.FINAL_TRANSCRIPT, final)
                s = rec.create_stream()  # 重置,迎接下一个 turn
                last = ""
                preflight_sent = False
                continue

            samples = np.frombuffer(data.data, dtype=np.int16).astype(np.float32) / 32768.0
            s.accept_waveform(SHERPA_SR, samples)  # accept_waveform 是 stream(s) 的方法,非 rec
            text = self._drain(rec, s)
            if rec.is_endpoint(s):  # 静音 endpoint:发 FINAL 触发 turn 提交,重置迎下一句
                if text:
                    self._emit(stt.SpeechEventType.FINAL_TRANSCRIPT, text)
                rec.reset(s)
                last = ""
                preflight_sent = False
                continue
            if text and text != last:
                last = text
                self._emit(stt.SpeechEventType.INTERIM_TRANSCRIPT, text)
                # 增量前缀达最短字数首次 → PREFLIGHT 触发 LLM 投机(说话中途起,藏进判停窗口);
                # 每段一次,中文回退由框架认领校验兜底(详见上方常量注释)。
                if not preflight_sent and len(text) >= PREFLIGHT_MIN_CHARS:
                    self._emit(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, text)
                    preflight_sent = True

    @staticmethod
    def _drain(rec: Any, s: Any, *, final: bool = False) -> str:
        if final:
            s.input_finished()
        while rec.is_ready(s):
            rec.decode_stream(s)
        return str(rec.get_result(s) or "")


__all__ = ["SherpaSTT", "SherpaStream", "build_sherpa_recognizer"]
