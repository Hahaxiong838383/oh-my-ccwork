"""A 方案共脑指引解析(_parse_myjavis_brain)单测——dispatch metadata → LLM 路由决策。

铁律:解析失败/字段残缺一律回落 None(默认大脑),绝不半配置运行。
"""

from __future__ import annotations

from voice_agent.engines.tier_a_cascade import _parse_myjavis_brain


def test_valid_metadata_parsed() -> None:
    raw = '{"myjavis": {"session": "jv-tn_abc123-xyz", "tenant": "tn_abc12345"}}'
    brain = _parse_myjavis_brain(raw)
    assert brain == {"session": "jv-tn_abc123-xyz", "tenant": "tn_abc12345"}


def test_empty_and_absent() -> None:
    assert _parse_myjavis_brain("") is None
    assert _parse_myjavis_brain("   ") is None  # 空白=非法 JSON → None


def test_invalid_json() -> None:
    assert _parse_myjavis_brain("{not json") is None
    assert _parse_myjavis_brain("[1,2]") is None
    assert _parse_myjavis_brain('"str"') is None


def test_missing_or_bad_fields() -> None:
    assert _parse_myjavis_brain('{"myjavis": {}}') is None
    assert _parse_myjavis_brain('{"myjavis": {"session": "s"}}') is None
    assert _parse_myjavis_brain('{"myjavis": {"tenant": "t"}}') is None
    assert _parse_myjavis_brain('{"myjavis": {"session": "", "tenant": "t"}}') is None
    assert _parse_myjavis_brain('{"myjavis": {"session": 1, "tenant": "t"}}') is None
    assert _parse_myjavis_brain('{"other": {"session": "s", "tenant": "t"}}') is None


def test_extra_fields_ignored() -> None:
    raw = '{"myjavis": {"session": "s1", "tenant": "t1", "future": true}, "x": 1}'
    assert _parse_myjavis_brain(raw) == {"session": "s1", "tenant": "t1"}
