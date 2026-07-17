"""急停白名单单测(P0 环境音防误打断,2026-07-17)。

字数门 min_interruption_words=2 会把单字"停"按长度当噪音丢弃;
白名单把打断意图明确的短词捞回直通。核心契约:精确匹配(非包含)+标准化容错。
"""

from __future__ import annotations

from voice_agent.engines.tier_a_cascade import (
    _DEFAULT_INTERRUPT_HOTWORDS,
    _normalize_utterance,
    _parse_hotwords,
)


class TestNormalizeUtterance:
    def test_strips_trailing_punct(self) -> None:
        # ASR 转写常带尾标点,不标准化则"停。"漏匹配
        assert _normalize_utterance("停。") == "停"
        assert _normalize_utterance("等等！") == "等等"
        assert _normalize_utterance("别说了…") == "别说了"

    def test_strips_inner_whitespace(self) -> None:
        assert _normalize_utterance("等 等") == "等等"

    def test_empty_and_none_safe(self) -> None:
        assert _normalize_utterance("") == ""
        assert _normalize_utterance("。！？") == ""


class TestParseHotwords:
    def test_default_contains_core_words(self) -> None:
        words = _parse_hotwords(None)
        assert "停" in words
        assert "别说了" in words
        assert "等等" in words

    def test_empty_string_disables(self) -> None:
        # 显式空串=禁用白名单(回滚开关)
        assert _parse_hotwords("") == frozenset()

    def test_custom_list_normalized(self) -> None:
        words = _parse_hotwords("停,慢点。, 打住 ")
        assert words == frozenset({"停", "慢点", "打住"})


class TestExactMatchContract:
    """白名单语义=精确匹配:长句包含急停词不触发(那是正常对话,交字数门打断)。"""

    def test_containing_sentence_not_in_set(self) -> None:
        words = _parse_hotwords(None)
        assert _normalize_utterance("停车场怎么走？") not in words
        assert _normalize_utterance("这个故事先别说了后面的结局") not in words

    def test_exact_word_hits(self) -> None:
        words = _parse_hotwords(None)
        for said in ("停。", "停一下", "闭嘴!", "安静。"):
            assert _normalize_utterance(said) in words

    def test_default_words_all_normalized(self) -> None:
        # 默认词表自身必须已是标准形(防手滑加了带标点的词导致永不匹配)
        for w in _DEFAULT_INTERRUPT_HOTWORDS.split(","):
            assert w == _normalize_utterance(w)
