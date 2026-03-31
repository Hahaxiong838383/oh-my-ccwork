/**
 * 异步任务队列（双主分离 - 任务主 Agent）
 *
 * 解决的问题：长任务（theory-radar / github-radar / 写代码等）阻塞对话通道，
 * 用户在任务执行期间无法继续交互。
 *
 * 方案：
 * - 消息分类器判断是"对话型"还是"任务型"
 * - 任务型：立即 ack + 后台异步执行 + 完成后回飞书
 * - 对话型：走原有同步流程
 * - 每通道独立任务队列（串行，避免 session 冲突）
 * - 后台任务使用独立 session（不占用对话 session）
 */

// ---- 消息分类器 ----

const TASK_KEYWORDS = [
  // 创建/写
  "写", "创建", "生成", "新建", "制作", "做一个", "帮我写", "帮我做",
  // 实现/开发
  "实现", "开发", "编写", "构建", "搭建",
  // 分析/研究
  "分析", "调研", "研究", "总结全文", "深度分析", "全面分析",
  // 采集/抓取
  "采集", "抓取", "爬取", "搜索", "收集",
  // Skill 触发词
  "/theory-radar", "/github-radar", "/collect", "/gold", "/ipo-report",
  "/ai-news", "理论雷达", "github风向标", "每日采集", "早报",
  // 修复/重构
  "修复所有", "重构", "批量", "全部",
];

/** 对话型消息的特征：短、疑问、闲聊 */
const CHAT_KEYWORDS = [
  "是什么", "什么是", "怎么", "为什么", "解释", "说说", "聊聊",
  "好的", "明白", "谢谢", "知道了", "可以", "不用了",
  "进展", "状态", "怎么样", "如何", "情况",
];

export type MessageType = "chat" | "task";

import { readFileSync, existsSync } from "fs";
import * as path from "path";

// ---- 引擎信任度统计（AST — 基于历史完成率） ----

/** 引擎信任度缓存（10 分钟 TTL，避免频繁读文件） */
let _trustCache: { data: Map<string, number>; timestamp: number } | null = null;
const TRUST_CACHE_TTL = 10 * 60 * 1000;

/**
 * 从 task-log.md 统计各引擎完成率。
 * 解析格式: | 时间 | 任务类型 | 摘要 | 执行引擎 | 状态 | friction_skill |
 */
function computeEngineTrust(cwd: string): Map<string, number> {
  const now = Date.now();
  if (_trustCache && now - _trustCache.timestamp < TRUST_CACHE_TTL) {
    return _trustCache.data;
  }

  const trustMap = new Map<string, number>();
  const logPath = path.join(cwd, "0-System/task-log.md");
  if (!existsSync(logPath)) {
    _trustCache = { data: trustMap, timestamp: now };
    return trustMap;
  }

  try {
    const content = readFileSync(logPath, "utf-8");
    const counts = new Map<string, { total: number; success: number }>();

    for (const line of content.split("\n")) {
      // 匹配表格行: | 时间 | 类型 | 摘要 | 引擎 | 状态 | ...
      const cells = line.split("|").map(c => c.trim()).filter(Boolean);
      if (cells.length < 5) continue;

      const engineRaw = cells[3].toLowerCase();
      const status = cells[4];

      // 提取引擎名（可能带括号注释如 "cc (opus)"）
      let engine: string | null = null;
      if (engineRaw.includes("codex")) engine = "codex";
      else if (engineRaw.includes("gemini")) engine = "gemini";
      else if (engineRaw.includes("cc") || engineRaw.includes("claude")) engine = "cc";
      if (!engine) continue;

      const entry = counts.get(engine) || { total: 0, success: 0 };
      entry.total++;
      if (status.includes("✅") || status.includes("完成")) {
        entry.success++;
      }
      counts.set(engine, entry);
    }

    // 计算信任度 = 成功率（最低 0.5 保底，避免冷启动引擎被完全排除）
    for (const [engine, { total, success }] of counts) {
      const rate = total > 0 ? success / total : 0.5;
      trustMap.set(engine, Math.max(rate, 0.5));
    }
  } catch {
    // 静默失败
  }

  _trustCache = { data: trustMap, timestamp: now };
  return trustMap;
}

// ---- 半自动引擎路由 ----

export type AutoRouteEngine = "cc" | "codex" | "gemini" | "pipeline";

/**
 * 路由结果（AST — 社会注意力推断）
 *
 * 不仅返回目标引擎，还返回路由原因和上下文提示，
 * 让系统「知道为什么分配给这个引擎」。
 */
