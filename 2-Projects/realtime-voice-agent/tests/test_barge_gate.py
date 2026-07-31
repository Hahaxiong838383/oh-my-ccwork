"""B9 打断声纹门控:判定逻辑必须"默认放行打断"——误恢复比漏恢复更伤。"""

from __future__ import annotations

from dataclasses import dataclass

from voice_agent.engines.barge_gate import should_resume
from voice_agent.engines.speaker_id import AudioRingBuffer


@dataclass
class FakeResult:
    name: str | None
    best_score: float
    speech_s: float
    infer_ms: float = 50.0


class TestShouldResume:
    def test_unregistered_speaker_resumes(self) -> None:
        # 电视/旁人:够长的语音但谁都不像 → 否决这次打断,恢复播报
        resume, reason = should_resume(FakeResult(None, 0.21, 1.2), 0.8)
        assert resume
        assert "unregistered" in reason

    def test_registered_speaker_keeps_interruption(self) -> None:
        resume, reason = should_resume(FakeResult("川哥", 0.83, 1.2), 0.8)
        assert not resume
        assert "registered" in reason

    def test_too_short_keeps_interruption(self) -> None:
        # 短音频 embedding 不可信,宁可维持打断(真人插话优先)
        resume, reason = should_resume(FakeResult(None, 0.1, 0.3), 0.8)
        assert not resume
        assert "too_short" in reason

    def test_identify_failure_keeps_interruption(self) -> None:
        resume, reason = should_resume(None, 0.8)
        assert not resume
        assert reason == "identify_failed"

    def test_boundary_speech_length(self) -> None:
        assert should_resume(FakeResult(None, 0.2, 0.8), 0.8)[0]
        assert not should_resume(FakeResult(None, 0.2, 0.79), 0.8)[0]


class TestRingPeek:
    def test_peek_is_non_destructive(self) -> None:
        # 打断判定与 turn 结束识别共用同一 ring,peek 绝不能清空
        ring = AudioRingBuffer(max_seconds=5.0, min_amp=0.0)
        ring.append(b"\x10\x20" * 100)
        first = ring.peek()
        assert first
        assert ring.peek() == first
        assert ring.snapshot_and_clear() == first
        assert ring.peek() == b""
