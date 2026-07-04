"""VoxCPM2(MLX 8bit) → LiveKit ``tts.TTS`` 适配器(Tier A 本地 TTS)。

48kHz,``inference_timesteps=5``(川哥耳判锁定 mid_s3/s5/s10),RTF~0.38(Studio M2 Max GPU)。
本模块顶层 import livekit/mlx_audio——**只在 ``tier_a_cascade.start_livekit_job`` 方法体内
延迟 import**,保持包级零依赖可测(不进 ``__init__``)。

API 依据(2026-06-24 实测,见 feedback_voxcpm2_mlx_apple_silicon_tts):
- ``mlx_audio.tts.load_model(model_dir) -> nn.Module``
- ``model.generate(text, inference_timesteps=5) -> generator``,每个 ``chunk.audio`` 是
  ``mlx.core.array``(float32 [-1,1]),``chunk.sample_rate == 48000``。
livekit-agents 1.6.3:非流式 TTS = 重写 ``synthesize()`` 返回 ``ChunkedStream`` 子类;
``_run(output_emitter)`` 内 ``initialize`` → ``push(int16 小端 bytes)`` → ``flush``。
整句推理阻塞,必须丢 ``asyncio.to_thread`` 否则卡死事件循环(worker 假死)。
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any, Never

import numpy as np
from livekit.agents import APIConnectOptions, tts, utils
from livekit.agents.tts import AudioEmitter
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

VOX_SR = 48000
VOX_STEPS = 3  # 加速实验:5→3 推理步数降(RTF 0.38→~0.23),川哥耳判 s3 中文质量是否够实时;不够回 4/5
# 锁音色:VoxCPM zero-shot 不给参考音频则每次随机采样音色(川哥听到"随机乱放")。
# 实测固定 mx.random.seed(同值)→音频逐样本一致→音色确定。每次 generate 前 seed 同值=全程同一音色。
# 不喜欢这个音色就换数字(每个 seed = 一个不同但稳定的音色),无需参考 clip。
VOX_SEED = int(os.environ.get("VOX_SEED", "42"))


def _split_sentences(text: str) -> list[str]:
    """按句末标点切句(保留标点),首句先出 → 首音快;只切句末不切逗号 → 片段少更连续。"""
    # ⚠️ 只切句末(。！？；…),不切逗号/顿号:逗号切会把一句话拆成多段,
    # 每段独立 generate→段间有边界停顿+音色起音重置=川哥听到的"断断续续"。
    # 锁 seed 后音色不跳了,再减少切分边界 → 连续性进一步改善(代价:首段略长)。
    parts = re.split(r"(?<=[。！？!?；;…\n])", text)
    return [p.strip() for p in parts if p.strip()]


def load_voxcpm_model(model_dir: str) -> Any:
    """加载 VoxCPM2 MLX 模型 + prewarm(返回 mlx ``nn.Module``)。"""
    from mlx_audio.tts import load_model

    model = load_model(Path(model_dir).expanduser())
    # prewarm:worker 启动时空跑一句,让 mlx 编译 Metal kernel + 模型预热,
    # 首句不吃冷启动(否则第一轮对话 TTS 首音明显慢)。
    try:
        for _ in model.generate("你好", inference_timesteps=VOX_STEPS):
            break  # 只需首 chunk 触发 kernel 编译/warm
    except Exception:
        pass
    return model


class VoxCPMTTS(tts.TTS[Never]):
    """本地 VoxCPM2 TTS(包一个已加载的 mlx 模型)。"""

    def __init__(
        self, model: Any, *, steps: int = VOX_STEPS, seed: int = VOX_SEED
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=VOX_SR,
            num_channels=1,
        )
        self._model = model
        self._steps = steps
        self._seed = seed

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> VoxCPMChunked:
        return VoxCPMChunked(
            self, self._model, text, self._steps, self._seed, conn_options=conn_options
        )


class VoxCPMChunked(tts.ChunkedStream):
    """整句合成:在线程池跑 VoxCPM generate,把各 chunk 转 int16 push 给 emitter。"""

    def __init__(
        self,
        parent: VoxCPMTTS,
        model: Any,
        text: str,
        steps: int,
        seed: int,
        *,
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(tts=parent, input_text=text, conn_options=conn_options)
        self._model = model
        self._text = text  # 不依赖基类内部属性名,自存一份
        self._steps = steps
        self._seed = seed

    async def _run(self, output_emitter: AudioEmitter) -> None:
        output_emitter.initialize(
            request_id=utils.shortuuid(),
            sample_rate=VOX_SR,
            num_channels=1,
            mime_type="audio/pcm",
        )
        # 按句切分,逐句合成:首句(短)先 push → TTFB 低 + 边播边合成(RTF<1)→流式感
        # (整句合成长段要等 3-5s 出首音,无流式体验;切句后首音 ~0.7s)
        sentences = _split_sentences(self._text) or [self._text]
        for sent in sentences:
            chunks = await asyncio.to_thread(self._synth_one, sent)
            for pcm in chunks:
                output_emitter.push(pcm)
        output_emitter.flush()

    def _synth_one(self, sent: str) -> list[bytes]:
        import mlx.core as mx  # type: ignore[import-not-found]

        # 锁音色:每句 generate 前 seed 同值 → speaker latent 确定 → 全程同一音色
        # (不 seed 则 zero-shot 每句随机采样不同音色 = 川哥听到的"随机乱放")。
        mx.random.seed(self._seed)
        out: list[bytes] = []
        for chunk in self._model.generate(sent, inference_timesteps=self._steps):
            audio = np.asarray(chunk.audio, dtype=np.float32)
            pcm16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
            out.append(pcm16)
        return out


__all__ = ["VoxCPMTTS", "VoxCPMChunked", "load_voxcpm_model"]
