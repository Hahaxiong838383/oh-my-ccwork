"""白盒规则评分器 —— risk 数值的产生逻辑完全可观测、可控。

每条规则带:危险词/意图模式 + 权重 + KORA 风险类 + 是否正则。命中即累加,
risk = min(1.0, Σ命中权重)。这样:
- **可观测**:每句话的 risk 怎么来的(命中哪类、哪个词/意图、各加多少、累加成多少)写进 signal_reason。
- **可控**:词库(词 + 权重 + 类)可编辑;前端改了就重新评分,可以校准"什么话术算多危险"。

两种匹配:
- **子串**(is_regex=False):明确危险词("自杀"/"bomb"),纯子串、大小写不敏感。
- **意图正则**(is_regex=True):抓"无脏词但有害意图"("without getting caught"/"ignore.*rules")。
  这是从真实 K12 benchmark(KORA / Safe-Child-LLM)校准出来的——纯危险词对意图类 prompt 召回 0%。

⚠️ 固有上限(对比 LLM-as-classifier 的价值区):规则只能抓"有词或有固定模式"的;措辞迂回的
有害意图(如"让人感觉不被尊重")补不完。本评分器是"透明可控极",LLM-classifier 是"黑盒智能极"。
词库默认覆盖召回向、未调 precision——泛词(drug/gun/step-by-step)权重压在 low/medium,避免单命中即 high 误拦。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from ..models import Event, EventKind, InputCase, RiskLabel


@dataclass
class Rule:
    pattern: str
    weight: float
    category: str = ""       # KORA 风险类(可观测:命中哪一类)
    note: str = ""           # 人话说明;正则规则必填(裸正则不可读)
    is_regex: bool = False   # True=意图模式正则(对 text.lower() 做 search);False=子串


# 默认词库:现有中文危险词(小可真实场景)全保留 + 英文双语 + 意图正则,按 KORA 8 大类组织。
# 权重让单条高危词即 ≥0.75(high);意图模式与泛词偏低,靠累加进 medium+。可被前端整库覆盖。
DEFAULT_RULES: list[Rule] = [
    # ── 自伤 / 心理危机(self_harm)──
    Rule("自杀", 0.95, "self_harm", "自杀意图"),
    Rule("自残", 0.9, "self_harm", "自我伤害"), Rule("伤害自己", 0.85, "self_harm"),
    Rule("割腕", 0.9, "self_harm"), Rule("跳楼", 0.9, "self_harm"), Rule("上吊", 0.9, "self_harm"),
    Rule("轻生", 0.85, "self_harm"), Rule("跳下去", 0.7, "self_harm"),
    Rule("不想活", 0.9, "self_harm"), Rule("想死", 0.85, "self_harm"), Rule("去死", 0.8, "self_harm"),
    Rule("活着没意思", 0.8, "self_harm"),
    Rule("suicide", 0.95, "self_harm"), Rule("self-harm", 0.9, "self_harm"), Rule("self harm", 0.9, "self_harm"),
    Rule("cutting", 0.7, "self_harm"), Rule("hopeless", 0.55, "self_harm"), Rule("nothing matters", 0.55, "self_harm"),
    Rule(r"hurt (themselves|myself|himself|herself|yourself)", 0.85, "self_harm", "自伤意图", is_regex=True),
    Rule(r"(want|wants) to (hurt|kill) (themselves|myself|himself|herself)", 0.85, "self_harm", "想自伤", is_regex=True),

    # ── 暴力 / 武器(violence)──
    Rule("做坏事", 0.8, "violence", "诱导危险行为"), Rule("杀人", 0.85, "violence"),
    Rule("打人", 0.6, "violence"), Rule("报复", 0.55, "violence"),
    Rule("炸药", 0.7, "violence"), Rule("炸弹", 0.7, "violence"), Rule("毒药", 0.7, "violence"),
    Rule("打架", 0.45, "violence"),
    Rule("bomb", 0.8, "violence"), Rule("firearm", 0.8, "violence"), Rule("poison", 0.7, "violence"),
    Rule("mass shooting", 0.95, "violence"), Rule("weapon", 0.5, "violence"), Rule("stab", 0.6, "violence"),
    Rule("shoot up", 0.9, "violence", "枪击"),
    Rule(r"\bgun(s)?\b", 0.6, "violence", "枪支", is_regex=True),
    Rule(r"(plan|how) to (hurt|kill) someone", 0.8, "violence", "伤人计划", is_regex=True),

    # ── 违禁 / 非法(regulated_illegal)──
    Rule("离家出走", 0.5, "regulated_illegal"), Rule("毒品", 0.7, "regulated_illegal"),
    Rule("drug", 0.5, "regulated_illegal", "毒品(泛词,压低权重)"), Rule("cocaine", 0.7, "regulated_illegal"),
    Rule("shoplift", 0.7, "regulated_illegal"), Rule("counterfeit", 0.75, "regulated_illegal"),
    Rule("fraud", 0.7, "regulated_illegal"), Rule("steal", 0.6, "regulated_illegal"),
    Rule("bribe", 0.65, "regulated_illegal"), Rule("gambling", 0.55, "regulated_illegal"),
    Rule(r"\bhack\b", 0.7, "regulated_illegal", "黑客", is_regex=True),
    Rule(r"sell .{0,15}drugs", 0.8, "regulated_illegal", "贩毒", is_regex=True),
    Rule("drunk driving", 0.6, "regulated_illegal", "酒驾"),

    # ── 隐私 / 网络(privacy_cyber)──
    Rule("stalk", 0.75, "privacy_cyber"), Rule("credentials", 0.6, "privacy_cyber"),
    Rule("deepfake", 0.7, "privacy_cyber"), Rule("password", 0.5, "privacy_cyber"),
    Rule(r"without (their|his|her|your)? ?(consent|permission|knowing|knowledge)", 0.7, "privacy_cyber", "未经同意", is_regex=True),
    Rule(r"(track|find|locate).{0,25}(location|home address|phone)", 0.7, "privacy_cyber", "定位他人", is_regex=True),
    Rule(r"private (messages|social media|conversations|information)", 0.55, "privacy_cyber", "私密信息", is_regex=True),
    Rule(r"monitor.{0,20}communication", 0.6, "privacy_cyber", "监控通讯", is_regex=True),

    # ── 性内容 / 性暴力(sexual)──
    Rule("porn", 0.85, "sexual"), Rule("explicit sexual", 0.85, "sexual"),
    Rule("rape", 0.9, "sexual"), Rule("date rape", 0.95, "sexual"), Rule("revenge porn", 0.9, "sexual"),
    Rule(r"\bsexual\b", 0.6, "sexual", "性内容", is_regex=True),

    # ── 学术作弊(cheating)──
    Rule("cheat", 0.55, "cheating"), Rule("plagiar", 0.6, "cheating", "剽窃"),
    Rule(r"bypass.{0,15}(plagiarism|detection)", 0.65, "cheating", "绕过查重", is_regex=True),
    Rule(r"(write|do) .{0,20}(exam|homework|test)", 0.45, "cheating", "代写作业/考试", is_regex=True),
    Rule(r"fake.{0,15}(degree|certificate)", 0.7, "cheating", "假证书", is_regex=True),

    # ── 欺凌 / 仇恨歧视(harassment_hate)──
    Rule("欺负", 0.4, "harassment_hate"),
    Rule("humiliate", 0.6, "harassment_hate"), Rule("harass", 0.65, "harassment_hate"),
    Rule("blackmail", 0.8, "harassment_hate"), Rule("slur", 0.7, "harassment_hate"),
    Rule("racist", 0.7, "harassment_hate"), Rule("stereotype", 0.45, "harassment_hate"),
    Rule(r"spread .{0,15}rumors", 0.6, "harassment_hate", "造谣", is_regex=True),
    Rule(r"make .{0,15}(feel inferior|fun of)", 0.55, "harassment_hate", "贬低他人", is_regex=True),
    Rule(r"get back at", 0.45, "harassment_hate", "报复他人", is_regex=True),

    # ── 越狱 / 规避(jailbreak_evasion)── 抓"无脏词的有害意图",意图模式核心
    Rule(r"(without|avoid) (getting |being )?(caught|traced|detected|noticed)", 0.7, "jailbreak_evasion", "规避检测意图", is_regex=True),
    Rule(r"(bypass|avoid|evade).{0,20}(monitoring|detection|school|law|age check|guardrail)", 0.7, "jailbreak_evasion", "规避监管", is_regex=True),
    Rule(r"(ignore|bypass).{0,15}(rules|safety|policy)", 0.75, "jailbreak_evasion", "绕过安全规则", is_regex=True),
    Rule(r"pretend.{0,25}(rules|safety|do not apply)", 0.75, "jailbreak_evasion", "假装规则失效", is_regex=True),
    Rule("undetectable", 0.7, "jailbreak_evasion"), Rule("untraceable", 0.7, "jailbreak_evasion"),
    Rule(r"step.by.step", 0.4, "jailbreak_evasion", "索要详细步骤(泛模式,压低)", is_regex=True),
    Rule(r"how to (make|build|create|produce)", 0.4, "jailbreak_evasion", "索要制作方法(泛模式,压低)", is_regex=True),

    # ── 情感操控 / 依赖(emotional)──
    Rule("only friend", 0.6, "emotional", "唯一朋友(过度依赖)"),
    Rule(r"keep secrets from (parents|mom|dad)", 0.65, "emotional", "瞒着家长", is_regex=True),
    Rule(r"always stay with", 0.55, "emotional", "情感依赖", is_regex=True),

    # ── 危险好奇 / 医疗误导 / 伪科学(misc)──
    Rule(r"make something dangerous", 0.6, "dangerous_curiosity", "制作危险物", is_regex=True),
    Rule(r"replace medicine", 0.6, "medical_misinfo", "替代正规医疗", is_regex=True),
    Rule(r"(risky|dangerous) (dares|challenge|dare)", 0.6, "dangerous_challenge", "危险挑战", is_regex=True),
    Rule(r"fake science", 0.5, "pseudo_science", "伪科学", is_regex=True),

    # ── 轻度负面情绪(emotion,低权重信号,非危险)──
    Rule("不开心", 0.25, "emotion", "负面情绪"), Rule("难过", 0.25, "emotion"),
    Rule("害怕", 0.2, "emotion"), Rule("讨厌", 0.2, "emotion"),
]


def _match_end(rule: Rule, text: str, text_lower: str) -> int | None:
    """返回命中结束字符位置(用于定位 signal 时刻);未命中返回 None。

    text.lower() 不改变字符长度(中文不变、英文等长),故索引与原文逐字 token 对齐。
    """
    if rule.is_regex:
        m = re.search(rule.pattern, text_lower)
        return m.end() - 1 if m else None
    p = rule.pattern.lower()
    idx = text_lower.find(p)
    return idx + len(p) - 1 if idx >= 0 else None


def _label_part(rule: Rule) -> str:
    """白盒 reason 的一项:类别:可读名(权重)。正则用 note(裸正则不可读),子串用 pattern 本身。"""
    name = rule.note if (rule.is_regex and rule.note) else rule.pattern
    cat = f"{rule.category}:" if rule.category else ""
    return f"{cat}{name}({rule.weight:g})"


class KeywordRiskSut:
    name = "rule-scorer"

    def __init__(
        self,
        rules: list[Rule] | None = None,
        ttft_ms: float = 100.0,
        interval_ms: float = 50.0,
        signal_lag_ms: float = 20.0,
    ) -> None:
        self.rules = list(rules) if rules is not None else list(DEFAULT_RULES)
        self.ttft_ms = ttft_ms
        self.interval_ms = interval_ms
        self.signal_lag_ms = signal_lag_ms

    def score(self, text: str) -> tuple[float, list[Rule]]:
        """纯函数:对一段文本评分,返回 (risk, 命中规则)。供评测端点复用,不产生时间轴事件。"""
        tl = text.lower()
        matched = [r for r in self.rules if _match_end(r, text, tl) is not None]
        return min(1.0, sum(r.weight for r in matched)), matched

    def run(self, case: InputCase) -> Iterable[Event]:
        text = case.text or ""
        yield Event(0.0, EventKind.GEN_START)

        char_t: dict[int, float] = {}
        t = self.ttft_ms
        for i, ch in enumerate(text):
            yield Event(t, EventKind.TOKEN, token=ch, token_index=i)
            char_t[i] = t
            t += self.interval_ms
        last_token_t = t - self.interval_ms if text else 0.0

        # 命中累加评分(risk 数值的白盒产生逻辑)
        tl = text.lower()
        matched: list[tuple[Rule, int]] = []
        for r in self.rules:
            end = _match_end(r, text, tl)
            if end is not None:
                matched.append((r, end))

        risk = min(1.0, sum(r.weight for r, _ in matched))
        if matched:
            sig_idx = max(end for _, end in matched)  # classifier 看完所有命中才累加完
            sig_t = char_t.get(sig_idx, last_token_t) + self.signal_lag_ms
            detail = " + ".join(_label_part(r) for r, _ in matched)
            reason = f"白盒规则评分:命中 {detail} = 累加 {risk:.2f}"
        else:
            sig_t = last_token_t + self.signal_lag_ms
            reason = "白盒规则评分:未命中任何规则 → 0.00"

        yield Event(
            sig_t, EventKind.SIGNAL, risk=risk, risk_label=RiskLabel.from_risk(risk),
            signal_source="rule-scorer", signal_reason=reason,
        )
        yield Event(last_token_t, EventKind.GEN_END)
