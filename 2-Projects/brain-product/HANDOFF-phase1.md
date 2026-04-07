# HANDOFF: mycc-brain Phase 1 数据管道修复

> 上一个 session 完成了四轮 cc×Codex 对抗审查 + 决策记录 + 分支创建。
> 本 session 负责执行实现。

---

## 当前状态

- **分支**: `feat/brain-phase1-data-pipeline`（已创建，从 main `bf31a89` 分出）
- **回滚点**: `git checkout main` 即可回退
- **决策记录**: 已写入 `2-Projects/brain-product/04-决策记录.md`
- **版本**: 当前 `0.1.0`，改完后升为 `0.2.0`

---

## 要做的 5 个改动

### 改动 1: capability-aware prompt builder
- **文件**: `src/services/brain-context.ts`
- **做什么**: `buildBrainSystemPrompt()` 加 `opts?: { hasTools?: boolean }` 参数
- **hasTools=true**: 保留 "使用 add_memory 工具保存" 指令
- **hasTools 缺省**: 改为 "当用户要求你记住某事，明确确认已记录；系统会在后台尝试提取并保存用户明确陈述的事实。"
- **调用方**: brain-api.ts 不传；server.ts 的 agent/agent-stream 传 `{ hasTools: true }`；test/compare 不传

### 改动 2: 流式 capture + conversation 保存
- **文件**: `src/adapters/openai-compat.ts`, `src/brain-api.ts`
- **做什么**: `streamOpenAICompat()` 返回 `StreamCaptureResult { content, completed, truncated }`
- **adapter 内部**: lineBuffer 解析 SSE `data:` 行，只收集 `delta.content`，独立追踪 `[DONE]`
- **上限**: 128_000 chars content，超出设 truncated=true 但继续透传
- **brain-api.ts**: 流式分支用返回的 content 做 `saveToConversation`
- **关键**: 必须正确处理跨 chunk 行切断、客户端断连、上游无 [DONE]

### 改动 3: 主链路补 runMemoryIntake
- **文件**: `src/services/memory-intake.ts`, `src/brain-api.ts`
- **做什么**:
  - `IntakeInput.assistantReply` 改为可选
  - `buildIntakePrompt()` 中 assistantReply 为空时不输出 assistant 行；非空时标明"仅供上下文，不得作为事实来源"
  - 新增 `enqueueMemoryIntake()` 串行队列（模块级 Promise 链，防并发写文件）
  - brain-api.ts 流式/非流式分支在 `route.brain === true` 时异步调用
  - **不传 fallbackIntake**（防烧付费 API）

### 改动 4: schema 兼容修复
- **文件**: `src/services/memory-db.ts`, `src/tools/list-memories.ts`, `src/services/memory-store.ts`, `src/services/claude-memory-sync.ts`
- **做什么**:
  - parser 放宽为 `/^###?\s*\[([^\]]+)\]/`（memory-db.ts + list-memories.ts）
  - writer 统一为 `## [namespace]`（memory-store.ts + claude-memory-sync.ts）
  - 旧 `###` 数据无需迁移，parser 放宽后自然兼容

### 改动 5: prediction wiring 修复
- **文件**: `src/brain-api.ts`
- **做什么**:
  - `recordExperience()` 改为 options object 接口（当前 7 个位置参数 + 新增 intent/conversationId）
  - `recordPrediction()` 使用真实 conversationId + userState.intent（不再用 "default" 和模型名）
  - `predictNextNeed()` 传入 brainRoot（第 4 参数）

---

## 并行执行策略

| Agent | 改动 | 文件 | 依赖 |
|-------|------|------|------|
| Agent 1 | 改动 1 + 改动 4 | brain-context.ts, server.ts, memory-db.ts, list-memories.ts, memory-store.ts, claude-memory-sync.ts | 无 |
| Agent 2 | 改动 2 + 改动 3 | openai-compat.ts, memory-intake.ts, brain-api.ts（流式 capture + intake 接入） | 无 |
| Agent 3 | 改动 5 | brain-api.ts（recordExperience 重构 + prediction fix） | 无 |

**注意**: Agent 2 和 Agent 3 都改 brain-api.ts，但改的是不同部分：
- Agent 2 改流式/非流式分支的 saveToConversation + intake 调用
- Agent 3 改 recordExperience 方法签名 + recordPrediction 调用
- 合并时需要手动 resolve conflict

---

## 验收标准

1. `npm run build` 通过
2. 流式 3 轮对话后 conversation store 有完整 user+assistant
3. `route.brain === true` 时触发异步 intake，不阻塞响应
4. 主链路 intake 不 fallback 到付费 API
5. 新 header 统一 `## [namespace]`，旧 `### [namespace]` 仍被 FTS/list 识别
6. prediction-log 中 intent 为语义值，conversationId 非 "default"
7. 主链路回复中不出现 tool_call JSON 垃圾

---

## 不做的事

- 不加 agent loop / tool calling
- 不做 conversation 持久化
- 不做 API 认证
- 不做 knowledge-completion 重构
- 不写旧数据迁移脚本
