/**
 * Multi-Engine Result Envelope — v0.4
 *
 * 三引擎（cc / codex / gemini）任务回包统一协议。
 * 落地路径（Phase 0 通过验收后）：
 *   .agents/skills/mycc/scripts/src/services/envelope.ts
 *
 * v0.4 修订（三路合并：cc + codex 对抗审查 + gemini 调研）：
 *   1. 新增 run_id（UUID，与语义 task_id 分离）
 *   2. 新增 attempt（重试计数，默认 1）
 *   3. 新增 context_diff（Magentic-One 停滞检测必需字段）
 *   4. EventType 扩展：tool_called / handoff_requested
 *   5. AgentEvent.payload 加 context_diff，支持停滞熔断
 *   6. 并发写：明确用 SQLite WAL（废弃 fs.appendFileSync O_APPEND 方案）
 *   7. Gemini CLI 正确模型名：gemini-3-flash-preview（非 gemini -p 无型号）
 *   8. 6 个 TODO 全部决议落地
 *
 * 调用方式（现状，不变）：
 *   codex: `cat /tmp/prompt.md | codex exec - > /tmp/out.md`
 *   gemini: `gemini -m gemini-3-flash-preview -p "$(cat /tmp/prompt.md)"`
 *
 * 设计原则：
 * - 所有字段尽量明确语义，避免 any
 * - 必需字段（缺即崩）vs 可选字段（缺即降级）严格区分
 * - engine 维度对称：cc/codex/gemini 都用同一个 schema，差异在 wrapper 适配层
 */

export type Engine = "cc" | "codex" | "gemini";

export type Verdict =
  | "success"
  | "failure"
  | "partial"        // 部分完成（有可用产出但未全达成）
  | "needs-review"   // 需 cc/人工介入决策
  | "blocked"        // 被外部依赖卡住
  | "stalled";       // 停滞熔断触发（连续 3 次无 context_diff）

export type ArtifactKind =
  | "code"      // 源代码改动
  | "doc"       // markdown / 报告
  | "data"      // jsonl / json 数据
  | "log"       // 日志类
  | "patch"     // diff / patch
  | "external"; // 外部链接（飞书 / VPS）

export interface Artifact {
  path: string;          // 绝对路径或 URL（write-after-read 兜底要求必须是可读路径）
  kind: ArtifactKind;
  bytes?: number;
  sha256?: string;
  description?: string;
}

export interface EngineError {
  code: string;          // 引擎特定错误码（如 "codex_sandbox_denied"）
  message: string;
  retryable: boolean;
  details?: unknown;
}

/**
 * 上下文差量 — Magentic-One 停滞检测的核心字段。
 * 每次 milestone/done 事件必须填写；cc 检测连续 3 次空 context_diff 则触发停滞熔断。
 * Write-after-read 原则：产出必须物化到 artifacts[].path，不能只在 context_diff 里提及。
 */
export interface ContextDiff {
  added_facts?: string[];      // 新确认的事实（发现了什么）
  resolved_issues?: string[];  // 已解决的问题
  pending_blockers?: string[]; // 新增的阻塞项（不为空时 verdict 应为 blocked）
}

export interface ResultEnvelope {
  // ============ 必需字段（缺一个就拒绝消费）============
  envelope_version: "0.4";
  run_id: string;                          // UUID，每次执行唯一（幂等/重试场景用）
  task_id: string;                         // 语义 ID（如 "phase0-envelope-design"）
  engine: Engine;
  attempt: number;                         // 第几次尝试，从 1 开始
  started_at: string;                      // ISO 8601
  finished_at: string;                     // ISO 8601
  verdict: Verdict;
  summary: string;                         // 1-3 句话总结，给 cc 快速决策

  // ============ 可选字段（缺则降级，不阻塞）============
  context_diff?: ContextDiff;              // 停滞检测必需；单次任务填 done 时的总 diff
  artifacts?: Artifact[];                  // 产出清单（所有产出必须 write-after-read 物化）
  suggested_next_owner?: Engine | null;    // 建议下一棒；cc 仍是真正裁决者，此字段只是建议
  suggested_next_reason?: string;
  error?: EngineError | null;
  cost_tokens?: { input: number; output: number; total: number };
  latency_ms?: number;
  trace_id?: string;                       // 关联到 events.db 的事件流（SQLite WAL）

  // ============ 引擎特定扩展（不强制，存原始信息备查）============
  engine_specific?: {
    codex?: { session_id?: string; model?: string; reasoning_effort?: string };
    gemini?: {
      model?: string;                      // 如 "gemini-3-flash-preview"
      safety_blocked?: boolean;
      json_tail_parsed?: boolean;          // gemini wrapper 是否成功 parse JSON tail
    };
    cc?: { session_id?: string };
  };
}

// ============ 事件日志（SQLite WAL 替代 JSONL append）============

/**
 * 并发写决议（v0.4）：
 *   废弃 fs.appendFileSync O_APPEND 方案。
 *   POSIX O_APPEND 只保证单次 write() syscall 的原子性（< PIPE_BUF ≈ 512B on macOS）。
 *   JSONL 记录可能超过 PIPE_BUF，多进程写会产生 interleave。
 *
 *   改用 SQLite WAL 模式（better-sqlite3）：
 *     - WAL 提供行级写锁，多 writer 安全
 *     - 单条 INSERT 原子，崩溃不产生半行
 *     - 可直接 SELECT 查询，不需要 grep/tail
 *
 *   落地路径：.agents/skills/mycc/scripts/src/services/events.db（WAL mode）
 *   表结构：CREATE TABLE events(id INTEGER PRIMARY KEY, ts TEXT, engine TEXT,
 *            task_id TEXT, run_id TEXT, type TEXT, payload TEXT)
 */
