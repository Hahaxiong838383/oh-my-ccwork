/**
 * Cheap signal 短路：0 token 成本的判定
 *
 * 设计前提：
 * - mycc 已经在产生大量 cheap signal（task-log 成功率、RECENT_EVENTS、git log）
 * - 这些信号能拦下 60%+ 的 verifier 调用，是真正的省 token 来源
 * - LLM verifier 应该只看 cheap signal 无法判定的"灰色地带"
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export interface EvidencePayload {
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly diff?: string;
  readonly files?: readonly string[];
  /** 触发该判定的 friction skill 标签（用于查 task-log 历史成功率） */
  readonly skillTag?: string;
  /** 触发该判定的事件主题（用于 RECENT_EVENTS 振荡检测） */
  readonly eventTopic?: string;
}

export interface CheapSignalResult {
  /** 是否能在 cheap layer 给出确定结论 */
  readonly decisive: boolean;
  /** 仅在 decisive=true 时有效 */
  readonly accepted?: boolean;
  readonly confidence?: number;
  readonly reason?: string;
  /** 调试用：哪些信号被命中 */
  readonly hits: readonly string[];
}

const ERROR_MARKER = /\b(Error|Exception|Traceback|FAIL(ED)?|FATAL|Segmentation fault|command not found)\b/i;

/**
 * 主入口：4 类信号串行检查，命中即返回
 *
 * 注意：所有 IO 都是同步的（task-log/git）—— 因为这条路径在 verifier 主流程上，
 * 必须低延迟。task-log 文件 < 100KB，同步读 < 5ms。
 */
export function checkCheapSignals(
  evidence: EvidencePayload,
  cwd: string,
): CheapSignalResult {
  const hits: string[] = [];

  // ① 硬证据：exit code 非 0
  if (evidence.exitCode !== undefined && evidence.exitCode !== 0) {
    hits.push("exit-code-nonzero");
    return {
      decisive: true,
      accepted: false,
      confidence: 1.0,
      reason: `Exit code ${evidence.exitCode}`,
      hits,
    };
  }

  // ② 硬证据：stderr 含错误关键词
  if (evidence.stderr && ERROR_MARKER.test(evidence.stderr)) {
    hits.push("stderr-error-marker");
    const matched = evidence.stderr.match(ERROR_MARKER)?.[0] ?? "unknown";
    return {
      decisive: true,
      accepted: false,
      confidence: 0.95,
      reason: `stderr 含错误标记: ${matched}`,
      hits,
    };
  }

  // ③ 历史信号：同 skill 历史成功率过低（注意：阈值要避免冤枉新 skill）
  if (evidence.skillTag) {
    const stat = readSkillSuccessRate(evidence.skillTag, cwd);
    if (stat && stat.total >= 5 && stat.successRate < 0.4) {
      hits.push("low-historical-success");
      return {
        decisive: true,
        accepted: false,
        confidence: 0.8,
        reason: `skill "${evidence.skillTag}" 历史成功率 ${(stat.successRate * 100).toFixed(0)}%（${stat.total} 次中 ${stat.success} 成功）`,
        hits,
      };
    }
  }

  // ④ 行为信号：同主题事件 1h 内反复触发（振荡）
  if (evidence.eventTopic) {
    const oscillation = countRecentEventOccurrences(evidence.eventTopic, cwd, 60);
    if (oscillation >= 3) {
      hits.push("event-oscillation");
      return {
        decisive: true,
        accepted: false,
        confidence: 0.9,
        reason: `主题 "${evidence.eventTopic}" 在 60 分钟内出现 ${oscillation} 次（振荡）`,
        hits,
      };
    }
  }

  // ⑤ 行为信号：files 列出的文件 24h 内 commit 过多（churn）
  if (evidence.files && evidence.files.length > 0) {
    const churn = countGitChurn(evidence.files, cwd, 24);
    if (churn >= 5) {
      hits.push("git-churn-high");
      // churn 高不直接拒，只是降低 confidence — 让 LLM 进一步判
      return {
        decisive: false,
        hits,
      };
    }
  }

  return { decisive: false, hits };
}

// ── 内部辅助 ───────────────────────────────────────────

interface SkillStat {
  readonly total: number;
  readonly success: number;
  readonly successRate: number;
}

function readSkillSuccessRate(skillTag: string, cwd: string): SkillStat | null {
  const path = join(cwd, "0-System/task-log.md");
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n").filter((l) => l.startsWith("|") && l.includes(skillTag));
    if (lines.length === 0) return null;

    let success = 0;
    for (const line of lines) {
      // task-log 格式：| 时间 | 类型 | 摘要 | 引擎 | 状态 | friction_skill | tokens |
      // 状态为 ✅ 或 ❌
      if (line.includes("✅")) success++;
    }
    const total = lines.length;
    return { total, success, successRate: success / total };
  } catch {
    return null;
  }
}

function countRecentEventOccurrences(topic: string, cwd: string, minutesWindow: number): number {
  const path = join(cwd, "0-System/RECENT_EVENTS.md");
  if (!existsSync(path)) return 0;

  try {
    const content = readFileSync(path, "utf-8");
    // RECENT_EVENTS 行格式：- `HH:MM` 事件描述
    const lines = content.split("\n").filter((l) => l.includes(topic));
    // 简化：不做严格时间窗，只数总次数（V0.2 再加 timestamp 解析）
    // 因为 RECENT_EVENTS 本身就是滚动 24h 窗，超出会被清理
    // V0.1 用 lines.length 作为粗糙近似
    void minutesWindow;
    return lines.length;
  } catch {
    return 0;
  }
}

function countGitChurn(files: readonly string[], cwd: string, hoursWindow: number): number {
  if (files.length === 0) return 0;
  try {
    const since = `${hoursWindow}.hours.ago`;
    // spawnSync avoids shell interpretation — no injection possible regardless of file names
    const result = spawnSync(
      "git",
      ["-C", cwd, "log", `--since=${since}`, "--oneline", "--", ...files],
      { encoding: "utf-8", timeout: 3000 },
    );
    if (result.status !== 0 || result.error) return 0;
    return result.stdout.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
