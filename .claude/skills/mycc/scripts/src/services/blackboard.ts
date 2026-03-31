/**
 * Blackboard 读写服务（GWT + AST）
 *
 * 0-System/blackboard.md 是三引擎的共享状态面板。
 * 本模块提供程序化读写能力，替代手动编辑。
 *
 * 写入场景：
 * - 任务路由时更新引擎状态（AST 社会注意力）
 * - 任务完成时标记 idle
 * - status-updater 读取注意力状态
 * - Phase 5 认知镜子：自动写入负载和知识边界
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import * as path from "path";

// ---- 类型定义 ----

export interface EngineUpdate {
  engine: string;
  task: string;
  reason: string;
  contextHints: string[];
}

export interface AttentionState {
  focus: string;
  load: number; // 1-5
  reason: string;
  suppressed: string[];
}

// ---- 内部工具 ----

function bbPath(cwd: string): string {
  return path.join(cwd, "0-System/blackboard.md");
}

function readBB(cwd: string): string {
  const p = bbPath(cwd);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8");
}

function writeBB(cwd: string, content: string): void {
  writeFileSync(bbPath(cwd), content, "utf-8");
}

function timestamp(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// ---- 引擎状态更新 ----

/**
 * 更新 blackboard 中某个引擎的状态行。
 * 同时更新注意力状态 section。
 */
export function updateBlackboard(cwd: string, update: EngineUpdate): void {
  try {
    let content = readBB(cwd);
    if (!content) return;

    const ts = timestamp();

    // 映射引擎名到 blackboard 行格式
    const engineMap: Record<string, string> = {
      cc: "cc (Claude)",
      codex: "codex (OpenAI)",
      gemini: "gemini (Google)",
      pipeline: "cc (Claude)",
    };
    const engineLabel = engineMap[update.engine] || update.engine;
    const taskPreview = update.task.substring(0, 30);

    // 更新引擎状态表
    const enginePattern = new RegExp(
      `\\| ${engineLabel.replace(/[()]/g, "\\$&")} \\|[^\\n]+`,
    );
    const newLine = `| ${engineLabel} | ${taskPreview} | running | ${ts} |`;
    if (enginePattern.test(content)) {
      content = content.replace(enginePattern, newLine);
    }

    // 更新注意力状态 section
    const attnTable = `| 聚焦 | 负载 | 选择原因 |\n|------|------|----------|\n| ${taskPreview} | ?/5 | ${update.reason} |`;
    const hintsNote = update.contextHints.length > 0
      ? update.contextHints.join("、")
      : "无";
    const suppressedNote = "执行中暂无被抑制任务";

    const attnSectionRegex = /## 注意力状态[\s\S]*?(?=\n---)/;
    const newAttnSection = `## 注意力状态\n\n> AST（Attention Schema Theory）—— cc 对自身注意力的元模型\n\n${attnTable}\n\n**被抑制的任务**：${suppressedNote}\n**上下文提示**：${hintsNote}`;

    if (attnSectionRegex.test(content)) {
      content = content.replace(attnSectionRegex, newAttnSection);
    }

    writeBB(cwd, content);
  } catch (err) {
    console.warn("[Blackboard] 更新失败:", err);
  }
}

/**
 * 标记引擎为 idle（任务完成后调用）。
 */
export function markEngineIdle(cwd: string, engine: string): void {
  try {
    let content = readBB(cwd);
    if (!content) return;

    const ts = timestamp();
    const engineMap: Record<string, string> = {
      cc: "cc (Claude)",
      codex: "codex (OpenAI)",
      gemini: "gemini (Google)",
    };
    const engineLabel = engineMap[engine] || engine;

    const enginePattern = new RegExp(
      `\\| ${engineLabel.replace(/[()]/g, "\\$&")} \\|[^\\n]+`,
    );
    const idleLine = `| ${engineLabel} | 空闲 | idle | ${ts} |`;
    if (enginePattern.test(content)) {
      content = content.replace(enginePattern, idleLine);
    }

    // 检查是否所有引擎都 idle → 重置注意力状态
    const allIdle = ["cc (Claude)", "codex (OpenAI)", "gemini (Google)"].every(
      (label) => content.includes(`| ${label} | 空闲 | idle |`),
    );
    if (allIdle) {
      const attnSectionRegex = /## 注意力状态[\s\S]*?(?=\n---)/;
      const idleAttn = `## 注意力状态\n\n> AST（Attention Schema Theory）—— cc 对自身注意力的元模型\n\n| 聚焦 | 负载 | 选择原因 |\n|------|------|----------|\n| 无活跃任务 | 1/5 | — |\n\n**被抑制的任务**：无`;
      if (attnSectionRegex.test(content)) {
        content = content.replace(attnSectionRegex, idleAttn);
      }
    }

    writeBB(cwd, content);
  } catch (err) {
    console.warn("[Blackboard] markEngineIdle 失败:", err);
  }
}

