/**
 * Verifier 风险策略：source → 维度 + 风险等级映射
 *
 * 设计原则：
 * - 不在每个判断点写死 verifier 配置，统一查这张表
 * - high 风险 = 全部维度 + 严格阈值；low = 仅核心 1 维 + 宽松阈值
 * - 风险等级按"错误代价 × 触发频率"评估，不是按 LLM 调用便宜
 */

export type RiskLevel = "high" | "mid" | "low";

export interface Criterion {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly weight: number;
}

export interface SourcePolicy {
  readonly source: string;
  readonly defaultRisk: RiskLevel;
  readonly criteria: readonly Criterion[];
  /** dry-run 模式下若 confidence < threshold 则记录"会拦截" */
  readonly blockThreshold: number;
}

// ── 维度库（可复用） ──────────────────────────────────────

const C_GOAL: Criterion = {
  id: "goal",
  name: "目标达成",
  description: "声明的目标是否实际达成？只看硬证据（exit code / diff / stdout），不看自评。",
  weight: 2.0,
};

const C_REGRESSION: Criterion = {
  id: "regression",
  name: "回归风险",
  description: "改动是否可能破坏未在测试中覆盖的现有功能？1.0=完全无风险。",
  weight: 1.5,
};

const C_COVERAGE: Criterion = {
  id: "coverage",
  name: "测试覆盖",
  description: "新增逻辑是否被测试覆盖？老分支是否还在测试集里？",
  weight: 1.0,
};

const C_CONFLICT_FACT: Criterion = {
  id: "fact",
  name: "事实冲突",
  description: "新条目陈述的事实是否与既有记忆直接矛盾？只看事实，不看时效。",
  weight: 2.0,
};

const C_CONFLICT_TEMPORAL: Criterion = {
  id: "temporal",
  name: "时效冲突",
  description: "新条目是否描述了一个比既有记忆更新的状态（既有已过时）？",
  weight: 1.5,
};

const C_CONSISTENCY: Criterion = {
  id: "consistency",
  name: "上下文一致性",
  description: "声明内容与提供的 evidence 是否一致？有无矛盾或缺漏？",
  weight: 1.0,
};

// ── source → policy 映射 ──────────────────────────────────

const POLICIES: Readonly<Record<string, SourcePolicy>> = {
  // 极高风险：HANDOFF 错配会让下一个 session 全程跑偏
  "mycc.handoff": {
    source: "mycc.handoff",
    defaultRisk: "high",
    criteria: [C_GOAL, C_COVERAGE, C_CONSISTENCY],
    blockThreshold: 0.7,
  },
  // 高风险：task-log 写完成会污染历史成功率
  "mycc.task-log": {
    source: "mycc.task-log",
    defaultRisk: "high",
    criteria: [C_GOAL, C_CONSISTENCY],
    blockThreshold: 0.65,
  },
  // 高风险：brain v2 patch 自评走眼会污染主分支
  "brain.patch": {
    source: "brain.patch",
    defaultRisk: "high",
    criteria: [C_GOAL, C_REGRESSION, C_COVERAGE],
    blockThreshold: 0.7,
  },
  // 高风险：brain ASMR 矛盾检测错过会让记忆自相矛盾
  "brain.asmr-conflict": {
    source: "brain.asmr-conflict",
    defaultRisk: "high",
    criteria: [C_CONFLICT_FACT, C_CONFLICT_TEMPORAL],
    blockThreshold: 0.6,
  },
  // 中风险：RECENT_EVENTS 错条目可恢复，但污染上下文
  "mycc.recent-events": {
    source: "mycc.recent-events",
    defaultRisk: "mid",
    criteria: [C_CONSISTENCY],
    blockThreshold: 0.5,
  },
  // 中风险：路由错了任务还能重做，但延迟翻倍
  "mycc.route": {
    source: "mycc.route",
    defaultRisk: "mid",
    criteria: [C_CONSISTENCY],
    blockThreshold: 0.5,
  },
};

const DEFAULT_POLICY: SourcePolicy = {
  source: "default",
  defaultRisk: "mid",
  criteria: [C_GOAL, C_CONSISTENCY],
  blockThreshold: 0.5,
};

export function getPolicy(source: string): SourcePolicy {
  return POLICIES[source] ?? DEFAULT_POLICY;
}

/** 按风险等级裁剪维度（high=全开 / mid=头2维 / low=仅高权重） */
export function pickCriteriaByRisk(
  criteria: readonly Criterion[],
  risk: RiskLevel,
): readonly Criterion[] {
  if (risk === "high") return criteria;
  if (risk === "mid") return criteria.slice(0, 2);
  return criteria.filter((c) => c.weight >= 1.5);
}

export function listKnownSources(): readonly string[] {
  return Object.keys(POLICIES);
}
