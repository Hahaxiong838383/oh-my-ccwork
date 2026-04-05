/**
 * user-state.ts — GAP4+GAP5: 情感标注 + 会话级用户状态推断
 *
 * GAP4: 基于规则的 valence/arousal 标注（零延迟，不调 LLM）
 * GAP5: 会话级 intent/mood/expertise 推断（每次请求更新）
 *
 * 设计原则：
 * - 纯规则驱动，不引入额外 LLM 调用（避免延迟和成本）
 * - 状态可序列化为 JSON，可注入 system prompt
 * - 向后兼容：旧的 experience JSONL 无 valence/arousal 字段也能正常解析
 */

// ─── GAP4: 情感标注（规则驱动） ───

interface ValenceArousal {
  readonly valence: number;   // [-1, 1]
  readonly arousal: number;   // [0, 1]
}

const NEGATIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; valence: number; arousal: number }> = [
  { pattern: /报错|错误|失败|挂了|崩了|不行|bug|error|fail|crash/i, valence: -0.6, arousal: 0.7 },
  { pattern: /烦|无语|搞不定|浪费时间|又来/i, valence: -0.7, arousal: 0.6 },
  { pattern: /紧急|急|赶紧|马上|立刻|asap|urgent/i, valence: -0.3, arousal: 0.9 },
  { pattern: /不懂|搞不清|迷糊|confused/i, valence: -0.2, arousal: 0.3 },
];

const POSITIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; valence: number; arousal: number }> = [
  { pattern: /不错|好的|可以|行|nice|great|perfect|完美/i, valence: 0.6, arousal: 0.3 },
  { pattern: /太棒了|牛|厉害|awesome|excellent/i, valence: 0.9, arousal: 0.7 },
  { pattern: /谢谢|感谢|thanks|thx/i, valence: 0.5, arousal: 0.2 },
  { pattern: /有意思|好玩|cool|interesting/i, valence: 0.7, arousal: 0.5 },
];

/** 基于规则标注 valence/arousal，零延迟 */
export function inferValenceArousal(query: string): ValenceArousal {
  let totalValence = 0;
  let totalArousal = 0;
  let matchCount = 0;

  for (const { pattern, valence, arousal } of NEGATIVE_PATTERNS) {
    if (pattern.test(query)) {
      totalValence += valence;
      totalArousal += arousal;
      matchCount++;
    }
  }

  for (const { pattern, valence, arousal } of POSITIVE_PATTERNS) {
    if (pattern.test(query)) {
      totalValence += valence;
      totalArousal += arousal;
      matchCount++;
    }
  }

  if (matchCount === 0) {
    return { valence: 0, arousal: 0.3 }; // 中性默认
  }

  return {
    valence: Math.max(-1, Math.min(1, totalValence / matchCount)),
    arousal: Math.max(0, Math.min(1, totalArousal / matchCount)),
  };
}

// ─── GAP5: 会话级用户状态推断 ───

export type UserIntent =
  | "debug"       // 排错/修复
  | "build"       // 构建/实现功能
  | "learn"       // 学习/了解
  | "manage"      // 管理/运维
  | "chat"        // 闲聊/探讨
  | "unknown";

export type UserMood =
  | "frustrated"  // 受挫
  | "focused"     // 专注
  | "curious"     // 好奇
  | "relaxed"     // 放松
  | "urgent"      // 紧急
  | "neutral";

export type ExpertiseLevel =
  | "expert"      // 精通该领域
  | "familiar"    // 有经验
  | "learning"    // 正在学习
  | "unknown";

export interface UserState {
  readonly intent: UserIntent;
  readonly mood: UserMood;
  readonly expertise: ExpertiseLevel;
  readonly confidence: number;  // [0, 1] 推断置信度
  readonly updatedAt: string;   // ISO timestamp
}

const INTENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; intent: UserIntent }> = [
  { pattern: /报错|error|bug|修复|fix|调试|debug|排查|不工作|挂了|失败|crash/i, intent: "debug" },
  { pattern: /创建|实现|开发|写|build|implement|add|新增|搭建|部署/i, intent: "build" },
  { pattern: /什么是|怎么|为什么|解释|说说|了解|学习|区别|原理/i, intent: "learn" },
  { pattern: /启动|停止|重启|状态|检查|配置|更新|升级|迁移|备份/i, intent: "manage" },
  { pattern: /聊聊|想想|讨论|你觉得|有没有|建议|推荐/i, intent: "chat" },
];

