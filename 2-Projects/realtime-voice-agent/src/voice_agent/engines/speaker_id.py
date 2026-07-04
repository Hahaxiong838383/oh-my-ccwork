"""声纹识别旁路(Phase 1,2026-07-03,方案见 docs/VOICEPRINT-PLAN.md)。

worker 进程内的"第二个 silero":sherpa-onnx CAM++ 中文声纹 ONNX 提 embedding,
与注册库(assets/speakers/registry.json)做余弦比对,识别"当前说话的是谁"。

设计铁律(Phase 1):
- **纯旁路**:pump 侧 ring buffer 顺手留存本轮用户音频(带幅度过滤,天然去静音),
  turn 提交后 ``asyncio.to_thread`` 异步比对,只打日志/出元数据——不门控、不阻塞、
  任何异常不外抛,与回复主链路零交集。
- **自算余弦,不用 SpeakerEmbeddingManager**:manager.search 只回名字不回分数,
  而 Phase 1 的核心产出是 score 分布(标定阈值);注册库就几个人,numpy 点积零成本。
- 声纹 Score 是概率不是强认证,识别结果永远只作元数据(声纹ID 不当记忆主键——
  记忆 feedback_voice_agent_memory_design_traps 六陷阱)。
- 隐私:embedding 与注册音频均不出服务器、不进 git(assets/speakers 已 ignore)。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger("voice_agent.speaker_id")

SPEAKER_SR = 16000  # CAM++ zh-cn 16k 模型;与 room_input audio_sample_rate 一致
_BYTES_PER_SECOND = SPEAKER_SR * 2  # PCM16 mono
# 单次推理最多喂最近 N 秒(限 2 核机推理耗时;声纹 5-10s 已足够)
_MAX_INFER_SECONDS = 12.0


def _mean_abs_amp(chunk: bytes) -> float:
    """PCM16 帧平均绝对幅度(与 volc_stt S1v3 同口径:说话 ~1000+,底噪 <~200)。"""
    if len(chunk) < 2:
        return 0.0
    arr = np.frombuffer(chunk[: len(chunk) // 2 * 2], dtype=np.int16)
    return float(np.abs(arr.astype(np.int32)).mean())


def pcm16_to_float32(pcm: bytes) -> np.ndarray:
    """PCM16 bytes → float32 [-1,1](sherpa accept_waveform 的输入格式)。"""
    arr = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype=np.int16)
    return (arr.astype(np.float32) / 32768.0).copy()


def l2_normalize(vec: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vec))
    if norm == 0.0:
        return vec.astype(np.float32)
    return (vec / norm).astype(np.float32)


class AudioRingBuffer:
    """本轮用户音频留存(pump 侧逐帧写入)。

    - 写入即幅度过滤:amp < min_amp 的帧(静音/底噪)直接丢——buffer 里只有有效语音,
      agent 说话期间用户侧的长静音不稀释 embedding。
    - 容量上限 max_seconds,超出丢最旧(识别只需要最近的语音)。
    - 消费即清(snapshot_and_clear):每 turn 的音频独立,不跨 turn 混说话人。
    - 单 event loop 内读写(pump 与 on_user_turn_completed 同 loop),无锁。
    """

    def __init__(self, max_seconds: float = 15.0, min_amp: float = 250.0) -> None:
        self._chunks: deque[bytes] = deque()
        self._total_bytes = 0
        self._max_bytes = int(max_seconds * _BYTES_PER_SECOND)
        self._min_amp = min_amp

    def append(self, chunk: bytes) -> None:
        if not chunk or _mean_abs_amp(chunk) < self._min_amp:
            return
        self._chunks.append(chunk)
        self._total_bytes += len(chunk)
        while self._total_bytes > self._max_bytes and self._chunks:
            self._total_bytes -= len(self._chunks.popleft())

    @property
    def duration_s(self) -> float:
        return self._total_bytes / _BYTES_PER_SECOND

    def snapshot_and_clear(self) -> bytes:
        out = b"".join(self._chunks)
        self._chunks.clear()
        self._total_bytes = 0
        return out


@dataclass(frozen=True)
class SpeakerProfile:
    """注册库中的一个说话人(embedding 已 L2 归一)。"""

    name: str
    slug: str
    embedding: np.ndarray
    samples: int = 1


@dataclass(frozen=True)
class IdentifyResult:
    """一次比对结果。``name`` 仅在 best_score ≥ threshold 时非 None(命中)。"""

    name: str | None
    best_name: str
    best_score: float
    scores: dict[str, float] = field(default_factory=dict)
    speech_s: float = 0.0
    infer_ms: float = 0.0


def load_registry(path: Path, *, expected_dim: int | None = None) -> list[SpeakerProfile]:
    """读注册库 JSON;维度不匹配的条目跳过(换模型后旧向量不可比)。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    profiles: list[SpeakerProfile] = []
    for item in data.get("speakers", []):
        emb = np.asarray(item["embedding"], dtype=np.float32)
        if expected_dim is not None and emb.shape != (expected_dim,):
            logger.error(
                "speaker id: 注册条目 %r 维度 %s ≠ 模型 dim %s(换过模型?),跳过——请重新注册",
                item.get("name"),
                emb.shape,
                expected_dim,
            )
            continue
        profiles.append(
            SpeakerProfile(
                name=str(item["name"]),
                slug=str(item.get("slug") or item["name"]),
                embedding=l2_normalize(emb),
                samples=int(item.get("samples", 1)),
            )
        )
    return profiles


