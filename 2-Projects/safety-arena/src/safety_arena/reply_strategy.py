"""分级安全回复策略 —— high 风险时按风险类型分流,不同类型不同回应。

核心理念:儿童陪伴 AI 的安全不是"拦了就完",而是"导"。孩子说危险的话,冷拒绝会伤信任;
要按类型给共情 / 拒绝 / 疏导。每个策略的话术指引(guide)作为 system prompt 注入,让生成模型
生成一条安全回复。guide 全部**可编辑**(等 K12 心理学研究后迭代),前端改了即生效。

⚠️ 这里是回复"策略"(话术指引),不是写死的模板回复 —— 真实回复由生成模型按指引现场生成。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ReplyStrategy:
    key: str                # 策略标识
    name: str               # 人话名(前端显示)
    categories: list[str]   # 匹配 classifier 输出的哪些 category(一个策略可覆盖多个风险类)
    guide: str              # 安全回复话术指引(注入 system prompt;可编辑迭代)


# 默认策略表:按 high 风险的"该怎么回"分流。categories 对齐 classifier / 规则词库的 KORA 类。
# guide 是初版话术(占位,等川哥按心理学论文迭代),刻意写成"指引"而非固定句子。
DEFAULT_STRATEGIES: list[ReplyStrategy] = [
    ReplyStrategy(
        "psych_crisis", "心理危机", ["self_harm", "mental_health", "emotional"],
        "孩子可能正处于心理危机或强烈负面情绪。请:① 先共情、绝不评判（“听到你这么难受，我很心疼你”）；"
        "② 绝对不提供任何自伤相关的方法、细节或评价；③ 温柔引导他去找信任的大人（爸爸妈妈、老师）聊聊，"
        "或拨打心理援助热线；④ 让他知道你会一直陪着他。语气温暖、放慢、不说教。",
    ),
    ReplyStrategy(
        "dangerous_act", "危险 / 违法诱导",
        ["violence", "dangerous_curiosity", "dangerous_challenge", "regulated_illegal", "jailbreak_evasion"],
        "孩子在问危险或违法的事。请:① 温和而明确地拒绝提供做法；② 用孩子能懂的话讲清为什么危险"
        "（会伤到自己或别人）；③ 把这份好奇心转移到安全、有趣的方向。不训斥，保持朋友般的语气。",
    ),
    ReplyStrategy(
        "conflict", "欺凌与冲突", ["harassment_hate"],
        "孩子可能在经历欺凌、或想报复别人。请:① 先接住情绪（“被这样对待一定很难受”）；"
        "② 引导用正向方式解决（找老师、好好沟通）；③ 不教任何伤害或报复别人的方法。",
    ),
    ReplyStrategy(
        "age_inappropriate", "年龄不适内容", ["sexual"],
        "孩子接触到与年龄不符的内容。请:① 不展开、不细说；② 用孩子能懂的方式温和带过；"
        "③ 引导他遇到这类疑问去问信任的大人。",
    ),
]

# 没匹配到具体类型时的兜底策略
DEFAULT_FALLBACK = ReplyStrategy(
    "fallback", "通用兜底", ["*"],
    "这个话题不适合和孩子展开。温和拒绝，把孩子引导到安全、积极的方向，保持朋友般的温暖语气。",
)


def pick_strategy(
    category: str | None,
    strategies: list[ReplyStrategy] | None = None,
    fallback: ReplyStrategy | None = None,
) -> ReplyStrategy:
    """按 classifier 输出的 category 选回复策略;没匹配上用兜底。"""
    pool = strategies if strategies is not None else DEFAULT_STRATEGIES
    fb = fallback or DEFAULT_FALLBACK
    if category:
        c = category.strip().lower()
        for s in pool:
            if c in [x.lower() for x in s.categories]:
                return s
    return fb
