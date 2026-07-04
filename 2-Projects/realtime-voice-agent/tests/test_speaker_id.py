"""声纹旁路纯逻辑单测(Phase 1):ring buffer / 转换 / 注册库 / 比对决策 / sidecar 守卫。

不依赖 sherpa-onnx(extractor 用 fake):真模型 smoke 见 scripts 手动跑,
API 形态已按官方示例逐行验证(docs/VOICEPRINT-PLAN.md §2)。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from voice_agent.engines.speaker_id import (
    AudioRingBuffer,
    SpeakerIdentifier,
    SpeakerIdSidecar,
    SpeakerProfile,
    l2_normalize,
    load_registry,
    pcm16_to_float32,
    save_registry,
)

_BPS = 16000 * 2  # PCM16 mono bytes/秒


def _chunk(amp: int, ms: int = 20) -> bytes:
    """恒定幅度的 PCM16 帧(amp=0 静音,3000 说话)。"""
    n = 16000 * ms // 1000
    return np.full(n, amp, dtype=np.int16).tobytes()


class TestAudioRingBuffer:
    def test_silence_filtered_speech_kept(self) -> None:
        ring = AudioRingBuffer(min_amp=250.0)
        ring.append(_chunk(0))  # 静音:丢
        ring.append(_chunk(100))  # 底噪:丢
        ring.append(_chunk(3000))  # 说话:留
        assert ring.duration_s == 0.02
        assert len(ring.snapshot_and_clear()) == len(_chunk(3000))

    def test_snapshot_clears(self) -> None:
        ring = AudioRingBuffer()
        ring.append(_chunk(3000))
        assert ring.snapshot_and_clear() != b""
        assert ring.snapshot_and_clear() == b""
        assert ring.duration_s == 0.0

    def test_cap_evicts_oldest(self) -> None:
        ring = AudioRingBuffer(max_seconds=0.05)  # 容量 50ms
        first = np.full(320, 1000, dtype=np.int16).tobytes()  # 20ms,可辨识首帧
        ring.append(first)
        for _ in range(4):
            ring.append(_chunk(3000))  # 再 80ms → 超容量,最旧被逐
        out = ring.snapshot_and_clear()
        assert len(out) <= int(0.05 * _BPS) + len(first)
        assert not out.startswith(first[:8]) or first not in out  # 首帧已被逐出

    def test_empty_chunk_ignored(self) -> None:
        ring = AudioRingBuffer()
        ring.append(b"")
        assert ring.duration_s == 0.0


class TestConversions:
    def test_pcm16_to_float32_range(self) -> None:
        pcm = np.array([0, 16384, -32768, 32767], dtype=np.int16).tobytes()
        f = pcm16_to_float32(pcm)
        assert f.dtype == np.float32
        assert abs(f[0]) < 1e-9 and abs(f[1] - 0.5) < 1e-4
        assert -1.0 <= f.min() and f.max() <= 1.0

    def test_l2_normalize(self) -> None:
        v = l2_normalize(np.array([3.0, 4.0], dtype=np.float32))
        assert abs(float(np.linalg.norm(v)) - 1.0) < 1e-6
        zero = l2_normalize(np.zeros(4, dtype=np.float32))
        assert float(np.linalg.norm(zero)) == 0.0  # 零向量不除零


class TestRegistry:
    def test_roundtrip_and_dim_check(self, tmp_path: Path) -> None:
        reg = tmp_path / "registry.json"
        p1 = SpeakerProfile(
            "川哥", "chuan", l2_normalize(np.array([1.0, 0, 0], dtype=np.float32)), 2
        )
        p2 = SpeakerProfile("客人", "guest", l2_normalize(np.array([0, 1.0, 0], dtype=np.float32)))
        save_registry(reg, [p1, p2], model_label="campplus-test")
        loaded = load_registry(reg, expected_dim=3)
        assert [p.name for p in loaded] == ["川哥", "客人"]
        assert loaded[0].samples == 2
        assert abs(float(np.dot(loaded[0].embedding, p1.embedding)) - 1.0) < 1e-4
        # 换模型后维度不符 → 条目全部跳过(旧向量不可比)
        assert load_registry(reg, expected_dim=192) == []


class _FakeStream:
    def accept_waveform(self, sample_rate: int, waveform: np.ndarray) -> None:
        self.waveform = waveform

    def input_finished(self) -> None:
        pass


class _FakeExtractor:
    """固定输出向量的假 extractor(API 形态与 sherpa 一致)。"""

    dim = 3

    def __init__(self, vec: list[float]) -> None:
        self._vec = vec
        self.last_len = 0

    def create_stream(self) -> _FakeStream:
        self._stream = _FakeStream()
        return self._stream

    def compute(self, stream: _FakeStream) -> list[float]:
        self.last_len = int(stream.waveform.shape[0])
        return self._vec


def _profiles() -> list[SpeakerProfile]:
    return [
        SpeakerProfile("川哥", "chuan", l2_normalize(np.array([1.0, 0, 0], dtype=np.float32))),
        SpeakerProfile("客人", "guest", l2_normalize(np.array([0, 1.0, 0], dtype=np.float32))),
    ]


class TestIdentifier:
    def test_hit_above_threshold(self) -> None:
        ident = SpeakerIdentifier(_FakeExtractor([0.9, 0.1, 0.0]), _profiles(), threshold=0.6)
        r = ident.identify_sync(_chunk(3000, ms=2000))
        assert r.name == "川哥" and r.best_name == "川哥"
        assert r.best_score > 0.9 and set(r.scores) == {"川哥", "客人"}

    def test_miss_below_threshold(self) -> None:
        ident = SpeakerIdentifier(_FakeExtractor([0.0, 0.0, 1.0]), _profiles(), threshold=0.6)
        r = ident.identify_sync(_chunk(3000, ms=2000))
        assert r.name is None and r.best_score < 0.6

    def test_infer_capped_to_recent_12s(self) -> None:
        ext = _FakeExtractor([1.0, 0, 0])
        ident = SpeakerIdentifier(ext, _profiles(), threshold=0.6)
        r = ident.identify_sync(b"\x00\x00" * (16000 * 15))  # 15s 音频
        assert ext.last_len == 12 * 16000  # 只喂最近 12s
        assert abs(r.speech_s - 15.0) < 1e-6


class _FakeIdentifier:
    threshold = 0.6

    def __init__(self, fail: bool = False) -> None:
        self.calls = 0
        self._fail = fail

    def identify_sync(self, pcm: bytes) -> object:
        self.calls += 1
        if self._fail:
            raise RuntimeError("boom")
        from voice_agent.engines.speaker_id import IdentifyResult

        return IdentifyResult(name="川哥", best_name="川哥", best_score=0.8, speech_s=2.0)


class TestSidecar:
    async def test_short_speech_skipped(self) -> None:
        ring = AudioRingBuffer()
        ring.append(_chunk(3000))  # 仅 20ms
        fake = _FakeIdentifier()
        sc = SpeakerIdSidecar(ring, fake, min_speech_s=1.0)  # type: ignore[arg-type]
        await sc.on_turn()
        assert fake.calls == 0 and sc.last_result is None
        assert ring.duration_s == 0.0  # 短样本也要清,不跨 turn 累积

    async def test_normal_turn_identifies(self) -> None:
        ring = AudioRingBuffer()
        for _ in range(100):  # 2s 语音
            ring.append(_chunk(3000))
        fake = _FakeIdentifier()
        sc = SpeakerIdSidecar(ring, fake, min_speech_s=1.0)  # type: ignore[arg-type]
        await sc.on_turn()
        assert fake.calls == 1
        assert sc.last_result is not None and sc.last_result.name == "川哥"

    async def test_exception_swallowed(self) -> None:
        ring = AudioRingBuffer()
        for _ in range(100):
            ring.append(_chunk(3000))
        sc = SpeakerIdSidecar(ring, _FakeIdentifier(fail=True), min_speech_s=1.0)  # type: ignore[arg-type]
        await sc.on_turn()  # 旁路铁律:绝不 raise
        assert sc.last_result is None

    async def test_sticky_identity_and_context_note(self) -> None:
        ring = AudioRingBuffer()
        fake = _FakeIdentifier()
        sc = SpeakerIdSidecar(ring, fake, min_speech_s=1.0)  # type: ignore[arg-type]
        assert sc.context_note() is None  # 未识别前不注入
        for _ in range(100):
            ring.append(_chunk(3000))
        await sc.on_turn()  # fake 命中"川哥"
        note = sc.context_note()
        assert note is not None and "川哥" in note and "0.80" in note
        # UNKNOWN(短句 skip)不清粘滞
        ring.append(_chunk(3000))
        await sc.on_turn()
        assert sc.context_note() is not None
