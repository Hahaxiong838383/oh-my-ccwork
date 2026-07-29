"""假打断恢复丝滑化:resume 后音量渐起的 AudioOutput 链节点(POC,2026-07-29)。

问题:0 字门+假打断恢复下,环境音触发 pause(帧转发瞬停)→1s 后 resume(瞬间满音量)
——"声音突然冒回来"的断差感是主要违和(川哥真机反馈)。停止侧无法预渐弱(VAD 无预知),
恢复侧渐起可完全消除:resume 时增益从 0 线性爬回 1(默认 250ms),帧层乘系数纯整形,
零内容丢失。挂载:session.output.audio = FadeInAudioOutput(原 sink)(io.py setter,
基类传 next_in_chain 自动接 playback 事件链)。POC_RESUME_FADE_MS=0 时不挂载。
"""

from __future__ import annotations

import numpy as np
from livekit import rtc
from livekit.agents.voice.io import AudioOutput, AudioOutputCapabilities


def fade_gains(start_gain: float, n_samples: int, step: float) -> "np.ndarray":
    """帧内逐样本增益斜坡(纯函数,可单测):从 start_gain 起每样本 +step,封顶 1.0。"""
    return np.clip(
        start_gain + np.arange(n_samples, dtype=np.float32) * step, 0.0, 1.0
    )


class FadeInAudioOutput(AudioOutput):
    """透传链节点:仅 resume 后的爬坡期改写帧幅度,其余零开销直通。"""

    def __init__(self, next_in_chain: AudioOutput, *, fade_ms: int = 250) -> None:
        super().__init__(
            label="FadeIn",
            capabilities=AudioOutputCapabilities(pause=True),
            next_in_chain=next_in_chain,
        )
        self._fade_ms = max(1, fade_ms)
        self._gain = 1.0  # 1.0=直通;resume 置 0 后按样本爬回

    @property
    def sample_rate(self) -> int | None:
        assert self.next_in_chain is not None
        return self.next_in_chain.sample_rate

    @property
    def can_pause(self) -> bool:
        assert self.next_in_chain is not None
        return self.next_in_chain.can_pause

    def _apply_fade(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
        data = np.frombuffer(frame.data, dtype=np.int16).astype(np.float32)
        if not len(data):
            return frame
        # 步进按"每秒样本数×渐变时长"折算;多声道交织样本一并爬(听感一致)
        per_second = frame.sample_rate * frame.num_channels
        step = 1.0 / (per_second * self._fade_ms / 1000.0)
        gains = fade_gains(self._gain, len(data), step)
        self._gain = float(gains[-1])
        out = (data * gains).astype(np.int16)
        return rtc.AudioFrame(
            data=out.tobytes(),
            sample_rate=frame.sample_rate,
            num_channels=frame.num_channels,
            samples_per_channel=frame.samples_per_channel,
        )

    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        await super().capture_frame(frame)
        if self._gain < 1.0:
            frame = self._apply_fade(frame)
        assert self.next_in_chain is not None
        await self.next_in_chain.capture_frame(frame)

    def flush(self) -> None:
        super().flush()
        assert self.next_in_chain is not None
        self.next_in_chain.flush()

    def clear_buffer(self) -> None:
        assert self.next_in_chain is not None
        self.next_in_chain.clear_buffer()

    def resume(self) -> None:
        # 假打断恢复入口:从静音爬回,消"声音突然冒回来"
        self._gain = 0.0
        super().resume()


__all__ = ["FadeInAudioOutput", "fade_gains"]
