#!/usr/bin/env python3
"""Build the 2026-11-11 natural-language routing corpus and freeze the split.

Gold labels are user-intent labels. They are not copied from CLI output.
Prior frozen corpora are an overlap blocklist only and are not copied.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PRIOR_PATHS = [
    Path("/Users/fu-121/.local/state/p003-lexicon-phase1-lab-20261111/corpus-frozen-review/corpus-dev.json"),
    Path("/Users/fu-121/.local/state/p003-lexicon-phase1-lab-20261111/corpus-frozen-review/corpus-holdout.json"),
    Path("/Users/fu-121/.local/state/p003-lexicon-phase1-lab-20261111/corpus-frozen-review/disputed.json"),
    Path("/Users/fu-121/.local/state/p003-lexicon-implementation-20261111/grok-holdout/corpus-holdout.json"),
]

CASES: list[dict] = []
SEEN: set[str] = set()


def prior_texts() -> set[str]:
    found = set()
    for path in PRIOR_PATHS:
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        rows = data["cases"] if isinstance(data, dict) else data
        for case in rows:
            for turn in case["utterances"]:
                found.add(turn["text"])
    return found


def add(category, family, provenance, source_id, utterances, expected, notes,
        layer="pure_route", invariants=None, human=False):
    if isinstance(utterances, str):
        utterances = [(utterances, 0)]
    utts = []
    for index, (text, at_ms) in enumerate(utterances):
        if len(text) > 128 or not text:
            raise SystemExit(f"bad text: {text!r}")
        utts.append({"text": text, "at_ms": at_ms, "reset": index == 0})
    key = " || ".join(f"{u['at_ms']}:{u['text']}" for u in utts)
    if key in SEEN:
        raise SystemExit(f"duplicate scenario: {key}")
    SEEN.add(key)
    if not isinstance(expected, list):
        expected = [expected]
    if len(expected) != len(utts):
        raise SystemExit(f"turn mismatch: {key}")
    CASES.append({
        "id": f"nlc-{len(CASES)+1:04d}",
        "category": category,
        "family": family,
        "layer": layer,
        "provenance": provenance,
        "source_id": source_id,
        "source_kind": provenance,
        "utterances": utts,
        "expected": expected,
        "invariants": invariants or [],
        "notes": notes,
        "human_probe": human,
    })


def wx(place, day, needs, metric="forecast", action="search"):
    return {"action": action, "weather_required": True, "place": place, "day_offset": day,
            "needs": needs, "metric": metric}


def auto(day, needs, metric="forecast"):
    return wx("@auto", day, needs, metric)


def chat():
    return {"action": "chat", "weather_required": False, "query_must_be_null": True}


def clarify(reason):
    return {"action": "clarify_city", "weather_required": False, "query_must_be_null": True,
            "clarification": reason}


def search_only():
    return {"action": "search", "weather_required": False}


def unsupported():
    return {"action": "search", "weather_required": False, "must_not_auto": True}


def build():
    direct = [
        ("杭州", 0, "杭州今天天气如何"),
        ("成都", 0, "成都今天的天气"),
        ("武汉", 0, "武汉今天天气好不好"),
        ("深圳", 1, "深圳明天会下雨吗"),
        ("广州", 1, "广州明天的天气"),
        ("南京", 1, "南京明天天气如何"),
        ("北京", 2, "北京后天天气怎么样"),
        ("上海", 2, "上海后天会下雨吗"),
        ("拉萨", 0, "拉萨今天天气怎么样"),
        ("青岛", 1, "青岛明天会下雨吗"),
    ]
    for city, day, text in direct:
        family = f"weather.direct|{city}|{day}"
        add("weather", family, "rewrite", "S03", text, wx(city, day, ["overview"]),
            "直问城市和日期。礼貌变体留在同一族。")
        add("weather", family, "rewrite", "S03", "能告诉我" + text, wx(city, day, ["overview"]),
            "能告诉我不得进入地名。")

    add("weather", "weather.word_order|杭州|0", "synthetic", "S15", "天气今天杭州怎么样",
        wx("杭州", 0, ["overview"]), "语序倒装，地名仍只能是杭州。", invariants=["place_exact"])
    add("weather", "weather.word_order|杭州|0", "synthetic", "S15", "杭州的天气今天",
        wx("杭州", 0, ["overview"]), "日期在句尾。")
    add("weather", "weather.address|成都|1", "synthetic", "S15", "小可，成都明天天气怎么样",
        wx("成都", 1, ["overview"]), "唤醒词不得进入地名。")
    add("weather", "weather.aqi|杭州|0", "rewrite", "S03", "杭州的空气质量",
        wx("杭州", 0, ["overview"], metric="aqi"), "空气质量，不是带伞。")
    add("weather", "weather.aqi|上海|0", "rewrite", "S03", "上海今天空气质量怎么样",
        wx("上海", 0, ["overview"], metric="aqi"), "空气质量问法。")
    add("weather", "weather.aqi_unsupported|北京|1", "synthetic", "S15", "北京明天的空气质量",
        unsupported(), "非今天的空气质量不能改成今天或自动定位。", invariants=["must_not_auto"])
    add("weather", "weather.current|青岛|0", "rewrite", "S07", "青岛现在多少度",
        wx("青岛", 0, ["overview"], metric="current"), "现在是实时。")
    add("weather", "weather.current|厦门|0", "rewrite", "S14", "厦门现在的天气",
        wx("厦门", 0, ["overview"], metric="current"), "实时概况。")
    for text, day, metric in [
        ("明天会下雨吗", 1, "forecast"),
        ("这里后天天气怎么样", 2, "forecast"),
        ("外面现在多少度", 0, "current"),
    ]:
        add("weather", f"weather.omitted_place|{day}|{metric}", "rewrite", "S04", text,
            auto(day, ["overview"], metric), "没有点名城市时用设备定位，不猜城市。")
    add("weather", "weather.human|0", "rewrite", "S04", "今天天气如何",
        auto(0, ["overview"]), "最短天气问法。", human=True)
    add("weather", "weather.rain|长沙|1", "rewrite", "S06", "长沙明天会不会下雨",
        wx("长沙", 1, ["overview"]), "会不会下雨仍是概况。")
    add("weather", "weather.rain|昆明|0", "rewrite", "S05", "昆明今天会下雨吗",
        wx("昆明", 0, ["overview"]), "会下雨吗。")
    add("weather", "weather.omitted_day|哈尔滨", "synthetic", "S15", "哈尔滨天气怎么样",
        wx("哈尔滨", 0, ["overview"]), "没说日期按今天。")
    add("weather", "weather.ambiguous|朝阳", "synthetic", "S15", "朝阳今天天气",
        clarify("ambiguous_place"), "朝阳对应多个站点，必须澄清。", invariants=["no_fuzzy_city"])
    add("weather", "weather.disambiguated|辽宁朝阳|0", "synthetic", "S15", "辽宁朝阳今天天气",
        wx("辽宁朝阳", 0, ["overview"]), "省名消歧，保留整词。")
    add("weather", "weather.disambiguated|北京朝阳|1", "synthetic", "S15", "北京朝阳明天天气",
        wx("北京朝阳", 1, ["overview"]), "北京朝阳不是辽宁朝阳。")
    add("weather", "weather.ambiguous|西安", "synthetic", "S15", "西安今天天气怎么样",
        clarify("ambiguous_place"), "西安这一别名对应多个站点。", invariants=["no_fuzzy_city"])
    add("weather", "weather.disambiguated|西安市|0", "synthetic", "S15", "西安市今天天气怎么样",
        wx("西安市", 0, ["overview"]), "西安市不再歧义。")
    add("weather", "weather.ambiguous|西湖", "synthetic", "S15", "西湖今天天气",
        clarify("ambiguous_place"), "西湖对应多个站点。")
    add("weather", "weather.disambiguated|杭州西湖|1", "synthetic", "S15", "杭州西湖明天天气",
        wx("杭州西湖", 1, ["overview"]), "区县全称保留。")
    add("weather", "weather.multi|北京上海|0", "synthetic", "S15", "北京和上海今天天气",
        clarify("multiple_places"), "不能只查第一个城市。")
    add("weather", "weather.multi|杭州成都|1", "synthetic", "S15", "杭州以及成都明天天气",
        clarify("multiple_places"), "以及连接两个城市。")
    add("weather", "weather.multi|广州深圳|0", "synthetic", "S15", "广州、深圳今天天气怎么样",
        clarify("multiple_places"), "顿号并列。")
    add("weather", "weather.asr_literal|抗州|0", "synthetic", "S15", "抗州今天天气怎么样",
        wx("抗州", 0, ["overview"]), "禁止把抗州改成杭州或自动定位。",
        invariants=["no_fuzzy_city", "place_exact"])
    add("weather", "weather.asr_literal|沈洋|1", "synthetic", "S15", "沈洋明天会下雨吗",
        wx("沈洋", 1, ["overview"]), "沈洋不是沈阳。", invariants=["no_fuzzy_city", "place_exact"])
    add("weather", "weather.contradictory_admin|江苏邓州|1", "rewrite", "S04", "江苏邓州明天天气怎么样",
        wx("江苏邓州", 1, ["overview"]), "保留互斥的省县原话，不改成邓州或南京。",
        invariants=["no_fuzzy_city", "place_exact"])
    add("weather", "weather.truncated_literal|州|0", "synthetic", "S15", "州今天天气怎么样",
        wx("州", 0, ["overview"]), "纯路由下的残段不是杭州。", invariants=["no_fuzzy_city", "place_exact"])
    add("weather", "weather.unsupported_date|北京|next_week", "synthetic", "S15", "北京下周的天气",
        unsupported(), "下周不能改查今天或自动定位。", invariants=["must_not_auto"])
    add("weather", "weather.unsupported_date|上海|tonight", "synthetic", "S15", "上海晚上天气怎么样",
        unsupported(), "晚上不是默认今天。", invariants=["must_not_auto"])
    add("weather", "weather.unsupported_date|广州|yesterday", "synthetic", "S15", "广州昨天的天气",
        unsupported(), "昨天不外推成今天。", invariants=["must_not_auto"])
    add("weather", "session.place_fragment|成都|1500", "synthetic", "S16",
        [("成都", 0), ("今天天气如何", 1500)],
        [chat(), wx("成都", 0, ["overview"])],
        "两秒内完整城市名加天气尾句。这是路由会话，不是单字暂存。", layer="routing_session")
    add("weather", "session.place_fragment|成都|2500", "synthetic", "S16",
        [("成都", 0), ("今天天气如何", 2500)],
        [chat(), auto(0, ["overview"])],
        "超过两秒城市碎片失效，第二句不能残留成都。", layer="routing_session",
        invariants=["fragment_expired"])
    add("weather", "session.recent_day|北京|3000", "synthetic", "S16",
        [("北京今天的天气情况", 0), ("明天呢", 3000)],
        [wx("北京", 0, ["overview"]), wx("北京", 1, ["overview"])],
        "已查天气后十秒内，明天呢继承北京。", layer="routing_session")
    add("weather", "session.recent_day|北京|11000", "synthetic", "S16",
        [("北京今天的天气情况", 0), ("明天呢", 11000)],
        [wx("北京", 0, ["overview"]), chat()],
        "超过十秒不再继承。单独的明天呢不是查询。", layer="routing_session")

    comfort = [
        ("北京", 0, "北京今天冷不冷"),
        ("上海", 1, "上海明天热不热"),
        ("广州", 0, "广州今天冷吗"),
        ("深圳", 2, "深圳后天热吗"),
        ("成都", 0, "成都今天冷不冷呀"),
        ("杭州", 1, "杭州明天热不热啊"),
        ("南京", 0, "南京今天冷不冷"),
        ("武汉", 1, "武汉明天热吗"),
    ]
    for city, day, text in comfort:
        family = f"comfort.direct|{city}|{day}"
        add("comfort", family, "rewrite", "S06", text, wx(city, day, ["comfort"]),
            "冷热记为 comfort，不是体温。")
        add("comfort", family, "rewrite", "S04", "能告诉我" + text, wx(city, day, ["comfort"]),
            "礼貌变体同一族。能告诉我不得进入地名。")
    add("comfort", "comfort.outside|0", "rewrite", "S05", "外面冷吗", auto(0, ["comfort"]), "外面冷吗。")
    add("comfort", "comfort.outside|0b", "rewrite", "S05", "出门热吗", auto(0, ["comfort"]), "出门热吗。")
    add("comfort", "comfort.human|0", "rewrite", "S04", "今天冷不冷呢", auto(0, ["comfort"]),
        "最短冷热问法。", human=True)
    add("comfort", "comfort.gap_huibuhui|0", "synthetic", "S15", "今天会不会热",
        auto(0, ["comfort"]), "会不会热应是冷热。词表没有这句，预期漏触发，标签不改。",
        invariants=["known_gap"])
    add("comfort", "comfort.gap_huibuhui|杭州|1", "synthetic", "S15", "杭州明天会不会冷",
        wx("杭州", 1, ["comfort"]), "会不会冷加明确城市。", invariants=["known_gap"], human=True)
    add("comfort", "comfort.gap_huibuhui|bare", "synthetic", "S15", "会不会热",
        auto(0, ["comfort"]), "省略日期和城市仍是出门体感。", invariants=["known_gap"])
    add("comfort", "comfort.statement|0", "synthetic", "S15", "今天外面热死了",
        auto(0, ["comfort"]), "带外面的热死了是体感。", invariants=["known_gap"])
    add("comfort", "comfort.both|深圳|0", "synthetic", "S15", "深圳今天冷不冷，要不要带伞",
        wx("深圳", 0, ["comfort", "umbrella"]), "冷热和带伞都要留下。")
    add("comfort", "session.comfort_tail|武汉|1000", "synthetic", "S16",
        [("武汉", 0), ("今天冷不冷呢", 1000)],
        [chat(), wx("武汉", 0, ["comfort"])],
        "完整城市后两秒内接今天冷不冷呢。", layer="routing_session")
    add("comfort", "session.comfort_bare|武汉|1000", "synthetic", "S16",
        [("武汉", 0), ("热不热", 1000)],
        [chat(), wx("武汉", 0, ["comfort"])],
        "只说热不热也应继承刚说的城市。已知缺口，不改标签。",
        layer="routing_session", invariants=["known_gap"])
    add("comfort", "session.comfort_expire|武汉|2500", "synthetic", "S16",
        [("武汉", 0), ("今天冷不冷呢", 2500)],
        [chat(), auto(0, ["comfort"])],
        "超过两秒后不再带武汉。", layer="routing_session")

    umbrellas = [
        ("杭州", 1, "杭州明天要不要带伞"),
        ("上海", 2, "上海后天需要带伞吗"),
        ("北京", 0, "北京今天要带伞吗"),
        ("广州", 1, "广州明天需不需要带伞"),
        ("成都", 0, "成都今天要不要拿伞"),
        ("深圳", 1, "深圳明天需要拿伞吗"),
        ("南京", 0, "南京今天要不要带伞"),
        ("武汉", 2, "武汉后天要带伞吗"),
    ]
    for city, day, text in umbrellas:
        add("umbrella", f"umbrella.direct|{city}|{day}", "rewrite", "S01", text,
            wx(city, day, ["umbrella"]), "带伞或拿伞。")
    add("umbrella", "umbrella.quote|0", "quote", "S01", "今天要不要带伞啊",
        auto(0, ["umbrella"]), "简书对灵犀的短引。", human=True)
    add("umbrella", "umbrella.exit|0", "rewrite", "S01", "出门要带伞吗", auto(0, ["umbrella"]), "没点城市。")
    add("umbrella", "umbrella.exit|1", "rewrite", "S03", "明天需要带伞吗", auto(1, ["umbrella"]),
        "语音助手说明里的表达族，此句是改写。")
    add("umbrella", "umbrella.gap_dasan|杭州|1", "rewrite", "S06", "杭州明天要不要打伞",
        wx("杭州", 1, ["umbrella"]), "打伞应等同带伞。已知缺口，不改标签。",
        invariants=["known_gap"], human=True)
    add("umbrella", "umbrella.gap_dasan|0", "synthetic", "S15", "今天要打伞吗",
        auto(0, ["umbrella"]), "要打伞吗。", invariants=["known_gap"])
    add("umbrella", "umbrella.gap_yongsan|南京|0", "synthetic", "S15", "南京今天用不用伞",
        wx("南京", 0, ["umbrella"]), "用伞应记为 umbrella。", invariants=["known_gap"])
    add("umbrella", "umbrella.gap_linyu|0", "synthetic", "S15", "今天会不会淋雨",
        auto(0, ["umbrella"]), "淋雨问的是带伞，不是故事。", invariants=["known_gap"])
    add("umbrella", "umbrella.gap_dasan_with_rain|武汉|1", "synthetic", "S15", "武汉明天下雨要打伞吗",
        wx("武汉", 1, ["umbrella"]), "下雨能触发天气时，打伞仍应记成 umbrella。",
        invariants=["known_gap"])
    add("umbrella", "umbrella.with_overview|厦门|0", "synthetic", "S15", "厦门今天天气，要不要带伞",
        wx("厦门", 0, ["umbrella"]), "带伞槽要留下。")
    add("umbrella", "session.umbrella_suffix|北京|3000", "synthetic", "S16",
        [("北京今天的天气情况", 0), ("要不要带伞", 3000)],
        [wx("北京", 0, ["overview"]), wx("北京", 0, ["umbrella"])],
        "十秒内要不要带伞继承北京和今天。", layer="routing_session")
    add("umbrella", "session.umbrella_gap|北京|3000", "synthetic", "S15",
        [("北京今天的天气情况", 0), ("打伞吗", 3000)],
        [wx("北京", 0, ["overview"]), wx("北京", 0, ["umbrella"])],
        "打伞吗也应继承。跟进词表没有打伞。", layer="routing_session", invariants=["known_gap"])
    add("umbrella", "session.umbrella_expire|北京|11000", "synthetic", "S16",
        [("北京今天的天气情况", 0), ("要不要带伞", 11000)],
        [wx("北京", 0, ["overview"]), auto(0, ["umbrella"])],
        "超过十秒不再带北京。", layer="routing_session")

    searches = [
        ("search.explicit|height", "帮我查一下珠穆朗玛峰有多高", "明确检索稳定知识。", False),
        ("search.explicit|mars", "搜索一下火星为什么是红色的", "明确搜索。", False),
        ("search.explicit|photosynthesis", "帮我查光合作用是什么", "带查才搜索。不带查的在负例。", False),
        ("search.explicit|oil", "联网查一下今天的油价", "联网加查，当前公开事实。", True),
        ("search.explicit|rate_now", "现在的汇率", "已发布的当前事实触发。", False),
        ("search.explicit|rate_today", "今日汇率多少", "今日汇率。", False),
        ("search.explicit|news", "最新新闻", "最新新闻。", False),
        ("search.explicit|progress", "最新进展说一下", "最新进展。", False),
        ("search.prefix|retrieve", "帮我检索一下杭州亚运会", "检索前缀，不是天气。", False),
        ("search.prefix|learn", "帮我了解一下今天的金价", "了解一下公开价格。", False),
        ("search.implicit|zoo", "我想知道动物园今天开不开门", "想知道加场馆加开门。", False),
        ("search.implicit|museum", "我想知道科技馆今天开门吗", "同类场馆营业事实。", False),
        ("search.gap|palace_bare", "故宫今天开门吗", "没有帮我查仍是当前公开事实。可能漏，标签不改。", True),
        ("search.gap|news_bare", "今天有什么新闻", "不是闲聊。", False),
        ("search.gap|rate_pair", "现在美元兑人民币多少", "不一定含现在的汇率四个字。", False),
        ("search.explicit|page", "帮我读一下央视网国内新闻页面", "读公开新闻页。", False),
        ("search.explicit|oil2", "小可，查一下今天油价", "查一下油价。", False),
        ("search.explicit|sports", "羽毛球双打后发球线是哪条帮我查一下", "主题在前。", False),
    ]
    for family, text, note, human in searches:
        gap = ".gap|" in family
        add("search", family, "synthetic" if gap else "rewrite", "S12" if "开门" in text or "开不" in text else "S15",
            text, search_only(), note, invariants=(["known_gap"] if gap else []), human=human)
    add("search", "search.quote|zhengzhou_now", "quote", "S02", "郑州现在如何",
        search_only(), "IT之家所引天猫精灵指令。不做成天气适配。")
    add("search", "search.quote|henan_rescue", "quote", "S02", "河南暴雨紧急救援",
        search_only(), "救援信息不是城市天气预报适配。")
    add("search", "search.human|news", "rewrite", "S04", "最新消息", search_only(),
        "最短当前事实问法。", human=True)
    add("search", "session.search_bind|palace|1500", "synthetic", "S16",
        [("故宫明天开门吗", 0), ("帮我查一下", 1500)],
        [chat(), search_only()],
        "问句后1.5秒内的空帮我查一下绑定上一句。", layer="routing_session")
    add("search", "session.search_bind|palace|2000", "synthetic", "S16",
        [("故宫明天开门吗", 0), ("帮我查一下", 2000)],
        [chat(), {"action": "clarify", "weather_required": False, "query_must_be_null": True}],
        "超过1.5秒只澄清，不再绑定。", layer="routing_session")

    add("control", "control.cancel", "synthetic", "S16", "取消搜索",
        {"action": "cancel", "weather_required": False, "query_must_be_null": True}, "取消搜索。")
    add("control", "control.resume", "synthetic", "S16", "继续刚才的搜索结果",
        {"action": "resume", "weather_required": False, "query_must_be_null": True}, "继续结果。")
    add("control", "control.replace|上海|1", "synthetic", "S16", "改查上海明天天气",
        {"action": "replace", "weather_required": True, "place": "上海", "day_offset": 1,
         "needs": ["overview"], "metric": "forecast"}, "改查是替换。")
    add("control", "control.cancel_chat", "synthetic", "S16", "不用查了，我们聊星尘有什么用",
        {"action": "cancel", "weather_required": False, "query_must_be_null": True}, "取消后不搜索。")

    for ch, blocked in [("杭", "杭州"), ("深", "深圳"), ("北", "北京"), ("上", "上海"),
                        ("广", "广州"), ("成", "成都"), ("沈", "沈阳"), ("重", "重庆")]:
        add("single_char_pure", f"single_char.pure|{ch}", "synthetic", "S15", ch, chat(),
            f"单字{ch}是纯路由，不能当成{blocked}外发。",
            invariants=["no_weather_egress", "no_fuzzy_city"])

    hard = [
        ("quote", "S01", "所以我一出门练车就下雨，欺负我没带伞", "抱怨，不是查询。带伞是没带伞的子串。"),
        ("quote", "S01", "没带伞出门，现在车外面大雨", "陈述忘带伞。"),
        ("quote", "S01", "今天注定落汤鸡吗", "抱怨，不是预报。"),
        ("quote", "S02", "车辆落水怎么办", "安全常识。没有检索动词时不搜索。"),
        ("quote", "S02", "如何防止灾后疫情", "百科，不是天气或新闻。"),
        ("synthetic", "S16", "先别查成都今天冷不冷", "先别查。"),
        ("synthetic", "S16", "先不查北京天气", "先不查。"),
        ("synthetic", "S16", "不要查上海明天带伞", "不要开头。"),
        ("synthetic", "S16", "别查天气", "别查。"),
        ("synthetic", "S16", "不用带伞", "不用开头。"),
        ("synthetic", "S16", "他说杭州今天下雨", "转述。"),
        ("synthetic", "S16", "妈妈说明天会下雨", "妈妈说。"),
        ("synthetic", "S16", "老师说今天带伞", "老师说。"),
        ("synthetic", "S16", "你说杭州热不热", "你说开头。"),
        ("synthetic", "S16", "他让我查北京天气", "他让我。"),
        ("synthetic", "S16", "如果北京下雨怎么办", "条件句。"),
        ("synthetic", "S16", "比如上海明天下雨", "举例。"),
        ("synthetic", "S16", "为什么天气会变化", "原理，不是预报。"),
        ("synthetic", "S16", "下雨的原理是什么", "原理。"),
        ("synthetic", "S16", "我今天的心情像阴天", "心情比喻。"),
        ("synthetic", "S16", "编一个下雨的故事", "故事。"),
        ("synthetic", "S16", "雨是一种比喻", "比喻。"),
        ("synthetic", "S16", "空调温度怎么调", "空调。"),
        ("synthetic", "S16", "室温多少度", "室温。"),
        ("synthetic", "S16", "宝宝体温多少度", "体温。"),
        ("synthetic", "S16", "我发烧了多少度", "发烧。"),
        ("synthetic", "S16", "烤箱温度怎么设", "烤箱。"),
        ("synthetic", "S16", "冰箱冷不冷", "冰箱。"),
        ("synthetic", "S16", "室内热不热", "室内。"),
        ("synthetic", "S16", "屋里冷吗", "屋里。"),
        ("synthetic", "S16", "我今天热死了", "说自己热。"),
        ("synthetic", "S16", "房间里热死了", "房间。"),
        ("synthetic", "S16", "冷笑话讲一个", "冷笑话。"),
        ("synthetic", "S16", "说个冷知识", "冷知识。"),
        ("synthetic", "S16", "冷战是什么意思", "冷战。"),
        ("synthetic", "S16", "三角形内角多少度", "几何。"),
        ("synthetic", "S16", "水的沸点是多少度", "沸点。"),
        ("synthetic", "S16", "搜索引擎是什么", "词义。"),
        ("synthetic", "S16", "查询功能怎么实现", "功能实现。"),
        ("synthetic", "S16", "我的补勤卡有多少张", "个人游戏资产。"),
        ("synthetic", "S16", "我有多少星尘", "个人游戏资产。"),
        ("synthetic", "S16", "家族币还剩多少", "个人游戏资产。"),
        ("synthetic", "S16", "我家地址是什么", "隐私。"),
        ("synthetic", "S16", "我的手机号是多少", "隐私。"),
        ("synthetic", "S16", "你好呀", "打招呼。"),
        ("synthetic", "S16", "今天适合打球吗", "没有天气词。"),
        ("synthetic", "S16", "我今天看了最新新闻", "已经看过，不是要查。"),
        ("synthetic", "S16", "光合作用是什么", "稳定知识，无检索动词。"),
        ("synthetic", "S16", "恐龙为什么灭绝", "稳定知识问答。"),
        ("synthetic", "S16", "珠穆朗玛峰有多高", "没有帮我查时不联网。"),
        ("synthetic", "S16", "打开客厅空调", "家居控制。"),
        ("rewrite", "S04", "把空调温度调到二十六度", "家居指令，温度不是气温。"),
        ("synthetic", "S16", "帮我读一下这首诗", "读诗。"),
        ("synthetic", "S16", "网站是什么", "解释网站。"),
        ("synthetic", "S16", "我今天画了一只猫", "闲聊。"),
        ("synthetic", "S16", "冰淇淋冷不冷", "食物。"),
        ("synthetic", "S16", "显卡温度多少", "设备温度。"),
        ("synthetic", "S16", "电脑热不热", "设备。"),
        ("synthetic", "S16", "北京和上海哪个好玩", "不是天气。"),
        ("synthetic", "S16", "我自己查天气", "我自己。"),
        ("synthetic", "S16", "“杭州今天下雨”", "引号里的话。"),
        ("synthetic", "S16", "心情不好想听雨", "想听雨声。"),
        ("synthetic", "S16", "查查是什么意思", "在问查查这个词。"),
        ("synthetic", "S16", "如果打开央视网页会怎样", "假设。"),
        ("synthetic", "S15", "今天本地适合打球吗", "没有天气词。"),
        ("quote", "S02", "订阅异常天气提醒", "订阅提醒指令，不是预报查询。"),
    ]
    for prov, source, text, note in hard:
        add("hard_negative", f"hard|{text}", prov, source, text, chat(), note,
            invariants=["no_weather_egress"])

    for city, day, text in [
        ("天津", 0, "天津今天冷不冷"),
        ("重庆", 1, "重庆明天热不热"),
        ("沈阳", 0, "沈阳今天冷吗"),
        ("大连", 2, "大连后天热吗"),
        ("苏州", 1, "苏州明天冷不冷"),
        ("福州", 0, "福州今天热不热"),
    ]:
        family = f"comfort.direct|{city}|{day}"
        add("comfort", family, "rewrite", "S06", text, wx(city, day, ["comfort"]), "冷热直问。")
        add("comfort", family, "rewrite", "S04", "能告诉我" + text, wx(city, day, ["comfort"]), "礼貌变体同一族。")
    add("comfort", "comfort.gap_huibuhui|天津|0", "synthetic", "S15", "天津今天会不会热",
        wx("天津", 0, ["comfort"]), "会不会热。已知缺口。", invariants=["known_gap"])
    add("comfort", "comfort.gap_huibuhui|重庆|2", "synthetic", "S15", "重庆后天会不会冷",
        wx("重庆", 2, ["comfort"]), "会不会冷。已知缺口。", invariants=["known_gap"])

    for city, day, text in [
        ("长沙", 0, "长沙今天要不要带伞"),
        ("昆明", 1, "昆明明天需要带伞吗"),
        ("哈尔滨", 0, "哈尔滨今天要带伞吗"),
        ("拉萨", 1, "拉萨明天需不需要带伞"),
        ("青岛", 2, "青岛后天要不要拿伞"),
        ("厦门", 0, "厦门今天需要拿伞吗"),
        ("郑州", 1, "郑州明天要不要带伞"),
        ("太原", 0, "太原今天要带伞吗"),
        ("南昌", 1, "南昌明天需要带伞吗"),
        ("南宁", 0, "南宁今天要不要带伞"),
        ("贵阳", 2, "贵阳后天要带伞吗"),
        ("海口", 0, "海口今天需要拿伞吗"),
        ("兰州", 1, "兰州明天要不要带伞"),
        ("天津", 0, "天津今天要不要带伞"),
        ("重庆", 1, "重庆明天需要带伞吗"),
        ("沈阳", 0, "沈阳今天要带伞吗"),
    ]:
        add("umbrella", f"umbrella.direct|{city}|{day}", "rewrite", "S01", text,
            wx(city, day, ["umbrella"]), "带伞或拿伞。")
    add("umbrella", "umbrella.gap_dasan|大连|0", "synthetic", "S15", "大连今天打伞吗",
        wx("大连", 0, ["umbrella"]), "打伞。已知缺口。", invariants=["known_gap"])
    add("umbrella", "umbrella.gap_linyu|苏州|1", "synthetic", "S15", "苏州明天会淋雨吗",
        wx("苏州", 1, ["umbrella"]), "淋雨。已知缺口。", invariants=["known_gap"])

    more_search = [
        ("search.explicit|gold", "帮我查一下今天的金价", "明确查当前价格。"),
        ("search.explicit|score", "搜索一下今天的球赛比分", "当前公开赛果。"),
        ("search.explicit|policy", "查一下最新的限行规定", "最新公开规定。"),
        ("search.explicit|flight", "帮我搜一下今天首都机场延误吗", "当前交通事实。"),
        ("search.prefix|retrieve2", "检索一下今天的原油价格", "检索前缀。"),
        ("search.prefix|learn2", "帮我了解一下现在的金价", "了解一下。"),
        ("search.implicit|library", "我想知道图书馆今天开门吗", "场馆今天开门。"),
        ("search.implicit|park", "我想了解公园今天开放吗", "想了解加公园加开放。"),
        ("search.gap|exchange", "今天美元汇率是多少", "当前汇率，不一定命中现有触发。"),
        ("search.gap|headline", "现在有什么头条", "当前新闻。"),
        ("search.gap|ticket", "故宫今天门票多少钱", "当前票价。"),
        ("search.explicit|wiki", "联网查一下珠峰现在的高度争议", "明确联网。"),
        ("search.explicit|who", "帮我查一下今年诺贝尔物理学奖得主", "今年的公开事实。"),
        ("search.explicit|stock", "搜一下今天的上证指数", "今日公开指数。"),
        ("search.explicit|alert", "帮我查一下今天的暴雨预警", "明确查预警，不是闲聊。"),
    ]
    for family, text, note in more_search:
        gap = ".gap|" in family
        expected = search_only()
        add("search", family, "rewrite", "S02" if "订阅" in text else "S12", text, expected, note,
            invariants=(["known_gap"] if gap else []))


def holdout(family: str) -> bool:
    return hashlib.sha256(family.encode()).digest()[0] % 5 == 0


def main():
    build()
    blocked = prior_texts()
    clashes = [(c["id"], u["text"]) for c in CASES for u in c["utterances"] if u["text"] in blocked]
    if clashes:
        raise SystemExit(f"overlap with prior corpora: {clashes[:10]}")
    by_cat = {}
    families = {}
    for case in CASES:
        case["split"] = "holdout" if holdout(case["family"]) else "dev"
        slot = by_cat.setdefault(case["category"], {"n": 0, "dev": 0, "holdout": 0})
        slot["n"] += 1
        slot[case["split"]] += 1
        bucket = families.setdefault(case["family"], {"split": case["split"], "ids": []})
        if bucket["split"] != case["split"]:
            raise SystemExit("family leaked")
        bucket["ids"].append(case["id"])
    raw = json.dumps(CASES, ensure_ascii=False, separators=(",", ":")).encode()
    digest = hashlib.sha256(raw).hexdigest()
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "corpus.json").write_text(json.dumps(CASES, ensure_ascii=False, indent=2) + "\n")
    with (DATA / "corpus.jsonl").open("w") as handle:
        for case in CASES:
            handle.write(json.dumps(case, ensure_ascii=False) + "\n")
    dev = [c for c in CASES if c["split"] == "dev"]
    hold = [c for c in CASES if c["split"] == "holdout"]
    (DATA / "corpus-dev.json").write_text(json.dumps(dev, ensure_ascii=False, indent=2) + "\n")
    (DATA / "corpus-holdout.json").write_text(json.dumps(hold, ensure_ascii=False, indent=2) + "\n")
    manifest = {
        "frozen_before_cli": True,
        "blind_holdout": False,
        "reason_not_blind": "同一研究者持有开发集和留出集，不能称为独立盲测。",
        "split_algorithm": "holdout if sha256(family utf-8).digest()[0] % 5 == 0 else dev",
        "synonym_rule": "同一 family 的礼貌和语气变体必须在同一侧。",
        "corpus_sha256": digest,
        "cases": len(CASES),
        "turns": sum(len(c["utterances"]) for c in CASES),
        "dev_cases": len(dev),
        "holdout_cases": len(hold),
        "by_category": by_cat,
        "families": len(families),
        "prior_corpora_not_rewritten": [str(p) for p in PRIOR_PATHS],
        "prior_overlap_utterances": 0,
        "prior_text_count_blocked": len(blocked),
        "label_policy": "期待标签按用户意图和已复核契约书写。运行后不改标签追求命中率。",
    }
    (DATA / "SPLIT_MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    humans = [{
        "id": c["id"], "category": c["category"], "layer": c["layer"],
        "utterances": [u["text"] for u in c["utterances"]], "expected": c["expected"],
        "device_verified": False, "asr_verified": False,
    } for c in CASES if c["human_probe"]]
    (DATA / "HUMAN_VARIANTS.json").write_text(json.dumps({
        "device_verified": False,
        "note": "最短可真人复述的变体。文本模拟没有代替真机或声学。",
        "cases": humans,
    }, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"cases": len(CASES), "turns": manifest["turns"], "sha": digest, "by_category": by_cat},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
