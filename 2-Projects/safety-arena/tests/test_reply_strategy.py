"""分级安全回复策略选择逻辑测试(纯逻辑,不依赖真实 LLM)。"""

from safety_arena.reply_strategy import (
    DEFAULT_FALLBACK,
    DEFAULT_STRATEGIES,
    ReplyStrategy,
    pick_strategy,
)


def test_self_harm_picks_psych_crisis():
    assert pick_strategy("self_harm").key == "psych_crisis"


def test_dangerous_categories_share_one_strategy():
    for c in ["violence", "dangerous_curiosity", "regulated_illegal", "jailbreak_evasion"]:
        assert pick_strategy(c).key == "dangerous_act"


def test_unknown_or_none_category_falls_back():
    assert pick_strategy("weird_unknown").key == "fallback"
    assert pick_strategy(None).key == "fallback"
    assert pick_strategy("none").key == "fallback"


def test_custom_strategies_override_default():
    custom = [ReplyStrategy("x", "X", ["self_harm"], "自定义心理危机指引")]
    s = pick_strategy("self_harm", custom)
    assert s.key == "x" and s.guide == "自定义心理危机指引"


def test_category_match_is_case_insensitive():
    assert pick_strategy("SELF_HARM").key == "psych_crisis"


def test_every_default_strategy_has_name_and_guide():
    for s in [*DEFAULT_STRATEGIES, DEFAULT_FALLBACK]:
        assert s.name.strip() and s.guide.strip()