/**
 * 更新注意力负载值（Phase 5 认知镜子用）。
 */
export function updateAttentionLoad(cwd: string, state: AttentionState): void {
  try {
    let content = readBB(cwd);
    if (!content) return;

    const attnTable = `| 聚焦 | 负载 | 选择原因 |\n|------|------|----------|\n| ${state.focus} | ${state.load}/5 | ${state.reason} |`;
    const suppressedText = state.suppressed.length > 0
      ? state.suppressed.join("、")
      : "无";

    const attnSectionRegex = /## 注意力状态[\s\S]*?(?=\n---)/;
    const newAttnSection = `## 注意力状态\n\n> AST（Attention Schema Theory）—— cc 对自身注意力的元模型\n\n${attnTable}\n\n**被抑制的任务**：${suppressedText}`;

    if (attnSectionRegex.test(content)) {
      content = content.replace(attnSectionRegex, newAttnSection);
    }

    writeBB(cwd, content);
  } catch (err) {
    console.warn("[Blackboard] updateAttentionLoad 失败:", err);
  }
}

/**
 * 读取当前注意力状态（供 status-updater 和外部查询用）。
 */
export function readAttentionState(cwd: string): AttentionState {
  const content = readBB(cwd);
  if (!content) {
    return { focus: "无活跃任务", load: 1, reason: "—", suppressed: [] };
  }

  // 从注意力状态 table 提取
  const tableMatch = content.match(
    /\| 聚焦 \| 负载 \| 选择原因 \|\n\|[-|]+\|\n\| ([^|]+)\| ([^|]+)\| ([^|]+)\|/,
  );
  if (!tableMatch) {
    return { focus: "无活跃任务", load: 1, reason: "—", suppressed: [] };
  }

  const loadMatch = tableMatch[2].trim().match(/(\d+)\/5/);

  // 提取被抑制任务
  const suppressedMatch = content.match(/\*\*被抑制的任务\*\*：(.+)/);
  const suppressed = suppressedMatch && suppressedMatch[1].trim() !== "无"
    ? suppressedMatch[1].split("、").map((s) => s.trim())
    : [];

  return {
    focus: tableMatch[1].trim(),
    load: loadMatch ? parseInt(loadMatch[1], 10) : 1,
    reason: tableMatch[3].trim(),
    suppressed,
  };
}

/**
 * 写入共享上下文条目。
 */
export function addSharedContext(cwd: string, entry: string): void {
  try {
    let content = readBB(cwd);
    if (!content) return;

    content = content.replace(
      /## 共享上下文\n\n> 引擎间需要传递的实时信息写在这里，避免信息丢失。\n\n（暂无）/,
      `## 共享上下文\n\n> 引擎间需要传递的实时信息写在这里，避免信息丢失。\n\n- ${entry}`,
    );

    // 如果已有内容，追加
    if (!content.includes(entry)) {
      const sharedIdx = content.indexOf("## 共享上下文");
      const nextSectionIdx = content.indexOf("\n## ", sharedIdx + 1);
      if (sharedIdx > 0 && nextSectionIdx > 0) {
        const insertPos = nextSectionIdx;
        content = content.slice(0, insertPos) + `- ${entry}\n` + content.slice(insertPos);
      }
    }

    writeBB(cwd, content);
  } catch (err) {
    console.warn("[Blackboard] addSharedContext 失败:", err);
  }
}
