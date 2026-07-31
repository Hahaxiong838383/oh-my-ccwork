"""SentinelStripper 契约:哨兵绝不放行(含跨 chunk 切分),正常文本一字不丢。"""

from __future__ import annotations

import pytest

from voice_agent.engines.sentinel import SentinelStripper

S = "[[END_SESSION]]"


def run(chunks: list[str]) -> tuple[str, bool]:
    st = SentinelStripper(S)
    out = "".join(st.feed(c) for c in chunks)
    out += st.flush()
    return out, st.found


class TestSentinelStripper:
    def test_whole_in_one_chunk(self) -> None:
        out, found = run(["再见啦,下次见!" + S])
        assert out == "再见啦,下次见!"
        assert found

    def test_split_across_chunks(self) -> None:
        out, found = run(["拜拜[[END", "_SESS", "ION]]"])
        assert out == "拜拜"
        assert found

    def test_char_by_char(self) -> None:
        out, found = run(list("明天见!" + S))
        assert out == "明天见!"
        assert found

    def test_false_prefix_released_on_flush(self) -> None:
        # 尾部像哨兵前缀但流结束了——必须原样补回,不能吞字
        out, found = run(["坐标是 [[EN"])
        assert out == "坐标是 [[EN"
        assert not found

    def test_false_prefix_resolved_by_next_chunk(self) -> None:
        out, found = run(["列表 [[", "1]] 和 [[2]]"])
        assert out == "列表 [[1]] 和 [[2]]"
        assert not found

    def test_sentinel_mid_stream(self) -> None:
        out, found = run(["前半" + S + "后半"])
        assert out == "前半后半"
        assert found

    def test_multiple_occurrences(self) -> None:
        out, found = run([S + "文本" + S])
        assert out == "文本"
        assert found

    def test_no_sentinel_passthrough(self) -> None:
        out, found = run(["今天天气不错", ",适合出门。"])
        assert out == "今天天气不错,适合出门。"
        assert not found

    def test_empty_sentinel_rejected(self) -> None:
        with pytest.raises(ValueError):
            SentinelStripper("")
