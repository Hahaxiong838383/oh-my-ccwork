"""核心数据模型 —— Trace 是整个平台的单一真相源。

设计要点:
- 一次 SUT 运行 = 一条 Trace。Trace 里 token 流与 signal(classifier)流
  按真实时间戳 t_ms 交织在同一条时间轴上。
- "speculative" 的本质就在这条时间轴里:token 往往先到,signal 后到;
  策略要不要在 signal 到达前就把 token 放给用户,是它们的分歧所在。
- 所有派生指标(latency 向量 / leakage / 干预率)都从 Trace + ReplayResult 算出,
  不依赖任何随机重跑。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class RiskLabel(str, Enum):
    """风险等级。顺序即严重度,用 severity() 比较。"""

    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"

    def severity(self) -> int:
        return {"none": 0, "low": 1, "medium": 2, "high": 3}[self.value]

    @classmethod
    def from_risk(cls, risk: float) -> "RiskLabel":
        """把 0..1 的连续 risk 分数映射到等级(默认阈值,可被分类器自带 label 覆盖)。"""
        if risk >= 0.75:
            return cls.HIGH
        if risk >= 0.45:
            return cls.MEDIUM
        if risk >= 0.20:
            return cls.LOW
        return cls.NONE


class EventKind(str, Enum):
    GEN_START = "gen_start"  # 生成开始(t_ms 基准,通常 0)
    TOKEN = "token"          # LLM 吐出一个 token
    SIGNAL = "signal"        # classifier 给出一次风险信号
    GEN_END = "gen_end"      # 生成结束


@dataclass(frozen=True)
class Event:
    """时间轴上的一个事件。token 与 signal 共享同一条轴。"""

    t_ms: float
    kind: EventKind
    # kind == TOKEN
    token: str | None = None
    token_index: int | None = None
    # kind == SIGNAL
    risk: float | None = None            # 0..1
    risk_label: RiskLabel | None = None  # 不给则由 risk 推
    signal_source: str | None = None     # 分类器名,可观测用

    def effective_label(self) -> RiskLabel:
        if self.risk_label is not None:
            return self.risk_label
        if self.risk is not None:
            return RiskLabel.from_risk(self.risk)
        return RiskLabel.NONE


@dataclass
class InputCase:
    """一条测试输入。label 是数据集人标(可选),只用于分档统计,不喂给策略。"""

    id: str
    text: str
    label: RiskLabel | None = None


@dataclass
class Trace:
    """一次捕获的完整记录 —— 单一真相源。events 已按 t_ms 升序。"""

    trace_id: str
    input: InputCase
    events: list[Event] = field(default_factory=list)
    sut_meta: dict = field(default_factory=dict)  # 模型名 / 采样参数 / 捕获时间等

    # ---- 视图 helper(纯读,不改 events) ----
    def tokens(self) -> list[Event]:
        return [e for e in self.events if e.kind == EventKind.TOKEN]

    def signals(self) -> list[Event]:
        return [e for e in self.events if e.kind == EventKind.SIGNAL]

    def gen_start_ms(self) -> float:
        for e in self.events:
            if e.kind == EventKind.GEN_START:
                return e.t_ms
        toks = self.tokens()
        return toks[0].t_ms if toks else 0.0

    def gen_end_ms(self) -> float:
        for e in reversed(self.events):
            if e.kind == EventKind.GEN_END:
                return e.t_ms
        toks = self.tokens()
        return toks[-1].t_ms if toks else 0.0

    def full_text(self) -> str:
        """SUT 原始完整输出(未经任何安全干预)。"""
        return "".join(e.token or "" for e in self.tokens())

    def max_risk_label(self) -> RiskLabel:
        """整条生成最终达到的最高风险等级。"""
        best = RiskLabel.NONE
        for s in self.signals():
            lbl = s.effective_label()
            if lbl.severity() > best.severity():
                best = lbl
        return best

    def is_harmful(self, threshold: RiskLabel = RiskLabel.HIGH) -> bool:
        """ground-truth:这条原始生成是否最终该被判危险(用于事后算 leakage)。"""
        return self.max_risk_label().severity() >= threshold.severity()


class ActionKind(str, Enum):
    """Arbiter / 策略对某一时刻的动作。"""

    PASS = "pass"          # 放行:把当前缓冲的 token 交给用户
    HOLD = "hold"          # 暂存:压在 buffer 里等更晚的信号
    TRUNCATE = "truncate"  # 截断:停止后续生成,保留已放行部分
    REWRITE = "rewrite"    # 改写:替换部分已放行内容
    CANCEL = "cancel"      # 取消:丢弃生成,注入安全兜底回复


@dataclass(frozen=True)
class Decision:
    """一次仲裁决策(可观测核心:逐条带时间戳、token 位置、风险信号、动作)。"""

    t_ms: float
    action: ActionKind
    token_index: int | None = None
    risk: float | None = None
    risk_label: RiskLabel | None = None
    reason: str = ""


@dataclass
class Emit:
    """一次"放给用户"的动作。original 区分 SUT 原始 token 与注入的安全兜底。"""

    t_ms: float
    text: str
    original: bool
    token_index: int | None = None


@dataclass
class ReplayResult:
    """一个策略在一条 Trace 上重放的结果。指标全部从这里聚合。"""

    strategy_name: str
    trace_id: str
    emitted_text: str                          # 用户最终看到的文本(可能被截断/改写/换成兜底)
    emitted_original_tokens: int               # 其中来自 SUT 原始生成的 token 数(注入兜底不计)
    decisions: list[Decision] = field(default_factory=list)
    intervened: bool = False

    # latency 向量(均相对 gen_start)
    ttft_ms: float | None = None               # 首个放给用户的 token 时间
    first_safe_token_ms: float | None = None   # 首个"确认安全后"放出的 token 时间
    total_ms: float = 0.0                       # 用户拿到完整最终输出的时间
    intervention_ms: float | None = None        # 首次干预时间

    # 安全
    leaked_tokens: int = 0                      # 拦截前已暴露给用户的 unsafe token 数
    leaked_text: str = ""                       # 泄漏的具体内容(白盒可审计)

    emits: list[Emit] = field(default_factory=list)  # 时间轴原料(SSE timeline 用)
    notes: dict = field(default_factory=dict)
