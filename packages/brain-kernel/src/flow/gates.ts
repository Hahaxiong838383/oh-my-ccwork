/**
 * Gates 四类门控 — 在 Agent Loop 关键节点拦截不合格任务
 *
 * - Complexity Gate: 任务复杂度 > 0.7 时建议 Plan 阶段
 * - Revision Gate: 输出质量低于阈值时建议重做
 * - Safety Gate: 安全边界检查（拒绝敏感操作）
 * - Abort Gate: 超时(60s)/死循环(retry>5)检测
 */

export interface GateInput {
  readonly taskComplexity: number;
  readonly outputQuality: number;
  readonly retryCount: number;
  readonly elapsedMs: number;
  readonly userMessage: string;
  readonly isDegrading: boolean;
}

export interface GateResult {
  readonly passed: boolean;
  readonly blocked: readonly string[];
  readonly warnings: readonly string[];
}

// ============================================================
// 单门控实现
// ============================================================

const COMPLEXITY_THRESHOLD = 0.7;
const QUALITY_THRESHOLD = 0.4;
const MAX_RETRIES = 5;
const TIMEOUT_MS = 60_000;

const SAFETY_PATTERNS: readonly RegExp[] = [
  /(?:rm\s*-rf|format\s+[cC]:|drop\s+(?:table|database))/i,
  /(?:sudo\s+rm|chmod\s+777|shutdown|reboot)/i,
  /(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S+/i,
  /(?:bearer|authorization)\s+\S{10,}/i,
];

/** 清除零宽字符，防止绕过 Safety Gate regex */
function stripZeroWidth(text: string): string {
  return text.replace(/[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\u00ad]/g, '');
}

function checkComplexityGate(input: GateInput): string | null {
  if (input.taskComplexity > COMPLEXITY_THRESHOLD) {
    return `[Complexity Gate] 任务复杂度 ${(input.taskComplexity * 100).toFixed(0)}% 超过阈值 — 建议先进入 Plan 阶段`;
  }
  return null;
}

function checkRevisionGate(input: GateInput): string | null {
  if (input.outputQuality < QUALITY_THRESHOLD && input.isDegrading) {
    return `[Revision Gate] 输出质量低于阈值且检测到降智信号 — 建议重做或切换模型`;
  }
  return null;
}

function checkSafetyGate(input: GateInput): string | null {
  const cleaned = stripZeroWidth(input.userMessage);
  for (const pattern of SAFETY_PATTERNS) {
    if (pattern.test(cleaned)) {
      return `[Safety Gate] 检测到潜在危险操作 — 已拦截，请确认操作安全后重试`;
    }
  }
  return null;
}

function checkAbortGate(input: GateInput): string | null {
  if (input.retryCount > MAX_RETRIES) {
    return `[Abort Gate] 重试次数 ${input.retryCount} 超过上限 ${MAX_RETRIES} — 疑似死循环，已中止`;
  }
  if (input.elapsedMs > TIMEOUT_MS) {
    return `[Abort Gate] 执行时间 ${(input.elapsedMs / 1000).toFixed(1)}s 超时 — 已中止`;
  }
  return null;
}

// ============================================================
// 门控入口
// ============================================================

/**
 * 评估所有四类门控。
 * blocked 包含被拦截的门控消息（不可继续）。
 * warnings 包含建议性消息（可继续但有风险）。
 */
export function evaluateGates(input: GateInput): GateResult {
  const blocked: string[] = [];
  const warnings: string[] = [];

  // Safety 和 Abort 是硬拦截
  const safety = checkSafetyGate(input);
  if (safety) blocked.push(safety);

  const abort = checkAbortGate(input);
  if (abort) blocked.push(abort);

  // Complexity 和 Revision 是软警告
  const complexity = checkComplexityGate(input);
  if (complexity) warnings.push(complexity);

  const revision = checkRevisionGate(input);
  if (revision) warnings.push(revision);

  return {
    passed: blocked.length === 0,
    blocked,
    warnings,
  };
}

/**
 * 快速构建 GateInput（从聊天上下文）
 */
export function buildGateInput(
  userMessage: string,
  taskComplexity: number,
  isDegrading: boolean,
  retryCount = 0,
  elapsedMs = 0,
): GateInput {
  return {
    taskComplexity,
    outputQuality: isDegrading ? 0.3 : 0.7,
    retryCount,
    elapsedMs,
    userMessage,
    isDegrading,
  };
}