export interface RouteResult {
  engine: AutoRouteEngine;
  /** 路由原因（用于 blackboard 记录 + 日志） */
  reason: string;
  /** 传递给目标引擎的上下文提示（如已知的工具偏好、历史表现） */
  contextHints: string[];
}

/** 适合 codex 的任务：代码编写/调试/重构 + 论文调研归档 */
const CODEX_ROUTE_KEYWORDS = [
  "写代码", "写个", "写一个", "帮我写", "编程", "写程序",
  "调试", "debug", "fix bug", "修复bug", "修复 bug",
  "实现功能", "实现一个", "实现这个", "代码实现",
  "开发一个", "开发功能",
  "重构", "code review", "代码审查",
  "单元测试", "写测试",
  "typescript", "javascript", "python", "golang", "rust", "java",
  "函数", "接口定义", "类定义",
  // 论文调研归档（从 gemini 迁移）
  "论文", "调研", "研究现状", "文献", "综述", "arxiv",
  "理论雷达", "theory-radar", "前沿论文", "/theory-radar",
];

/** 需要 MCP 工具的写入操作关键词 */
const WRITE_KEYWORDS = [
  "写入文档", "写入飞书", "写到文档", "写到飞书", "写入知识库",
  "创建文档", "更新文档", "修改文档", "编辑文档",
  "发消息", "发飞书", "发送到飞书", "发到群",
  "创建表格", "更新表格", "写入表格",
];

/** 分析/研究类关键词（可被 Gemini 处理的前置步骤） */
const ANALYSIS_KEYWORDS = [
  "分析", "总结", "调研", "研究", "概括", "提取", "归纳",
  "论文", "视频", "内容", "全文",
];

/** 适合 gemini 的任务：采集/新闻/知识库查询（论文调研已迁移到 codex） */
const GEMINI_ROUTE_KEYWORDS = [
  // 采集/新闻
  "采集", "抓取", "爬取", "新闻", "资讯", "早报", "简报",
  "github风向标", "github-radar", "/github-radar", "ai新闻",
  "ipo报告", "/ipo-report", "/collect",
  // 知识库查询（非写入）
  "知识库", "wiki", "futurus",
  // 大型分析
  "总结全文", "全文分析", "深度分析全文",
];

/**
 * 半自动任务路由（AST 社会注意力版）：
 * 根据消息内容推荐最合适的引擎，并说明路由原因和上下文提示。
 *
 * 路由优先级：
 * 1. pipeline（分析+写入组合）→ Gemini 分析 → Codex 写入飞书
 * 2. codex（纯代码任务 / 论文调研）
 * 3. gemini（纯调研/采集）
 * 4. cc（默认 / 纯写入操作）
 */