const EXPERTISE_SIGNALS: ReadonlyArray<{ pattern: RegExp; level: ExpertiseLevel }> = [
  { pattern: /帮我|怎么弄|不会|教我|step by step/i, level: "learning" },
  { pattern: /我试过|之前用过|一般来说|按照惯例/i, level: "familiar" },
  { pattern: /优化|重构|架构|性能|并发|scale|trade-off/i, level: "expert" },
];

function inferIntent(query: string): { intent: UserIntent; confidence: number } {
  for (const { pattern, intent } of INTENT_PATTERNS) {
    if (pattern.test(query)) {
      return { intent, confidence: 0.7 };
    }
  }
  return { intent: "unknown", confidence: 0.3 };
}

function inferMood(va: ValenceArousal): UserMood {
  if (va.valence < -0.4 && va.arousal > 0.5) return "frustrated";
  if (va.arousal > 0.7) return "urgent";
  if (va.valence > 0.3 && va.arousal > 0.4) return "curious";
  if (va.valence > 0.2 && va.arousal < 0.4) return "relaxed";
  if (va.arousal > 0.3) return "focused";
  return "neutral";
}

function inferExpertise(query: string): ExpertiseLevel {
  for (const { pattern, level } of EXPERTISE_SIGNALS) {
    if (pattern.test(query)) return level;
  }
  return "unknown";
}

/** 从单条 query 推断完整用户状态 */
export function inferUserState(query: string): UserState {
  const va = inferValenceArousal(query);
  const { intent, confidence } = inferIntent(query);
  const mood = inferMood(va);
  const expertise = inferExpertise(query);

  return {
    intent,
    mood,
    expertise,
    confidence,
    updatedAt: new Date().toISOString(),
  };
}

// ─── 会话级状态聚合 ───

interface SessionStateAccumulator {
  states: UserState[];
  dominantIntent: UserIntent;
  averageMood: UserMood;
  inferredExpertise: ExpertiseLevel;
}

const SESSION_STATE_MAX = 20; // 最多保留最近 20 次状态

const _sessionStates = new Map<string, SessionStateAccumulator>();

/** 更新会话级状态（每次请求调用） */
export function updateSessionState(conversationId: string, query: string): UserState {
  const state = inferUserState(query);

  const acc = _sessionStates.get(conversationId) ?? {
    states: [],
    dominantIntent: "unknown",
    averageMood: "neutral",
    inferredExpertise: "unknown",
  };

  // 追加新状态，保持窗口大小
  const updatedStates = [...acc.states, state].slice(-SESSION_STATE_MAX);

  // 聚合：intent 取最高频
  const intentCounts = new Map<UserIntent, number>();
  for (const s of updatedStates) {
    if (s.intent !== "unknown") {
      intentCounts.set(s.intent, (intentCounts.get(s.intent) ?? 0) + 1);
    }
  }
  let dominantIntent: UserIntent = "unknown";
  let maxCount = 0;
  for (const [intent, count] of intentCounts) {
    if (count > maxCount) { maxCount = count; dominantIntent = intent; }
  }

  // expertise 取最高级别
  const expertisePriority: Record<ExpertiseLevel, number> = {
    expert: 3, familiar: 2, learning: 1, unknown: 0,
  };
  let bestExpertise: ExpertiseLevel = "unknown";
  for (const s of updatedStates) {
    if (expertisePriority[s.expertise] > expertisePriority[bestExpertise]) {
      bestExpertise = s.expertise;
    }
  }

  const newAcc: SessionStateAccumulator = {
    states: updatedStates,
    dominantIntent,
    averageMood: state.mood, // 最新 mood 为主
    inferredExpertise: bestExpertise,
  };

  _sessionStates.set(conversationId, newAcc);
  return state;
}

/** 获取会话级聚合状态（注入 system prompt 用） */
export function getSessionState(conversationId: string): {
  readonly currentState: UserState | null;
  readonly dominantIntent: UserIntent;
  readonly inferredExpertise: ExpertiseLevel;
  readonly turnCount: number;
} | null {
  const acc = _sessionStates.get(conversationId);
  if (!acc || acc.states.length === 0) return null;

  return {
    currentState: acc.states[acc.states.length - 1],
    dominantIntent: acc.dominantIntent,
    inferredExpertise: acc.inferredExpertise,
    turnCount: acc.states.length,
  };
}

/** 清理过期会话状态 */
export function cleanupSessionStates(maxAgeMs: number = 30 * 60 * 1000): void {
  const now = Date.now();
  for (const [id, acc] of _sessionStates) {
    const lastState = acc.states[acc.states.length - 1];
    if (lastState && now - new Date(lastState.updatedAt).getTime() > maxAgeMs) {
      _sessionStates.delete(id);
    }
  }
}