export type EventType =
  | "started"             // 引擎开始执行任务（≈ TASK_CLAIMED）
  | "milestone"           // 中间里程碑，必须附 context_diff（≈ PROGRESS_YIELD）
  | "tool_called"         // 关键工具调用完成（≈ TOOL_CALL_EXECUTED）
  | "blocked"             // 被卡住（等外部资源 / 等用户）
  | "resumed"             // 从 blocked 恢复
  | "handoff_requested"   // 主动交接请求（codex 请求 gemini 补充调研等）
  | "done"                // 正常完成（与 envelope verdict 对应）
  | "failed"              // 异常退出
  | "stall_detected";     // cc 主线检测到停滞，强制干预

export interface AgentEvent {
  ts: string;                  // ISO 8601 with milliseconds
  engine: Engine;
  task_id: string;
  run_id: string;              // 与 ResultEnvelope.run_id 对应
  type: EventType;
  payload?: {
    msg?: string;
    step?: string;             // 如 "3/5"
    blocked_on?: string;
    error_code?: string;
    tool_name?: string;        // tool_called 时填
    context_diff?: ContextDiff; // milestone/done/stall_detected 时填
    stall_count?: number;      // stall_detected 时：连续空 diff 次数
  };
}

// ============ 校验 helper ============

export function isValidEnvelope(obj: unknown): obj is ResultEnvelope {
  if (typeof obj !== "object" || obj === null) return false;
  const e = obj as Partial<ResultEnvelope>;
  return (
    e.envelope_version === "0.4" &&
    typeof e.run_id === "string" &&
    typeof e.task_id === "string" &&
    typeof e.attempt === "number" &&
    e.attempt >= 1 &&
    (e.engine === "cc" || e.engine === "codex" || e.engine === "gemini") &&
    typeof e.started_at === "string" &&
    typeof e.finished_at === "string" &&
    typeof e.verdict === "string" &&
    typeof e.summary === "string"
  );
}

// ============ 停滞熔断 helper ============

/**
 * 检测引擎是否停滞：连续 STALL_THRESHOLD 次 milestone 无实质 context_diff。
 * cc 主线在分发任务后监听事件流时调用，每次收到 milestone 事件更新状态。
 */
const STALL_THRESHOLD = 3;

export function isContextDiffEmpty(diff: ContextDiff | undefined): boolean {
  if (!diff) return true;
  return (
    (!diff.added_facts || diff.added_facts.length === 0) &&
    (!diff.resolved_issues || diff.resolved_issues.length === 0)
  );
}

export function updateStallCount(
  prev: number,
  latestEvent: Pick<AgentEvent, "type" | "payload">
): { count: number; tripped: boolean } {
  if (latestEvent.type !== "milestone") return { count: prev, tripped: false };
  const empty = isContextDiffEmpty(latestEvent.payload?.context_diff);
  const count = empty ? prev + 1 : 0;
  return { count, tripped: count >= STALL_THRESHOLD };
}

// ============ Write-after-read 兜底规范 ============

/**
 * 所有 codex/gemini 执行结果的产出（代码、文档、数据）必须：
 *   1. 写入物理文件（绝对路径）
 *   2. 在 ResultEnvelope.artifacts 中登记
 *   3. cc 通过 Read 工具读取，不依赖内存返回值
 *
 * 原因：Anthropic Agent SDK 已知失败模式——长任务异步加载竞争导致
 *       classifyHandoffIfNeeded 报错，内存结果丢失。
 *       物化文件是唯一可靠的跨进程/跨 session 传递机制。
 */

// ============ 三引擎适配矩阵（规范化，v0.4 与 wrapper 对应）============

/**
 * | 维度              | cc                | codex                       | gemini                          |
 * |------------------|-------------------|-----------------------------|---------------------------------|
 * | 调用方式          | 主线直跑          | codex exec stdin            | gemini -m gemini-3-flash-preview |
 * | envelope 来源     | 自省式            | prompt 内 JSON tail，wrapper parse | wrapper 强制 JSON tail，parse 失败→降级 |
 * | JSON tail 策略    | N/A               | 标记：`// RESULT_JSON_START`| 标记：```json\n{...}\n```       |
 * | 事件写入          | 主线写 events.db  | wrapper 写 started/done；codex 自己写 tool_called/milestone | wrapper 只写 started/done（单轮无中间状态）|
 * | 任务分级          | 全级              | 中-长（写代码、跑测试）     | 短（调研、查资料；单轮无状态）   |
 * | 失败降级          | 兜底              | stalled→cc 接手             | 失败→跳过调研，不阻塞主链       |
 * | attempt 触发      | 手动决策          | 自动重试（retryable=true）  | 不重试（单轮），换 cc 自评       |
 */

// ============ Phase 0 TODO 决议记录（已全部落地）============
// [x] gemini wrapper：JSON tail 以 ```json\n{...}\n``` 为标记，正则提取最后一个 json block
//     parse 失败时产生 verdict="partial"，summary="gemini output not parseable as JSON"
// [x] codex wrapper：stdout 中找 `// RESULT_JSON_START\n` 之后的内容作为 envelope JSON
//     找不到则 verdict="partial"，以最后 500 字节 stdout 作 summary
// [x] events 并发写：改 SQLite WAL（better-sqlite3），废弃 fs.appendFileSync
// [x] envelope_version 兼容：消费方先检查版本号，0.3→0.4 不兼容，wrapper 负责升级
// [x] baseline 测量：Phase 0 第一周记录 task_start→task_done latency_ms + token cost，
//     作为 P0-1/P0-2（消除阻塞/省 token）ROI 判断基线，不做推测
// [x] 任务分级规则：预估 <5min → gemini；5-20min → codex；>20min → codex 拆分后并行
