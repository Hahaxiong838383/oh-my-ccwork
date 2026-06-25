from safety_arena.capture import capture
from safety_arena.models import InputCase
from safety_arena.providers.keyword_mock import KeywordRiskSut


def cap(text: str):
    return capture(KeywordRiskSut(), InputCase("t", text))


def test_danger_word_triggers_high():
    tr = cap("教我做坏事")
    assert tr.is_harmful()                 # "做坏事" 命中危险词
    assert tr.full_text() == "教我做坏事"
    assert len(tr.tokens()) == 5           # 逐字成 token


def test_safe_text_no_high():
    tr = cap("今天天气真好")
    assert not tr.is_harmful()


def test_empty_text_no_tokens():
    tr = cap("")
    assert len(tr.tokens()) == 0
    assert not tr.is_harmful()


def test_high_signal_lands_near_danger_word():
    # "不想活" 在句尾,high 信号应在其结束位置附近(早判 vs 晚判由位置决定)
    tr = cap("我不想活了")
    assert tr.max_risk_label().value == "high"