def save_registry(path: Path, profiles: list[SpeakerProfile], *, model_label: str) -> None:
    """写注册库(enroll 脚本用;upsert 语义由调用方组好 profiles 列表)。"""
    payload = {
        "version": 1,
        "model": model_label,
        "dim": int(profiles[0].embedding.shape[0]) if profiles else 0,
        "speakers": [
            {
                "name": p.name,
                "slug": p.slug,
                "samples": p.samples,
                "embedding": [round(float(x), 6) for x in p.embedding],
            }
            for p in profiles
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )


def load_extractor(model_path: Path, *, num_threads: int = 1) -> Any:
    """加载 sherpa-onnx SpeakerEmbeddingExtractor(2 核机务必 setup_fnc 预载,勿 job 内首载)。"""
    import sherpa_onnx  # type: ignore[import-not-found]

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(model_path), num_threads=num_threads, debug=False, provider="cpu"
    )
    if not config.validate():
        raise RuntimeError(f"speaker id: 模型配置无效 {model_path}")
    return sherpa_onnx.SpeakerEmbeddingExtractor(config)


def compute_embedding(
    extractor: Any, samples: np.ndarray, sample_rate: int = SPEAKER_SR
) -> np.ndarray:
    """float32 波形 → L2 归一 embedding(官方示例 API 形态,2026-07-03 逐行验证)。"""
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=sample_rate, waveform=samples)
    stream.input_finished()
    return l2_normalize(np.array(extractor.compute(stream), dtype=np.float32))


class SpeakerIdentifier:
    """embedding 比对器:持有 extractor + 注册库,同步比对(调用方丢线程池)。"""

    def __init__(self, extractor: Any, profiles: list[SpeakerProfile], threshold: float) -> None:
        self._extractor = extractor
        self._profiles = profiles
        self._threshold = threshold

    @property
    def threshold(self) -> float:
        return self._threshold

    def identify_sync(self, pcm: bytes) -> IdentifyResult:
        speech_s = len(pcm) / _BYTES_PER_SECOND
        samples = pcm16_to_float32(pcm)
        max_samples = int(_MAX_INFER_SECONDS * SPEAKER_SR)
        if samples.shape[0] > max_samples:
            samples = samples[-max_samples:]  # 取最近段(限 2 核推理耗时)
        t0 = time.perf_counter()
        emb = compute_embedding(self._extractor, samples)
        infer_ms = (time.perf_counter() - t0) * 1000.0
        scores = {p.name: float(np.dot(emb, p.embedding)) for p in self._profiles}
        best_name = max(scores, key=lambda k: scores[k])
        best_score = scores[best_name]
        return IdentifyResult(
            name=best_name if best_score >= self._threshold else None,
            best_name=best_name,
            best_score=best_score,
            scores=scores,
            speech_s=speech_s,
            infer_ms=infer_ms,
        )


