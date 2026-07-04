"""CosyVoice2(torch, Apple Silicon) → LiveKit ``tts.TTS`` 适配器(Tier A 流式 TTS)。

替换 VoxCPM2(非流式整句,首音慢是硬伤)。CosyVoice2 是**真流式**:
``inference_zero_shot(..., stream=True)`` 边生成边 yield 音频 chunk(~1s/chunk @ token_hop_len=25,
24000 Hz),首 chunk 不等整句→首音快。

API 依据(2026-06-25 团队源码级调研,见 feedback_cosyvoice2_streaming_apple_silicon):
- ``cosyvoice.cli.cosyvoice.CosyVoice2(model_dir, load_jit=False, fp16=False)``
- ``inference_zero_shot(tts_text, prompt_text, prompt_speech_16k, stream=False, ...) -> generator``
  每次 yield ``dict``,唯一 key ``'tts_speech'`` 是 ``torch.Tensor [1,N]`` float32 [-1,1];
  ``cosyvoice.sample_rate == 24000``。
- 参考音频(小可音色)必须 16000 Hz,``load_wav(path, 16000)``。

设计要点:
- 用 ``ChunkedStream``(非 SynthesizeStream):CosyVoice2 需**整句**文本输入(非逐 token),
  配 livekit ``StreamAdapter`` 逐句喂 = 天然契合;句内流式靠"边 yield 边 push"实现。
- CosyVoice2 generate 是**阻塞 generator**,必须丢线程(否则卡死事件循环);用
  ``loop.call_soon_threadsafe`` 把线程产出的 chunk 桥到 asyncio.Queue,async 侧边收边 push
  → 句内真流式(首 chunk 出来立刻播,不等整句)。
- 顶层不 import cosyvoice/torch(保持包级零依赖可测),只在 ``load_cosyvoice_model`` /
  方法体内延迟 import。
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any, Never

import numpy as np
from livekit.agents import APIConnectOptions, tts, utils
from livekit.agents.tts import AudioEmitter
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

COSY_SR = 24000


def _split_sentences(text: str) -> list[str]:
    """按中英标点切句(保留标点),首句短 → 首音快。与 VoxCPM 适配器同策略。"""
    parts = re.split(r"(?<=[。！？!?；;，,、…\n])", text)
    return [p.strip() for p in parts if p.strip()]


def load_cosyvoice_model(
    model_dir: str,
    prompt_wav: str,
    prompt_text: str,
) -> dict[str, Any]:
    """加载 CosyVoice2 + 参考音频(小可音色) + prewarm。

    返回 dict: ``{"model", "prompt_speech", "prompt_text"}``。
    - ``model_dir``: CosyVoice2-0.5B 权重目录。
    - ``prompt_wav``: 小可音色参考音频路径(16k 单人干净语音 3-10s)。
    - ``prompt_text``: 该参考音频对应的准确文字。
    """
    import sys

    # CosyVoice 依赖 third_party/Matcha-TTS 在 sys.path(官方约定)。
    cosy_root = Path(model_dir).expanduser().parents[1]  # .../CosyVoice
    matcha = cosy_root / "third_party" / "Matcha-TTS"
    if matcha.is_dir() and str(matcha) not in sys.path:
        sys.path.insert(0, str(matcha))

    from cosyvoice.cli.cosyvoice import CosyVoice2  # type: ignore[import-not-found]
    from cosyvoice.utils.file_utils import load_wav  # type: ignore[import-not-found]

    model = CosyVoice2(
        str(Path(model_dir).expanduser()),
        load_jit=False,
        load_trt=False,
        fp16=False,
    )
    prompt_speech = load_wav(str(Path(prompt_wav).expanduser()), 16000)

    # prewarm:空跑一句触发 JIT/kernel 编译(首次 ~30s 冷启动,别让首轮对话吃)。
    try:
        for _ in model.inference_zero_shot(
            "你好", prompt_text, prompt_speech, stream=True
        ):
            break
    except Exception:
        pass

    return {"model": model, "prompt_speech": prompt_speech, "prompt_text": prompt_text}


class CosyVoiceTTS(tts.TTS[Never]):
    """本地 CosyVoice2 流式 TTS(包一个已加载的 CosyVoice2 + 小可参考音色)。"""

    def __init__(self, loaded: dict[str, Any]) -> None:
        super().__init__(
            # streaming=False:CosyVoice2 需整句输入,交给 livekit StreamAdapter 逐句切。
            # 句内流式在 _run 内"边 yield 边 push"实现,体验上是真流式。
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=COSY_SR,
            num_channels=1,
        )
        self._model = loaded["model"]
        self._prompt_speech = loaded["prompt_speech"]
        self._prompt_text = loaded["prompt_text"]

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> CosyVoiceChunked:
        return CosyVoiceChunked(
            self,
            self._model,
            self._prompt_speech,
            self._prompt_text,
            text,
            conn_options=conn_options,
        )


class CosyVoiceChunked(tts.ChunkedStream):
    """逐句合成,句内边生成边 push(线程→Queue 桥),实现句内真流式。"""

    def __init__(
        self,
        parent: CosyVoiceTTS,
        model: Any,
        prompt_speech: Any,
        prompt_text: str,
        text: str,
        *,
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(tts=parent, input_text=text, conn_options=conn_options)
        self._model = model
        self._prompt_speech = prompt_speech
        self._prompt_text = prompt_text
        self._text = text

    async def _run(self, output_emitter: AudioEmitter) -> None:
        output_emitter.initialize(
            request_id=utils.shortuuid(),
            sample_rate=COSY_SR,
            num_channels=1,
            mime_type="audio/pcm",
            stream=True,  # 流式:启用增量推送+分帧
        )
        sentences = _split_sentences(self._text) or [self._text]
        for sent in sentences:
            await self._synth_streaming(sent, output_emitter)
        output_emitter.flush()

    async def _synth_streaming(self, sent: str, emitter: AudioEmitter) -> None:
        """在线程跑 CosyVoice2 阻塞 generator,把每个 chunk 桥到 async 侧立刻 push。"""
        loop = asyncio.get_running_loop()
        q: asyncio.Queue[bytes | None] = asyncio.Queue()

        def _produce() -> None:
            try:
                for chunk in self._model.inference_zero_shot(
                    sent, self._prompt_text, self._prompt_speech, stream=True
                ):
                    audio = chunk["tts_speech"]
                    # torch.Tensor [1,N] → numpy float32 → int16 小端
                    arr = np.asarray(audio.cpu().numpy(), dtype=np.float32).reshape(-1)
                    pcm = (np.clip(arr, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                    loop.call_soon_threadsafe(q.put_nowait, pcm)
            finally:
                loop.call_soon_threadsafe(q.put_nowait, None)  # 结束哨兵

        fut = loop.run_in_executor(None, _produce)
        while True:
            pcm = await q.get()
            if pcm is None:
                break
            emitter.push(pcm)
        await fut  # 传播线程内异常


__all__ = ["CosyVoiceTTS", "CosyVoiceChunked", "load_cosyvoice_model"]
