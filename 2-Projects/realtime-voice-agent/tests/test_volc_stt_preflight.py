"""S1 v3 投机触发器纯逻辑单测(不依赖网络/火山,只测纯函数)。"""

from __future__ import annotations

import struct

from voice_agent.engines.volc_stt import (
    _canon_transcript,
    _mean_abs_amp,
    _pf_should_fire,
)


def _pcm(*samples: int) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


class TestMeanAbsAmp:
    def test_silence_frame_is_low(self) -> None:
        assert _mean_abs_amp(_pcm(0, 1, -2, 3, -1, 0)) < 10

    def test_speech_frame_is_high(self) -> None:
        assert _mean_abs_amp(_pcm(4000, -3500, 5000, -4200)) > 1000

    def test_int16_min_no_overflow(self) -> None:
        # -32768 直接 abs 会溢出回负,必须先升位
        assert _mean_abs_amp(_pcm(-32768, -32768)) == 32768.0

    def test_empty_and_odd_bytes(self) -> None:
        assert _mean_abs_amp(b"") == 0.0
        assert _mean_abs_amp(b"\x01") == 0.0  # 不足一个样本
        _ = _mean_abs_amp(_pcm(100) + b"\x01")  # 奇数字节截断不崩


class TestPfShouldFire:
    def test_fires_when_all_conditions_met(self) -> None:
        assert _pf_should_fire(
            tail="今天天气怎么样",
            silence_since_ms=1000.0,
            last_change_ms=1010.0,  # 静音开始后 interim 补齐过尾字(条件④)
            now_ms=1200.0,  # 静音 200ms ≥180, 文本静止 190ms ≥150
            silence_ms=180.0,
            text_quiet_ms=150.0,
        )

    def test_stale_interim_no_fire(self) -> None:
        # 2026-07-02 HK 实测 miss 根因复现:interim 停在半句("今天北京的天气"),
        # 最后一次更新在静音开始**之前**(stale)→ 尾字还没识别出来,不准投机
        assert not _pf_should_fire(
            tail="今天北京的天气",
            silence_since_ms=1000.0,
            last_change_ms=800.0,  # 静音前就静止了 = stale,非完整
            now_ms=1250.0,  # 静音 250ms、文本静止 450ms 都够,仍不触发
            silence_ms=180.0,
            text_quiet_ms=150.0,
        )

    def test_no_tail_no_fire(self) -> None:
        # 用户没说话时的长静音:无 interim → 不触发(不烧 token)
        assert not _pf_should_fire(
            tail="",
            silence_since_ms=0.0,
            last_change_ms=0.0,
            now_ms=99999.0,
            silence_ms=180.0,
            text_quiet_ms=150.0,
        )

    def test_still_speaking_no_fire(self) -> None:
        # 出声中(silence_since=None)不触发
        assert not _pf_should_fire(
            tail="今天",
            silence_since_ms=None,
            last_change_ms=0.0,
            now_ms=1000.0,
            silence_ms=180.0,
            text_quiet_ms=150.0,
        )

    def test_short_silence_no_fire(self) -> None:
        # 辅音间隙级短静音(<180ms)不触发
        assert not _pf_should_fire(
            tail="今天天气",
            silence_since_ms=1000.0,
            last_change_ms=500.0,
            now_ms=1100.0,  # 静音仅 100ms
            silence_ms=180.0,
            text_quiet_ms=150.0,
        )

    def test_text_still_changing_no_fire(self) -> None:
        # STT 还在修正(文本刚变):静音够了也不触发,防投机到中间稿
        assert not _pf_should_fire(
            tail="今天天气怎么样",
            silence_since_ms=1000.0,
            last_change_ms=1150.0,
            now_ms=1200.0,  # 静音 200ms 够,但文本 50ms 前才变
            silence_ms=180.0,
            text_quiet_ms=150.0,
        )


class TestCanonTranscript:
    def test_strips_punct_keeps_decimal(self) -> None:
        assert _canon_transcript("今天,天气怎么样?") == "今天天气怎么样"
        assert _canon_transcript("圆周率是 3.14 对吧。") == "圆周率是3.14对吧"

    def test_preflight_final_converge(self) -> None:
        # 命中率核心:interim 无标点 vs definite 补标点 → canonical 后全等
        assert _canon_transcript("给我讲恐龙故事好不好") == _canon_transcript(
            "给我讲恐龙故事好不好?"
        )