class SpeakerIdSidecar:
    """旁路编排:ring buffer 消费 → 线程池比对 → 日志。所有异常内部吞掉。"""

    def __init__(
        self,
        ring: AudioRingBuffer,
        identifier: SpeakerIdentifier,
        *,
        min_speech_s: float = 1.0,
        dump_dir: Path | None = None,
    ) -> None:
        self.ring = ring
        self._identifier = identifier
        self._min_speech_s = min_speech_s
        # 标定期采集(SPEAKER_ID_DUMP_DIR):每 turn 的信道内音频落 wav,用于
        # "产品内注册"(注册/识别必须同信道——录音 app 原始音质 vs 浏览器
        # NS/AGC+opus+RTC 频谱差异巨大,跨信道 score 崩;2026-07-03 川哥真机实测 0.072)
        self._dump_dir = dump_dir
        self._busy = False
        self.last_result: IdentifyResult | None = None
        # P2 身份粘滞:最近一次命中的 (name, score)。UNKNOWN/短句不清除——单用户
        # 陪伴场景下"偶尔一句没认出"不该让 AI 突然忘了对方是谁;换人命中则覆盖。
        self._sticky: tuple[str, float] | None = None

    def context_note(self) -> str | None:
        """给 LLM 的身份注入文本(FastLLM 每请求调用,追加为末尾 system=近因位)。

        识别是 turn 后异步旁路 → 本轮结果赶不上本轮 LLM,注入的是**粘滞身份**
        (首句识别、第二句起生效)。措辞三红线:传感器数据非对话内容 / 自然使用
        不复述数字 / 对方自述优先(声纹 Score 是概率非强认证)。
        """
        if self._sticky is None:
            return None
        name, score = self._sticky
        return (
            f"[声纹识别] 当前和你说话的人是:{name}(声纹置信度 {score:.2f})。"
            "这是系统传感器信息,不是对话内容。自然地以这个身份称呼和对待对方,"
            "不要念出置信度数字或提及声纹系统;若对方自述的身份与此矛盾,以对方自述为准。"
        )

    def _dump_sync(self, pcm: bytes) -> None:
        import time as _t
        import wave

        self._dump_dir.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]
        path = self._dump_dir / f"turn-{int(_t.time() * 1000)}.wav"  # type: ignore[operator]
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SPEAKER_SR)
            wf.writeframes(pcm)
        logger.info("speaker id: dump %s (%.1fs)", path.name, len(pcm) / _BYTES_PER_SECOND)

    async def on_turn(self) -> None:
        """turn 提交后调用(fire-and-forget)。旁路铁律:绝不 raise。"""
        try:
            pcm = self.ring.snapshot_and_clear()
            speech_s = len(pcm) / _BYTES_PER_SECOND
            if self._dump_dir is not None and speech_s >= 0.5:
                await asyncio.to_thread(self._dump_sync, pcm)
            if speech_s < self._min_speech_s:
                logger.info(
                    "speaker id: skip(有效语音 %.2fs < %.1fs)", speech_s, self._min_speech_s
                )
                return
            if self._busy:  # 上一轮比对未完(快速连说):旁路宁可丢一次不排队
                logger.info("speaker id: skip(上一轮比对进行中)")
                return
            self._busy = True
            try:
                result = await asyncio.to_thread(self._identifier.identify_sync, pcm)
            finally:
                self._busy = False
            self.last_result = result
            if result.name is not None:
                self._sticky = (result.name, result.best_score)
            logger.info(
                "speaker id: %s best=%s score=%.3f thr=%.2f speech=%.1fs infer=%.0fms scores=%s",
                result.name or "UNKNOWN",
                result.best_name,
                result.best_score,
                self._identifier.threshold,
                result.speech_s,
                result.infer_ms,
                {k: round(v, 3) for k, v in result.scores.items()},
            )
        except Exception:
            logger.warning("speaker id: 旁路比对失败(忽略,不影响主链路)", exc_info=True)


__all__ = [
    "AudioRingBuffer",
    "IdentifyResult",
    "SpeakerIdSidecar",
    "SpeakerIdentifier",
    "SpeakerProfile",
    "compute_embedding",
    "l2_normalize",
    "load_extractor",
    "load_registry",
    "pcm16_to_float32",
    "save_registry",
]