export function autoRouteEngine(message: string, cwd?: string): RouteResult {
  const text = message.trim().toLowerCase();

  // v7 AST: 加载历史信任度（有 cwd 时生效）
  const trust = cwd ? computeEngineTrust(cwd) : new Map<string, number>();
  const getTrust = (engine: string): number => trust.get(engine) ?? 0.5;
  const trustSuffix = (engine: string): string => {
    const t = getTrust(engine);
    return trust.size > 0 ? ` [信任度: ${(t * 100).toFixed(0)}%]` : "";
  };

  const hasWrite = WRITE_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  const hasAnalysis = ANALYSIS_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  const hasGemini = GEMINI_ROUTE_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  const hasUrl = /https?:\/\/\S+/i.test(text);
  const hasCodex = CODEX_ROUTE_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  const hasGitHub = /github\.com/i.test(text);
  const hasArxiv = /arxiv\.org/i.test(text);

  // 最高优先级：分析+写入组合 → pipeline（Gemini 分析 → Codex 写入）
  if (hasWrite && (hasAnalysis || hasGemini)) {
    return {
      engine: "pipeline",
      reason: `分析+写入组合任务，Gemini 负责分析，Codex 负责写入飞书${trustSuffix("pipeline")}`,
      contextHints: ["gemini 做前置分析", "codex 做飞书写入", "需要 lark-cli MCP"],
    };
  }

  // 纯写入操作 → codex（有飞书 MCP 能力，分摊 cc 负担）
  if (hasWrite) {
    return {
      engine: "codex",
      reason: `飞书写入操作，codex 有 lark-cli MCP 能力${trustSuffix("codex")}`,
      contextHints: ["需要 lark-cli MCP", "写入后验证结果"],
    };
  }

  // GitHub URL → cc（分析项目对 mycc 的迭代价值，需要 cc 的完整上下文）
  if (hasGitHub) {
    return {
      engine: "cc",
      reason: `GitHub 项目分析需要 cc 的完整项目上下文${trustSuffix("cc")}`,
      contextHints: ["评估对 mycc 的迭代价值", "需要 gh CLI"],
    };
  }

  // arxiv URL / 论文关键词 → codex（论文调研归档）
  // v7 AST: 如果 codex 信任度明显低于 gemini，降级到 gemini
  if (hasArxiv || hasCodex) {
    const preferredEngine = (getTrust("codex") < 0.6 && getTrust("gemini") > getTrust("codex") + 0.1)
      ? "gemini" as const
      : "codex" as const;
    return {
      engine: preferredEngine,
      reason: hasArxiv
        ? `arxiv 论文调研归档${trustSuffix(preferredEngine)}`
        : `代码/调研任务${trustSuffix(preferredEngine)}`,
      contextHints: hasArxiv
        ? ["论文调研模式", "输出归档到 1-Inbox/"]
        : ["代码任务", "可直接修改仓库"],
    };
  }

  // 非 GitHub/arxiv 的 URL + 分析关键词 → gemini（通用调研类）
  if (hasUrl && hasAnalysis) {
    return {
      engine: "gemini",
      reason: `URL + 分析关键词，gemini 擅长通用调研${trustSuffix("gemini")}`,
      contextHints: ["通用 URL 分析", "输出纯文本结果"],
    };
  }

  if (hasGemini) {
    return {
      engine: "gemini",
      reason: `采集/新闻/知识库查询任务${trustSuffix("gemini")}`,
      contextHints: ["采集模式", "可能需要 enableTools"],
    };
  }

  return {
    engine: "cc",
    reason: `默认路由到 cc（对话/通用任务）${trustSuffix("cc")}`,
    contextHints: [],
  };
}

/**
 * 判断消息类型。
 * 启发式规则，不追求完美，误判代价低（无非同步变同步）。
 */
export function classifyMessage(message: string): MessageType {
  const text = message.trim();

  // 命令类 "/" 开头：大多数是任务
  if (text.startsWith("/")) {
    // 少数运维命令除外（由 handleOperationCommand 处理，这里不到达）
    return "task";
  }

  // 明确的对话关键词 → chat（权重高）
  const lowerText = text.toLowerCase();
  if (CHAT_KEYWORDS.some((kw) => lowerText.includes(kw))) {
    return "chat";
  }

  // 任务关键词匹配
  const hasTaskKeyword = TASK_KEYWORDS.some((kw) => text.includes(kw));

  // 长消息（> 80 字）+ 任务关键词 → task
  if (hasTaskKeyword && text.length > 80) return "task";

  // 有任务关键词且消息有一定长度（> 20 字）
  if (hasTaskKeyword && text.length > 20) return "task";

  // 默认：chat（保守策略，只有明确任务才异步）
  return "chat";
}

// ---- 任务队列 ----

export interface QueuedTask {
  id: string;
  channelId: string;
  message: string;
  engine: string; // 路由到的引擎（cc/codex/gemini/pipeline）
  submittedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  status: "pending" | "running" | "done" | "error" | "aborted";
  error?: string;
  /** 每个任务独立的执行器（避免共享 executor 导致路由错乱） */
  executor: TaskExecutor;
}

type TaskExecutor = (task: QueuedTask, signal: AbortSignal) => Promise<void>;

/**
 * 单通道任务队列（串行执行，避免 session 并发冲突）。
 * 每个 task 携带独立的 executor，避免共享 executor 导致路由错乱。
 */
class ChannelTaskQueue {
  private queue: QueuedTask[] = [];
  private running = false;
  private currentTask: QueuedTask | null = null;
  private _abortController: AbortController | null = null;
  readonly channelId: string;

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  enqueue(task: QueuedTask): void {
    this.queue.push(task);
    this.drain();
  }

  private drain(): void {
    if (this.running || this.queue.length === 0) return;
    this.running = true;

    const next = this.queue.shift()!;
    next.status = "running";
    next.startedAt = new Date();
    this.currentTask = next;
    this._abortController = new AbortController();

    // 使用 task 自带的 executor（每个任务独立，不共享）
    next.executor(next, this._abortController!.signal)
      .then(() => {
        if (next.status === "running") next.status = "done";
        next.finishedAt = new Date();
      })
      .catch((err) => {
        if (next.status === "running") {
          next.status = this._abortController?.signal.aborted ? "aborted" : "error";
        }
        next.finishedAt = new Date();
        next.error = String(err);
      })
      .finally(() => {
        this.running = false;
        this.currentTask = null;
        this._abortController = null;
        this.drain(); // 处理下一个
      });
  }

