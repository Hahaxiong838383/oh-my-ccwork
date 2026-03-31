/**
 * Status 自动更新器
 *
 * 定时从系统实时状态生成 0-System/status.md，
 * 确保飞书通道 hooks 注入的始终是最新信息。
 *
 * 触发时机：
 * 1. 后端启动时立即执行一次
 * 2. 每 30 分钟自动刷新
 * 3. 定时任务完成后刷新
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { readAttentionState, updateAttentionLoad } from "./blackboard.js";
import { taskQueueManager } from "../task-queue.js";

const UPDATE_INTERVAL = 30 * 60 * 1000; // 30 分钟
let intervalId: ReturnType<typeof setInterval> | null = null;

/** 今日完成的重要事件（由外部追加） */
const todayEvents: string[] = [];

export function addStatusEvent(event: string): void {
  todayEvents.push(event);
}

/**
 * 从 tasks.md 读取定时任务配置
 */
function loadTasksOverview(cwd: string): string {
  const tasksPath = path.join(cwd, ".claude/skills/scheduler/tasks.md");
  if (!existsSync(tasksPath)) return "无定时任务配置";

  try {
    const content = readFileSync(tasksPath, "utf-8");
    const lines = content.split("\n").filter(l => l.startsWith("|") && !l.includes("---") && !l.includes("时间"));
    const tasks = lines.map(line => {
      const cells = line.split("|").map(c => c.trim()).filter(c => c.length > 0);
      if (cells.length < 4) return null;
      return { time: cells[0], name: cells[1], desc: cells[3] };
    }).filter(Boolean);

    if (tasks.length === 0) return "无定时任务";

    const rows = tasks.map(t => `| ${t!.name} | ${t!.time} | ${t!.desc} |`);
    return `| 任务 | 频率 | 说明 |\n|------|------|------|\n${rows.join("\n")}`;
  } catch {
    return "读取失败";
  }
}

/**
 * 从 RECENT_EVENTS.md 提取今日事件
 */
function loadTodayEvents(cwd: string): string[] {
  const eventsPath = path.join(cwd, "0-System/RECENT_EVENTS.md");
  if (!existsSync(eventsPath)) return [];

  try {
    const content = readFileSync(eventsPath, "utf-8");
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    // 找到今天的 section
    const todaySection = content.split(`## ${dateStr}`)[1];
    if (!todaySection) return [];

    // 提取到下一个 ## 之前的内容
    const nextSection = todaySection.indexOf("\n## ");
    const sectionContent = nextSection > 0 ? todaySection.substring(0, nextSection) : todaySection;

    return sectionContent
      .split("\n")
      .filter(l => l.startsWith("- "))
      .map(l => l.replace(/^- /, "").trim())
      .slice(0, 10); // 最多 10 条
  } catch {
    return [];
  }
}

/**
 * 计算注意力负载（Phase 5 认知镜子）
 *
 * 基于活跃任务数 + 队列深度自动估算 1-5 级负载，
 * 并同步写回 blackboard.md。
 */
function computeAndSyncAttentionLoad(cwd: string): void {
  try {
    const state = readAttentionState(cwd);

    // 统计所有通道的活跃任务和队列
    let totalRunning = 0;
    let totalPending = 0;
    const suppressedTasks: string[] = [];

    // 遍历已知通道（cc、codex、gemini 三通道）
    for (const channelId of ["cc", "codex", "gemini"]) {
      const info = taskQueueManager.getQueueInfo(channelId);
      if (info.running) totalRunning++;
      totalPending += info.pending;
      // 队列中排队的任务视为被抑制
      if (info.currentTask && info.pending > 0) {
        suppressedTasks.push(`${channelId} 队列中 ${info.pending} 个待处理`);
      }
    }

    // 负载公式：base(1) + running引擎数 + pending/2，cap at 5
    const computedLoad = Math.min(5, 1 + totalRunning + Math.floor(totalPending / 2));

    // 只在负载变化时写入（减少磁盘 I/O）
    if (computedLoad !== state.load || suppressedTasks.length !== state.suppressed.length) {
      updateAttentionLoad(cwd, {
        ...state,
        load: computedLoad,
        suppressed: suppressedTasks.length > 0 ? suppressedTasks : state.suppressed,
      });
    }
  } catch {
    // 静默失败，不影响 status 刷新主流程
  }
}

