# Phase 0 实施清单 — 三引擎协同协议层

> 基于三路审查共识（cc + codex + gemini），2026-04-19
> 目标：一周内完成最小协议层，获得真实基线数据，再决定 P0-1/P0-2 要不要做

---

## 交付物清单（3 个文件，无多余）

| # | 文件路径 | 内容 | 负责引擎 |
|---|---------|------|---------|
| 1 | `.agents/skills/mycc/scripts/src/services/envelope.ts` | 从 envelope.draft.ts v0.4 直接迁入，不加新内容 | cc |
| 2 | `.agents/skills/mycc/scripts/src/services/events.ts` | SQLite WAL 事件写入器（INSERT + 停滞检测查询） | codex |
| 3 | `.agents/skills/mycc/scripts/src/wrappers/` | 三引擎 wrapper stub（cc-wrapper / codex-wrapper / gemini-wrapper） | codex |

---

## 任务分解（按依赖顺序）

### T1：迁入 envelope.ts（cc 主线，<1h）

- [ ] 将 `1-Inbox/multi-engine-optimization/envelope.draft.ts` 复制到落地路径
- [ ] 去掉草稿注释头，保留所有类型和 helper
- [ ] `npx tsc --noEmit` 验证无类型错误

### T2：events.ts — SQLite WAL 写入器（codex，估 2-3h）

```typescript
// 接口规范（cc 定义，codex 实现）
interface EventsDB {
  append(event: AgentEvent): void;
  queryByTask(task_id: string): AgentEvent[];
  detectStall(task_id: string, run_id: string): { stalled: boolean; count: number };
}
```

约束：
- 使用 `better-sqlite3`（同步 API，避免异步竞争）
- WAL 模式：`db.pragma('journal_mode = WAL')`
- 表结构见 `envelope.ts` 注释
- `detectStall`：查询最近 N 条 milestone，统计 context_diff 为空的连续次数

### T3：wrapper stubs（codex，估 3-4h）

**codex-wrapper.ts**：
- 启动前写 `started` 事件
- exec stdin，等待退出
- 从 stdout 找 `// RESULT_JSON_START\n` 后的 JSON → parse 为 ResultEnvelope
- 找不到则 verdict="partial"，summary=stdout 最后 500 字节
- 退出后写 `done` 或 `failed` 事件

**gemini-wrapper.ts**：
- 启动前写 `started` 事件
- 调用 `gemini -m gemini-3-flash-preview -p "$(cat prompt_file)"`
- 从 stdout 提取最后一个 ` ```json\n{...}\n``` ` 块 → parse
- parse 失败：verdict="partial"，summary=stdout 原文（截 800 字符）
- 写 `done` 或 `failed` 事件（gemini 无中间状态，无 milestone）

**cc-wrapper.ts**（可选，主线自用）：
- 仅写 started/done 事件
- cc 直接构建 ResultEnvelope，不需要 parse

### T4：基线测量插桩（cc，<30min）

在现有 codex/gemini 调用点（`feishu.ts` autoRouteEngine 出口）加：
```typescript
const startedAt = new Date().toISOString();
// ... 调用 ...
const latencyMs = Date.now() - new Date(startedAt).getTime();
// append baseline log: task_id, engine, latency_ms, tokens
```

目标：一周后有真实分母（latency / token cost），再评估 P0-1/P0-2。

---

## 验收标准

| 标准 | 验证方式 |
|------|---------|
| TypeScript 类型无错 | `npx tsc --noEmit` 零报错 |
| codex wrapper 能 parse JSON tail | 单测：模拟 stdout 含 RESULT_JSON_START 标记 |
| gemini wrapper 能 parse JSON block | 单测：模拟 stdout 含 ```json 块 |
| events.db 多进程写不产生脏数据 | 并发写 100 条，SELECT COUNT 等于 100 |
| 停滞熔断正确触发 | 单测：注入 3 条空 context_diff milestone，detectStall 返回 true |

---

## 明确不在 Phase 0 做的事

- ❌ 真正的 subagent 化（P0-1）— 等基线数据后决策
- ❌ sticky context cache（P0-2）— 同上
- ❌ JSONL 黑板迁移（P1-1）— blackboard.ts 已有程序化接口，不动
- ❌ 能力评分路由（P2）— 过早优化

---

## 已解决的关键设计决策

| 决策点 | 结论 | 来源 |
|--------|------|------|
| 并发写方案 | SQLite WAL（废弃 O_APPEND）| codex 审查 + POSIX 文档验证 |
| gemini 调用方式 | 仍是 CLI（`gemini -m gemini-3-flash-preview -p`）| memory 确认（codex 审查误判） |
| next_owner 权威性 | 仅建议，cc 裁决 | codex v0.1 审查反馈 |
| events 存储格式 | SQLite events.db（非 JSONL 文件）| v0.4 修订 |
| gemini JSON tail 标记 | ` ```json\n{...}\n``` `（最后一个 json block）| v0.4 决议 |
| codex JSON tail 标记 | `// RESULT_JSON_START\n` 之后内容 | v0.4 决议 |
| 停滞阈值 | 3 次连续空 context_diff | Magentic-One 借鉴（gemini 调研）|
| 任务分级 | <5min→gemini；5-20min→codex；>20min→codex 拆分并行 | v0.4 决议 |