  /**
   * 中止当前任务 + 清空队列。
   * 返回被取消的任务详情，便于向用户报告。
   */
  abort(): {
    cancelledCount: number;
    abortedRunning: boolean;
    runningTaskPreview?: string;
    runningTaskEngine?: string;
    cancelledPreviews: string[];
  } {
    const cancelledPreviews = this.queue.map(t =>
      `${t.engine}: ${t.message.substring(0, 30)}...`
    );
    const cancelledCount = this.queue.length;
    // 清空待执行队列
    for (const task of this.queue) {
      task.status = "aborted";
      task.finishedAt = new Date();
    }
    this.queue = [];

    // 中止正在执行的任务
    let abortedRunning = false;
    let runningTaskPreview: string | undefined;
    let runningTaskEngine: string | undefined;
    if (this._abortController && !this._abortController.signal.aborted) {
      this._abortController.abort();
      abortedRunning = true;
      if (this.currentTask) {
        this.currentTask.status = "aborted";
        runningTaskPreview = this.currentTask.message.substring(0, 40);
        runningTaskEngine = this.currentTask.engine;
      }
    }

    return { cancelledCount, abortedRunning, runningTaskPreview, runningTaskEngine, cancelledPreviews };
  }

  /** 获取当前任务的 AbortSignal（供外部检查是否被中止） */
  get abortSignal(): AbortSignal | null {
    return this._abortController?.signal ?? null;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 获取当前运行中的任务信息 */
  getCurrentTask(): QueuedTask | null {
    return this.currentTask;
  }
}

/**
 * 全局任务队列管理器（每通道独立队列）。
 */
export class TaskQueueManager {
  private queues: Map<string, ChannelTaskQueue> = new Map();
  private taskCounter = 0;

  private getOrCreate(channelId: string): ChannelTaskQueue {
    if (!this.queues.has(channelId)) {
      this.queues.set(channelId, new ChannelTaskQueue(channelId));
    }
    return this.queues.get(channelId)!;
  }

  /**
   * 将任务加入队列。
   * @param engine 路由到的引擎名（用于显示和排查）
   * @returns 任务 ID
   */
  submit(channelId: string, message: string, engine: string, executor: TaskExecutor): string {
    const id = `task-${++this.taskCounter}-${Date.now()}`;
    const task: QueuedTask = {
      id,
      channelId,
      message,
      engine,
      submittedAt: new Date(),
      status: "pending",
      executor,
    };

    const queue = this.getOrCreate(channelId);
    const pendingBefore = queue.pendingCount;
    const isRunning = queue.isRunning();

    queue.enqueue(task);

    console.log(
      `[TaskQueue][${channelId}] 任务入队 ${id} (${engine})，` +
      `队列状态: running=${isRunning}, pending=${pendingBefore}`
    );

    return id;
  }

  /**
   * 获取通道当前队列长度（不含正在运行的任务）。
   */
  getPendingCount(channelId: string): number {
    return this.queues.get(channelId)?.pendingCount ?? 0;
  }

  /**
   * 通道是否有任务正在运行。
   */
  isChannelBusy(channelId: string): boolean {
    return this.queues.get(channelId)?.isRunning() ?? false;
  }

  /**
   * 中止通道的所有任务（当前执行 + 队列中的）。
   */
  abort(channelId: string) {
    const queue = this.queues.get(channelId);
    if (!queue) return { cancelledCount: 0, abortedRunning: false, cancelledPreviews: [] as string[] };
    const result = queue.abort();
    console.log(`[TaskQueue][${channelId}] 中止: cancelled=${result.cancelledCount}, abortedRunning=${result.abortedRunning}, runningTask=${result.runningTaskPreview || "无"}`);
    return result;
  }

  /**
   * 获取通道队列状态信息。
   */
  getQueueInfo(channelId: string): { running: boolean; pending: number; currentTask: QueuedTask | null } {
    const queue = this.queues.get(channelId);
    if (!queue) return { running: false, pending: 0, currentTask: null };
    return {
      running: queue.isRunning(),
      pending: queue.pendingCount,
      currentTask: queue.getCurrentTask(),
    };
  }
}

/** 全局单例 */
export const taskQueueManager = new TaskQueueManager();