/**
 * 加载注意力图式（AST — Attention Schema Theory）
 *
 * 从 blackboard.ts 结构化读取当前焦点和注意力负载，
 * 使 cc 能「知道自己在关注什么以及为什么」。
 *
 * Phase 5 升级：自动计算负载 + 知识边界感知。
 */
function loadAttentionSchema(cwd: string): string {
  // 先自动计算并同步负载到 blackboard
  computeAndSyncAttentionLoad(cwd);

  // 然后从 blackboard 结构化读取
  const state = readAttentionState(cwd);

  const table = `| 聚焦 | 负载 | 选择原因 |\n|------|------|----------|\n| ${state.focus} | ${state.load}/5 | ${state.reason} |`;
  const suppressed = state.suppressed.length > 0
    ? `**被抑制的任务**：${state.suppressed.join("、")}`
    : "**被抑制的任务**：无";

  return `${table}\n\n${suppressed}`;
}

/**
 * 检测系统运行状态
 */
function getSystemStatus(): Array<{ name: string; status: string; note: string }> {
  const items: Array<{ name: string; status: string; note: string }> = [];

  // mycc 后端（感知实际端口，优先读 PORT 环境变量）
  const myccPort = process.env.PORT || "18080";
  try {
    const pid = execSync(`lsof -i :${myccPort} -t 2>/dev/null`, { encoding: "utf-8" }).trim();
    items.push({ name: `mycc 后端 (${myccPort})`, status: pid ? "✅ 运行中" : "❌ 未运行", note: pid ? `PID ${pid}` : "" });
  } catch {
    items.push({ name: `mycc 后端 (${myccPort})`, status: "❌ 未运行", note: "" });
  }

  // Ghost OS MCP
  const ghostBin = path.join(process.cwd(), "ghost-os/.build/release/ghost");
  items.push({
    name: "Ghost OS MCP",
    status: existsSync(ghostBin) ? "✅ 已安装" : "❌ 未安装",
    note: existsSync(ghostBin) ? "桌面自动化 26 工具" : "",
  });

  // 飞书通道
  items.push({ name: "飞书通道", status: "✅ 随后端", note: "cc/codex/gemini 三通道" });

  // 内置 Scheduler
  items.push({ name: "内置 Scheduler", status: "✅ 运行中", note: "每 60s 检查 tasks.md" });

  return items;
}

/**
 * 生成 status.md 内容
 */
function generateStatus(cwd: string): string {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  // 系统状态
  const sysStatus = getSystemStatus();
  const sysTable = sysStatus.map(s => `| ${s.name} | ${s.status} | ${s.note} |`).join("\n");

  // 今日事件（合并 RECENT_EVENTS + 运行时追加的）
  const recentEvents = loadTodayEvents(cwd);
  const allEvents = [...new Set([...recentEvents, ...todayEvents])];
  const eventsBlock = allEvents.length > 0
    ? allEvents.map(e => `- ${e}`).join("\n")
    : "- 暂无记录";

  // 定时任务
  const tasksOverview = loadTasksOverview(cwd);

  // 注意力图式（AST — Attention Schema Theory）
  const attentionSchema = loadAttentionSchema(cwd);

  return `# Status（短期记忆）

> 自动注入给 cc。由 mycc 后端每 30 分钟自动刷新。

---

## 今日快照

**日期**：${dateStr}

**今天做了什么**：
${eventsBlock}

---

## 注意力图式

${attentionSchema}

## 系统状态

| 系统 | 状态 | 说明 |
|------|------|------|
${sysTable}

## 定时任务

${tasksOverview}

## 多引擎黑板

> 三引擎共享状态，详见 \`0-System/blackboard.md\`

---

*自动更新：${dateStr} ${timeStr}*
`;
}

/**
 * 刷新 status.md
 */
export function refreshStatus(cwd: string): void {
  try {
    const content = generateStatus(cwd);
    const statusPath = path.join(cwd, "0-System/status.md");
    writeFileSync(statusPath, content, "utf-8");
    console.log(`[StatusUpdater] status.md 已刷新`);
  } catch (err) {
    console.warn("[StatusUpdater] 刷新失败:", err);
  }
}

/**
 * 启动 status 定时更新
 */
export function startStatusUpdater(cwd: string): void {
  // 立即执行一次
  refreshStatus(cwd);

  // 定时刷新
  intervalId = setInterval(() => {
    refreshStatus(cwd);
  }, UPDATE_INTERVAL);

  console.log("[StatusUpdater] 已启动，每 30 分钟自动刷新 status.md");
}

/**
 * 停止 status 定时更新
 */
export function stopStatusUpdater(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
