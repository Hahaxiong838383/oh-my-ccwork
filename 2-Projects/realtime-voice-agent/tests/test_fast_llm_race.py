"""R1 赛马组件纯逻辑单测:ThinkStripper 流式剥 think(跨 chunk 边界)。"""

from __future__ import annotations

from voice_agent.engines.fast_llm import ThinkStripper


def _feed_all(chunks: list[str]) -> str:
    s = ThinkStripper()
    out = "".join(s.feed(c) for c in chunks)
    return out + s.flush()


class TestThinkStripper:
    def test_no_think_passthrough(self) -> None:
        assert _feed_all(["你好", ",今天", "天气不错。"]) == "你好,今天天气不错。"

    def test_whole_think_in_one_chunk(self) -> None:
        assert _feed_all(["<think>推理过程</think>答案是蓝色。"]) == "答案是蓝色。"

    def test_think_spans_many_chunks(self) -> None:
        # MiniMax 真实形态:首 chunk 就是 <think> 开头,思考流好几段
        assert (
            _feed_all(["<think>第一段", "第二段思考", "还在想</think>", "天空是蓝色的。"])
            == "天空是蓝色的。"
        )

    def test_open_tag_split_across_chunks(self) -> None:
        # "<think>" 标签本身被 chunk 边界切开
        assert _feed_all(["<th", "ink>思考</think>好的。"]) == "好的。"

    def test_close_tag_split_across_chunks(self) -> None:
        assert _feed_all(["<think>思考</th", "ink>好的。"]) == "好的。"

    def test_unclosed_think_discarded_on_flush(self) -> None:
        # 全程思考没闭合(max_tokens 被 think 吃光的形态)→ 可见输出为空
        assert _feed_all(["<think>没完没了的思考", "还在思考"]) == ""

    def test_text_before_think(self) -> None:
        assert _feed_all(["好的<think>x</think>,明白了。"]) == "好的,明白了。"

    def test_angle_bracket_not_tag(self) -> None:
        # 普通 "<" 文本不被误吞(尾部与 <think> 前缀重叠会暂存,flush 补出)
        assert _feed_all(["3 < 5 对吧"]) == "3 < 5 对吧"
        assert _feed_all(["a<t", "b>c"]) == "a<tb>c"

    def test_visible_streams_incrementally(self) -> None:
        # 可见文本应逐 chunk 流出(不是攒到 flush),保 TTFT
        s = ThinkStripper()
        assert s.feed("<think>xx</think>答") == "答"
        assert s.feed("案。") == "案。"
        assert s.flush() == ""
