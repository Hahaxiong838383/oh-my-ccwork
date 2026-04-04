# mycc-brain Agent Loop 方案调研报告

> 调研日期：2026-04-04
> 调研人：cc (Claude claude-opus-4-6)
> 状态：完成

---

## 目录

1. [现状分析](#1-现状分析)
2. [参考项目深度分析](#2-参考项目深度分析)
3. [Agent Loop 方案对比](#3-agent-loop-方案对比)
4. [工具系统设计](#4-工具系统设计)
5. [MCP 桥接可行性](#5-mcp-桥接可行性)
6. [推荐方案](#6-推荐方案)
7. [最小 POC 代码骨架](#7-最小-poc-代码骨架)

---

## 1. 现状分析

### 1.1 当前架构

```
HTTP 请求 → server.ts (port 19080)
  → brain-api.ts (路由查找 + 多轮对话 + 记忆注入)
    → brain-context.ts (四层检索: keyword → tfidf → fts → vector)
    → openai-compat.ts (流式/非流式转发到 DashScope/DeepSeek)
  → 响应 (OpenAI 兼容格式)
```

### 1.2 代码量统计

| 模块 | 文件数 | 行数 |
|------|--------|------|
| 核心 API | 3 | ~700 |
| 服务层 (记忆/进化/经验流) | 8 | ~1,300 |
| 评估框架 | 4 | ~500 |
| 管理后台 | 2 | ~500 |
| 配置 | 2 | ~200 |
| **总计** | **19** | **~4,000** |

### 1.3 关键特性

- **极简依赖**：生产依赖仅 `dotenv`，零 Web 框架（纯 Node.js http 模块）
- **SSE 零转换管道**：流式响应直接 pipe，不做任何中间处理
- **异步经验流**：响应完成后异步写入，不阻塞 HTTP
- **四层记忆检索**：keyword → TF-IDF → FTS5 → 向量语义
- **自进化引擎**：诊断 → 自动修复 → 热补丁 → 审计日志

### 1.4 Agent Loop 插入点

最佳插入位置在 `brain-api.ts` 的 `handleChatCompletions()` 中，当前流程是：

```
解析请求 → 查路由 → 加载记忆 → 构建 system prompt → 转发上游 → 返回
```

升级后应变为：

```
解析请求 → 查路由 → 加载记忆 → 构建 system prompt
  → 调用上游 → 检查 tool_calls?
    → 有: 执行工具 → 结果放回 messages → 再调用上游 (循环)
    → 无: 返回最终响应
```

---

## 2. 参考项目深度分析

### 2.1 Claude Code Source (Hahaxiong838383/claude-code-source)

**项目概况**：Claude Code v2.1.88 源码，TypeScript + Bun + React (Ink 终端 UI)

**Agent Loop 核心设计**：

核心在 `src/query.ts` 的 `queryLoop` 函数，采用 **async generator 驱动的无限循环**，每次迭代包含 7 个阶段：

```
Setup → Compaction → Model Call → Recovery → Tool Exec → Attachments → Recursion
```

**值得借鉴的 5 个设计**：

| 设计 | 细节 | brain 借鉴价值 |
|------|------|---------------|
| **StreamingToolExecutor** | 模型还在流式输出时就开始执行工具，通过 `isConcurrencySafe()` 区分只读/写操作并发策略 | **高** — brain 的工具也可以分只读（查记忆）和写操作（改配置） |
| **四级上下文压缩** | snip → microCompact → contextCollapse → autoCompact，渐进式从轻到重 | **中** — brain 当前无上下文管理，长对话时需要 |
| **工具行为声明式** | 每个工具声明 `isDestructive()`、`isConcurrencySafe()`、`interruptBehavior()`，调度器据此决策 | **高** — 比硬编码工具名好得多 |
| **Withheld Error 恢复** | 遇到 prompt-too-long 不立即抛出，先尝试压缩上下文恢复 | **中** — brain 目前没有错误恢复机制 |
| **Hook 系统** | PreToolUse/PostToolUse 中间件模式，Hook 并行执行 | **低** — brain 规模暂时不需要 |

**关键代码模式**（Agent Loop 骨架）：

```typescript
// Claude Code 的核心循环简化版
async function* queryLoop(state: State): AsyncGenerator<Event> {
  while (true) {
    // 1. 上下文压缩（如果需要）
    if (shouldCompact(state)) yield* compact(state);

    // 2. 调用模型（流式）
    const response = yield* callModel(state);

    // 3. 检查是否有工具调用
    const toolCalls = extractToolCalls(response);
    if (!toolCalls.length) break; // 无工具调用 → 结束

    // 4. 并发执行工具（尊重并发安全标记）
    const results = yield* executeTools(toolCalls, state);

    // 5. 构建下一轮状态
    state = buildNextState(state, response, results);
  }
}
```

### 2.2 revfactory/harness (★1.7K)

**项目概况**：Claude Code 的 Meta-Skill 框架，纯 Markdown/JSON 知识工程项目，零代码。A/B 测试显示：预配置后输出质量提升 60%，15 个任务 100% 成功率。

**核心贡献**：定义了 6 种 Agent 架构模式 + 双轨执行模式

| 模式 | 适配场景 | 执行方式 |
|------|---------|---------|
| Pipeline | 顺序依赖 | Sub-agent |
| Fan-out/Fan-in | 并行分发→汇聚 | Agent Team |
| Expert Pool | 按类型路由专家 | Sub-agent |
| Producer-Reviewer | 生成+验证循环 | Agent Team |
| Supervisor | 中心调度+工人领任务 | Agent Team |
| Hierarchical | 递归分解委派 | Team + Sub-agent |

**值得借鉴的 4 个设计**：

| 设计 | 细节 | brain 借鉴价值 |
|------|------|---------------|
| **渐进披露（Progressive Disclosure）** | Skill 核心 ≤500 行，超出部分放 `references/` 按需加载 | **高** — brain 工具定义也应该分核心/扩展 |
| **Eval 标准化** | 三文件：`eval_metadata.json` + `grading.json` + `timing.json` | **高** — 可统一 brain 现有 eval 格式 |
| **Script Bundling** | 观察 Agent 反复生成的代码，提取为 Skill | **中** — brain 的自进化可借鉴这个思路 |
| **文件系统作通信总线** | `_workspace/` + 命名规范 `{phase}_{agent}_{artifact}.{ext}` | **中** — 多步骤工具执行的中间产物管理 |

### 2.3 HKUDS/OpenHarness (香港大学)

**项目概况**：Claude Code 的 Python 逆向重实现。11,733 行 / 163 文件实现了 Claude Code 98% 的工具能力（43/44 工具），代码量仅为原版的 2.3%。

**核心贡献**：证明了 Agent Loop 的本质极其简单

```python
# OpenHarness 的 Agent Loop 核心（极简版）
while True:
    response = await stream_message(llm, messages, tools)
    tool_calls = extract_tool_calls(response)
    if not tool_calls:
        break
    # 多工具并行执行
    results = await asyncio.gather(*[execute(tc) for tc in tool_calls])
    messages.extend(results)
```

**值得借鉴的 3 个设计**：

| 设计 | 细节 | brain 借鉴价值 |
|------|------|---------------|
| **Pydantic Schema 自描述** | 工具用 Pydantic BaseModel 定义输入，自动生成 JSON Schema | **高** — TS 版可用 Zod，同样的思路 |
| **Hook 热重载** | `watchfiles` 运行时重载 Hook 定义，不需重启 | **中** — brain 的热补丁系统可借鉴 |
| **工具执行管线** | `Permission Check → PreToolUse Hook → Execute → PostToolUse Hook → Return` | **高** — 标准化的工具执行流程 |

### 2.4 三项目对比总结

| 维度 | Claude Code Source | Harness | OpenHarness | **brain 应吸收** |
|------|-------------------|---------|-------------|-----------------|
| Agent Loop | Async Generator, 7 阶段 | 无（Meta-Skill） | While 循环 + asyncio | **While 循环 + 流式** |
| 工具并发 | StreamingToolExecutor, 读写分离 | N/A | asyncio.gather | **读写分离并发** |
| 上下文管理 | 四级压缩 | 渐进披露 ≤500 行 | 无 | **轻量压缩 + 步数限制** |
| 工具定义 | Zod + 行为声明 | Markdown Skill | Pydantic + Registry | **Zod Schema + 行为标记** |
| 错误恢复 | Withheld Error + 三路径 | N/A | 基本 try-catch | **渐进恢复** |
| MCP | 6 种传输 + OAuth | N/A | 基本 MCP client | **Stdio + HTTP** |

---

## 3. Agent Loop 方案对比

### 3.1 方案总览

| 维度 | A: 手写循环 | B: Vercel AI SDK v6 | C: LangChain/LangGraph | D: 其他轻量方案 |
|------|-----------|-------------------|----------------------|---------------|
| **最小代码量** | ~80 行 | ~25 行 | ~100 行 | ~20 行 |
| **OpenAI 兼容** | 原生 | `createOpenAI({baseURL})` | `@langchain/openai` | 各异 |
| **流式支持** | 需自己写 SSE 解析 | `streamText` 原生 | 支持但配置复杂 | 各异 |
| **TS 原生** | 取决于你 | 原生，类型完美 | TS 编写，类型尚可 | 多数原生 |
| **依赖大小** | ~1.5MB (openai) | ~2-3MB (ai + provider) | ~10-30MB (5+ 包) | ~2-3MB |
| **Stars** | N/A | 23.2K | 17.4K + 2.7K | 559~22.7K |
| **学习曲线** | 最低 | 低 | 高 | 低~中 |

### 3.2 方案 A：手写 tool_calls 循环

**原理**：基于 OpenAI Chat Completions API 的 function calling 协议，一个 while 循环搞定。

**参考实现**：
- OpenAI Codex CLI 的 `agent-loop.ts`（生产级参考）
- Claude Code Source 的 `query.ts`（最完整参考）

**优点**：
- 零抽象，完全掌控每一步
- 依赖最少，只需 `openai` 包（甚至可以用原生 fetch）
- DashScope/DeepSeek 天然支持，改 baseURL 即可
- 调试最容易，每一步都能 log
- **与 brain 现有架构最契合**——直接在 `openai-compat.ts` 基础上扩展

**缺点**：
- 流式 tool_calls 的 partial JSON 拼接需要自己写（~50 行）
- 错误处理、重试、超时全得自己写
- 没有社区维护，出了 bug 自己修

**代码骨架**：

```typescript
async function agentLoop(messages: Message[], tools: ToolDef[]): Promise<Message> {
  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await chatCompletion({ messages, tools });
    const msg = response.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) return msg; // 最终回复

    // 并行执行工具
    const results = await Promise.all(
      msg.tool_calls.map(tc => executeTool(tc))
    );
    messages.push(...results);
  }
  throw new Error('Agent loop exceeded max steps');
}
```

### 3.3 方案 B：Vercel AI SDK v6

**当前版本**：v6（2026 年初发布），23.2K stars，极其活跃。

**核心卖点**：

```typescript
import { generateText, streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

// 一行接入 DashScope
const dashscope = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
});

// 自动 Agent Loop（非流式）
const result = await generateText({
  model: dashscope('qwen-max'),
  tools: { searchMemory, updateConfig },
  stopWhen: stepCountIs(10),
  prompt: userMessage,
});

// 流式 Agent Loop
const stream = streamText({
  model: dashscope('qwen-max'),
  tools: { searchMemory, updateConfig },
  stopWhen: stepCountIs(10),
  prompt: userMessage,
  onStepFinish: ({ toolCalls, toolResults }) => {
    // 每步完成回调，可以做进度通知
  },
});
```

**v6 关键特性**：
- `stopWhen` 控制循环策略（步数、自定义条件）
- `prepareStep` 回调：每步前可动态切模型/工具
- 内置 MCP 支持（OAuth + resources + prompts）
- Standard JSON Schema V1，Zod 之外的 schema 也能用

**优点**：
- 最少代码量实现完整 Agent Loop
- DashScope/DeepSeek 兼容端点一行切换
- 流式中间步骤开箱即用
- TypeScript 类型完美
- 社区最活跃，文档最完善

**缺点**：
- v5→v6 刚经历 breaking changes（2026 年初）
- 对 brain 现有的 `openai-compat.ts` 管道是替代而非增强
- 某些兼容端点的 `stream_options` 处理有已知 bug
- 黑盒程度高于手写——出问题时调试链更长

### 3.4 方案 C：LangChain.js / LangGraph.js

**不推荐**。原因：

1. **依赖地狱**：`@langchain/core` + `@langchain/openai` + `@langchain/langgraph` + checkpoint + sdk，总计 10-30MB
2. **抽象过厚**：Graph、Node、Edge、State、Channel、Checkpoint——对简单 agent loop 来说是杀鸡用牛刀
3. **Breaking changes 频繁**：API 不稳定，文档跟不上
4. **调试困难**：错误堆栈深、中间状态不透明
5. **与 brain 极简哲学冲突**：brain 当前只有 `dotenv` 一个生产依赖

**唯一适用场景**：需要复杂 DAG 工作流编排 + 持久化 checkpoint。brain 不需要。

### 3.5 方案 D：其他轻量方案

| 方案 | Stars | 特点 | 适用性 |
|------|-------|------|--------|
| Mastra | 22.7K | TS-first，功能全平台 | 太重，"瑞士军刀陷阱" |
| OpenAI Agents JS | 2.6K | 官方出品，handoffs + guardrails | 还在 v0.8.x，绑定 OpenAI 生态 |
| Strands (AWS) | 559 | 轻量，Bedrock + OpenAI | TS 版还是 preview |

**均不推荐**。要么太新不稳定，要么绑定特定生态，要么功能过重。

### 3.6 决策矩阵

按 brain 实际需求加权打分（满分 10）：

| 维度（权重） | A: 手写 | B: Vercel AI SDK | C: LangGraph | D: 其他 |
|-------------|--------|-----------------|-------------|--------|
| 兼容端点 (25%) | 10 | 9 | 7 | 5-7 |
| 依赖轻量 (20%) | 10 | 8 | 3 | 5-8 |
| 流式输出 (20%) | 4 | 10 | 7 | 7 |
| 可控性 (15%) | 10 | 7 | 6 | 5-6 |
| 社区成熟 (10%) | 3 | 9 | 8 | 3-6 |
| 开发效率 (10%) | 5 | 9 | 5 | 7-8 |
| **加权总分** | **7.4** | **8.6** | **5.8** | **5.5-6.8** |

---

## 4. 工具系统设计

### 4.1 工具接口定义

借鉴 Claude Code 的声明式设计 + OpenHarness 的 Schema 自描述，推荐用 **Zod + 行为标记**：

```typescript
import { z } from 'zod';

interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  // === 身份 ===
  name: string;
  description: string;

  // === Schema ===
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;

  // === 行为声明（借鉴 Claude Code） ===
  isReadOnly: boolean;           // 只读工具可并发执行
  isDestructive: boolean;        // 破坏性操作需确认
  maxConcurrency: number;        // 最大并发数（默认 1）
  timeoutMs: number;             // 超时时间

  // === 安全 ===
  requiredPermissions: string[]; // 所需权限标签
  rateLimit?: {                  // 速率限制
    maxCalls: number;
    windowMs: number;
  };

  // === 执行 ===
  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
}
```

### 4.2 工具注册与发现

```typescript
class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void { ... }
  get(name: string): ToolDefinition | undefined { ... }
  list(): ToolDefinition[] { ... }

  // 生成 OpenAI function calling 格式
  toOpenAITools(): OpenAI.ChatCompletionTool[] {
    return [...this.tools.values()].map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.inputSchema),
      },
    }));
  }
}
```

### 4.3 内置工具清单（Phase 1）

| 工具 | 类型 | 描述 |
|------|------|------|
| `search_memory` | 只读 | 在记忆库中搜索相关信息 |
| `list_memories` | 只读 | 列出指定分类的记忆条目 |
| `get_experience` | 只读 | 查询历史经验流 |
| `update_memory` | 写操作 | 添加/修改记忆条目 |
| `run_diagnosis` | 只读 | 运行自进化诊断 |
| `apply_patch` | 写操作 | 应用热补丁 |
| `web_search` | 只读 | 网络搜索（可选，通过 MCP 桥接） |
| `send_message` | 写操作 | 发送飞书消息（通过 MCP 桥接） |

### 4.4 安全边界

```typescript
// 工具白名单（默认只开放只读工具）
const DEFAULT_ALLOWED = ['search_memory', 'list_memories', 'get_experience', 'run_diagnosis'];

// 需要显式授权的工具
const REQUIRES_AUTH = ['update_memory', 'apply_patch', 'send_message'];

// 速率限制
const RATE_LIMITS = {
  search_memory: { maxCalls: 10, windowMs: 60_000 },
  web_search:    { maxCalls: 3,  windowMs: 60_000 },
  send_message:  { maxCalls: 5,  windowMs: 300_000 },
};

// 总步数限制
const MAX_AGENT_STEPS = 10;

// 总 token 预算
const MAX_TOTAL_TOKENS = 50_000;
```

---

## 5. MCP 桥接可行性

### 5.1 brain 作为 MCP Server（暴露工具给外部 Agent）

**场景**：Claude Code、Cursor 等外部 Agent 通过 MCP 协议调用 brain 的记忆检索、自进化等能力。

**实现复杂度**：中等（~200 行）

```typescript
// 方案：用 @modelcontextprotocol/sdk 的 Server 类
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({ name: 'mycc-brain', version: '0.4.0' }, {
  capabilities: { tools: {} },
});

server.setRequestHandler('tools/list', async () => ({
  tools: [
    { name: 'search_memory', description: '...', inputSchema: { ... } },
    { name: 'run_diagnosis', description: '...', inputSchema: { ... } },
  ],
}));

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  const result = await toolRegistry.get(name)?.execute(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

// 启动（Stdio 传输，Claude Code 可直接调用）
const transport = new StdioServerTransport();
await server.connect(transport);
```

**配置方式**（用户侧 `~/.claude/settings.json`）：

```json
{
  "mcpServers": {
    "mycc-brain": {
      "command": "node",
      "args": ["/path/to/mycc-brain/src/mcp-server.ts"],
      "env": { "BRAIN_DATA_DIR": "/path/to/data" }
    }
  }
}
```

### 5.2 brain 作为 MCP Client（调用外部 MCP Server）

**场景**：brain 的 Agent Loop 中调用飞书 MCP（发消息、读日历）、文件系统 MCP 等外部工具。

**实现复杂度**：中等（~150 行）

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

class MCPBridge {
  private clients = new Map<string, Client>();

  async connect(name: string, command: string, args: string[]): Promise<void> {
    const transport = new StdioClientTransport({ command, args });
    const client = new Client({ name: 'mycc-brain', version: '0.4.0' }, {});
    await client.connect(transport);
    this.clients.set(name, client);
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>) {
    const client = this.clients.get(serverName);
    return client?.callTool({ name: toolName, arguments: args });
  }

  async listTools(serverName: string) {
    const client = this.clients.get(serverName);
    return client?.listTools();
  }
}
```

### 5.3 两个方向对比

| 维度 | brain 作为 MCP Server | brain 作为 MCP Client |
|------|----------------------|----------------------|
| 复杂度 | ~200 行 | ~150 行 |
| 依赖 | `@modelcontextprotocol/sdk` (~500KB) | 同左 |
| 价值 | 让 Claude Code 直接用 brain 的记忆 | 让 brain 的 Agent Loop 调外部工具 |
| 优先级 | **Phase 1**（立即有用） | **Phase 2**（Agent Loop 稳定后） |
| 风险 | 低（只暴露只读工具） | 中（需要管理子进程生命周期） |

### 5.4 推荐路径

```
Phase 1: brain 作为 MCP Server（Stdio 传输）
  → Claude Code 可以直接 search_memory、run_diagnosis
  → 零改动现有 brain-api.ts

Phase 2: brain 的 Agent Loop 内置 MCP Client
  → Agent 执行工具时，除了内置工具，还可以调 feishu-mcp 等
  → 工具注册表统一管理内置工具 + MCP 工具（借鉴 Claude Code 的 assembleToolPool）

Phase 3: brain 作为 HTTP MCP Server
  → 升级到 Streamable HTTP 传输（SSE）
  → 支持远程 Agent 调用（不限于本机 Stdio）
```

---

## 6. 推荐方案

### 6.1 最终推荐：A+B 混合方案

> **核心循环手写（方案 A），流式处理用 Vercel AI SDK（方案 B 的 provider 层）**

**理由**：

1. **Agent Loop 手写**：brain 的循环逻辑需要深度定制（记忆注入、自进化触发、经验流记录），框架的 `generateText` 无法满足这些钩子需求。手写才能在每一步插入 brain 特有的逻辑。

2. **Provider 层用 `@ai-sdk/openai`**：不用 Vercel 的 `generateText`/`streamText`，只用它的 provider 适配层来简化 DashScope/DeepSeek 的接入和流式解析。或者更极致：**连 provider 也不用，直接用原生 fetch + 自己的 SSE 解析**（brain 已有 `openai-compat.ts`）。

3. **吸收三项目精华**：
   - 从 Claude Code Source 借鉴：**工具行为声明 + 读写分离并发 + 渐进错误恢复**
   - 从 Harness 借鉴：**渐进披露 + Eval 标准化 + 文件通信规范**
   - 从 OpenHarness 借鉴：**Zod Schema 自描述 + 标准化工具执行管线**

**与参考项目的对标**：

| 能力 | Claude Code | Harness | OpenHarness | **brain 方案** |
|------|------------|---------|-------------|---------------|
| Agent Loop | Async Generator | 无 | While + asyncio | **While + 流式** |
| 工具并发 | StreamingToolExecutor | N/A | asyncio.gather | **读写分离 + Promise.all** |
| 工具定义 | Zod + 行为声明 | Markdown | Pydantic | **Zod + 行为标记** |
| 上下文管理 | 四级压缩 | 渐进披露 | 无 | **步数限制 + token 预算** |
| MCP | 6 种传输 | 无 | 基本 Client | **Stdio Server + Client** |
| 记忆集成 | MEMORY.md | Skill Reference | MEMORY.md | **四层检索 + 经验流** (领先) |
| 自进化 | 无 | Eval 标准化 | 无 | **诊断→修复→补丁** (领先) |

**brain 的局部领先点**：
- 记忆系统（四层检索 + 经验流反哺 + 向量语义）—— 三个项目都只有 flat file 记忆
- 自进化引擎（诊断→修复→补丁→审计）—— 三个项目都没有
- 极简依赖（dotenv only）—— OpenHarness 最轻也有十几个依赖

### 6.2 依赖选择

```json
{
  "dependencies": {
    "dotenv": "^16.4.0",
    "zod": "^3.23.0"
  },
  "optionalDependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

**新增依赖说明**：
- `zod`（~60KB）：工具 Schema 定义 + 输入验证，TypeScript 生态标准
- `@modelcontextprotocol/sdk`（~500KB，可选）：MCP Server/Client，Phase 1 用

**不引入的**：
- `openai` 包：brain 已有 `openai-compat.ts`，用原生 fetch 更轻
- `ai` (Vercel)：Agent Loop 手写，不需要框架
- LangChain 全家桶：过重

### 6.3 实施路线

```
Phase 1（1-2 天）: 最小 Agent Loop
  - 新增 src/services/agent-loop.ts（核心循环）
  - 新增 src/services/tool-registry.ts（工具注册表）
  - 新增 src/tools/（内置工具目录）
  - 改造 brain-api.ts（在转发前插入 agent loop 判断）

Phase 2（1-2 天）: MCP Server
  - 新增 src/mcp-server.ts（Stdio 传输）
  - 暴露 search_memory、run_diagnosis 等只读工具

Phase 3（2-3 天）: 流式 Agent Loop
  - 升级 agent-loop.ts 支持 SSE 流式
  - 中间步骤（tool_calls、tool_results）也通过 SSE 推送

Phase 4（1-2 天）: MCP Client 桥接
  - 新增 src/services/mcp-bridge.ts
  - Agent Loop 中可调用外部 MCP 工具（feishu-mcp 等）
```

---

## 7. 最小 POC 代码骨架

### 7.1 工具注册表 (`src/services/tool-registry.ts`)

```typescript
import { z } from 'zod';

// === 类型定义 ===

export interface ToolContext {
  brainRoot: string;
  userId?: string;
  conversationId?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly isReadOnly: boolean;
  readonly timeoutMs: number;
  readonly rateLimit?: { readonly maxCalls: number; readonly windowMs: number };
  readonly execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
}

// === 注册表 ===

export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, ToolDefinition>;
  private readonly callCounts = new Map<string, { count: number; windowStart: number }>();

  constructor(tools: readonly ToolDefinition[]) {
    const map = new Map<string, ToolDefinition>();
    for (const tool of tools) {
      map.set(tool.name, tool);
    }
    this.tools = map;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }

  // 生成 OpenAI function calling 格式
  toOpenAITools(): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: unknown };
  }> {
    return [...this.tools.values()].map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.inputSchema),
      },
    }));
  }

  // 速率限制检查
  checkRateLimit(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool?.rateLimit) return true;

    const now = Date.now();
    const entry = this.callCounts.get(name);

    if (!entry || now - entry.windowStart > tool.rateLimit.windowMs) {
      this.callCounts.set(name, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= tool.rateLimit.maxCalls) return false;

    this.callCounts.set(name, { ...entry, count: entry.count + 1 });
    return true;
  }
}

// Zod → JSON Schema 简易转换（生产可用 zod-to-json-schema 包）
function zodToJsonSchema(schema: z.ZodType): unknown {
  // 简化实现，生产环境用 zod-to-json-schema
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodType);
      if (!(value instanceof z.ZodOptional)) required.push(key);
    }

    return { type: 'object', properties, required };
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema(schema.element) };
  }
  return { type: 'string' }; // fallback
}
```

### 7.2 Agent Loop (`src/services/agent-loop.ts`)

```typescript
import type { ToolRegistry, ToolContext, ToolDefinition } from './tool-registry.js';

// === 类型 ===

interface Message {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string | null;
  readonly tool_calls?: readonly ToolCall[];
  readonly tool_call_id?: string;
}

interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

interface AgentLoopOptions {
  readonly messages: readonly Message[];
  readonly model: string;
  readonly apiBase: string;
  readonly apiKey: string;
  readonly toolRegistry: ToolRegistry;
  readonly toolContext: ToolContext;
  readonly maxSteps?: number;         // 默认 10
  readonly maxTotalTokens?: number;   // 默认 50000
  readonly onStepComplete?: (step: StepResult) => void;
}

interface StepResult {
  readonly stepNumber: number;
  readonly assistantMessage: Message;
  readonly toolResults: readonly Message[];
  readonly tokensUsed: number;
}

interface AgentLoopResult {
  readonly finalMessage: Message;
  readonly steps: readonly StepResult[];
  readonly totalTokens: number;
}

// === 核心循环 ===

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    model, apiBase, apiKey, toolRegistry, toolContext,
    maxSteps = 10,
    maxTotalTokens = 50_000,
    onStepComplete,
  } = options;

  const messages: Message[] = [...options.messages];
  const tools = toolRegistry.toOpenAITools();
  const steps: StepResult[] = [];
  let totalTokens = 0;

  for (let step = 0; step < maxSteps; step++) {
    // --- 1. 调用上游 LLM ---
    const response = await callLLM({ messages, model, apiBase, apiKey, tools });
    totalTokens += response.usage?.total_tokens ?? 0;

    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    // --- 2. 无 tool_calls → 结束 ---
    if (!assistantMsg.tool_calls?.length) {
      return { finalMessage: assistantMsg, steps, totalTokens };
    }

    // --- 3. 执行工具（读写分离并发） ---
    const toolResults = await executeToolCalls(
      assistantMsg.tool_calls,
      toolRegistry,
      toolContext,
    );
    messages.push(...toolResults);

    // --- 4. 记录步骤 ---
    const stepResult: StepResult = {
      stepNumber: step + 1,
      assistantMessage: assistantMsg,
      toolResults,
      tokensUsed: response.usage?.total_tokens ?? 0,
    };
    steps.push(stepResult);
    onStepComplete?.(stepResult);

    // --- 5. Token 预算检查 ---
    if (totalTokens >= maxTotalTokens) {
      // 强制结束，让模型生成最终回复（不带 tools）
      const finalResponse = await callLLM({
        messages: [
          ...messages,
          { role: 'system', content: 'Token budget exceeded. Provide a final summary.' },
        ],
        model, apiBase, apiKey, tools: [],
      });
      return {
        finalMessage: finalResponse.choices[0].message,
        steps,
        totalTokens: totalTokens + (finalResponse.usage?.total_tokens ?? 0),
      };
    }
  }

  // 超过 maxSteps，强制结束
  const lastMsg = messages[messages.length - 1];
  return { finalMessage: lastMsg, steps, totalTokens };
}

// === 工具执行（借鉴 Claude Code 的读写分离并发） ===

async function executeToolCalls(
  toolCalls: readonly ToolCall[],
  registry: ToolRegistry,
  context: ToolContext,
): Promise<Message[]> {
  // 分组：只读工具并发，写操作顺序执行
  const readOnly: ToolCall[] = [];
  const writeOps: ToolCall[] = [];

  for (const tc of toolCalls) {
    const tool = registry.get(tc.function.name);
    if (tool?.isReadOnly) {
      readOnly.push(tc);
    } else {
      writeOps.push(tc);
    }
  }

  const results: Message[] = [];

  // 只读工具并发执行
  if (readOnly.length > 0) {
    const readResults = await Promise.all(
      readOnly.map(tc => executeSingleTool(tc, registry, context)),
    );
    results.push(...readResults);
  }

  // 写操作顺序执行
  for (const tc of writeOps) {
    const result = await executeSingleTool(tc, registry, context);
    results.push(result);
  }

  return results;
}

async function executeSingleTool(
  toolCall: ToolCall,
  registry: ToolRegistry,
  context: ToolContext,
): Promise<Message> {
  const { name, arguments: argsStr } = toolCall.function;
  const tool = registry.get(name);

  if (!tool) {
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({ error: `Unknown tool: ${name}` }),
    };
  }

  // 速率限制检查
  if (!registry.checkRateLimit(name)) {
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({ error: `Rate limit exceeded for ${name}` }),
    };
  }

  try {
    const args = JSON.parse(argsStr);
    const validated = tool.inputSchema.parse(args);

    // 带超时执行
    const result = await Promise.race([
      tool.execute(validated, context),
      timeout(tool.timeoutMs, `Tool ${name} timed out after ${tool.timeoutMs}ms`),
    ]);

    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify(result),
    };
  } catch (err) {
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

// === LLM 调用（复用 brain 现有的 fetch 模式） ===

async function callLLM(params: {
  messages: readonly Message[];
  model: string;
  apiBase: string;
  apiKey: string;
  tools: unknown[];
}): Promise<{ choices: Array<{ message: Message }>; usage?: { total_tokens: number } }> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    stream: false,
  };

  if (params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${params.apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }

  return res.json();
}

// === 工具函数 ===

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(message)), ms),
  );
}
```

### 7.3 示例工具 (`src/tools/search-memory.ts`)

```typescript
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../services/tool-registry.js';
import { loadBrainContext } from '../services/brain-context.js';

export const searchMemoryTool: ToolDefinition = {
  name: 'search_memory',
  description: '在 cc 的记忆库中搜索相关信息。输入一个查询关键词，返回匹配的记忆条目。',
  inputSchema: z.object({
    query: z.string().describe('搜索关键词或问题'),
    maxResults: z.number().optional().describe('最大返回条数，默认 5'),
  }),
  isReadOnly: true,
  timeoutMs: 5_000,
  rateLimit: { maxCalls: 10, windowMs: 60_000 },

  async execute(input, ctx: ToolContext) {
    const result = await loadBrainContext(input.query, ctx.brainRoot);
    const items = result.items.slice(0, input.maxResults ?? 5);
    return {
      totalFound: result.items.length,
      items: items.map(item => ({
        category: item.category,
        content: item.content,
        score: item.score,
        source: item.source,
      })),
    };
  },
};
```

### 7.4 brain-api.ts 集成点

```typescript
// 在 handleChatCompletions() 中新增 agent 模式判断
// 当路由配置 agentMode: true 时，走 Agent Loop 而非直接转发

if (route.agentMode) {
  const result = await runAgentLoop({
    messages: enrichedMessages,
    model: route.model,
    apiBase: route.apiBase,
    apiKey: route.apiKey,
    toolRegistry: globalToolRegistry,
    toolContext: { brainRoot: config.dataDir, conversationId },
    maxSteps: route.maxAgentSteps ?? 10,
    onStepComplete: (step) => {
      // 记录到经验流
      recordAgentStep(step, conversationId);
    },
  });

  // 返回最终响应
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: generateId(),
    object: 'chat.completion',
    choices: [{ index: 0, message: result.finalMessage, finish_reason: 'stop' }],
    usage: { total_tokens: result.totalTokens },
  }));
  return;
}
```

---

## 附录 A：参考资料

| 资料 | 链接 | 借鉴点 |
|------|------|--------|
| Claude Code Source | github.com/Hahaxiong838383/claude-code-source | Agent Loop + StreamingToolExecutor + 四级压缩 |
| revfactory/harness | github.com/revfactory/harness | 6 种架构模式 + Eval 标准化 + 渐进披露 |
| HKUDS/OpenHarness | github.com/HKUDS/OpenHarness | 极简 Agent Loop + Pydantic Schema + Hook 热重载 |
| Vercel AI SDK v6 | sdk.vercel.ai | Provider 适配 + 流式 API 设计参考 |
| OpenAI Codex CLI | github.com/openai/codex | agent-loop.ts 生产级参考 |
| MCP Specification | modelcontextprotocol.io | Server/Client SDK 使用 |

## 附录 B：决策记录

| 决策 | 选择 | 放弃 | 理由 |
|------|------|------|------|
| Agent Loop | 手写 While 循环 | Vercel AI SDK / LangGraph | 最大可控性，与 brain 极简哲学一致，便于插入记忆/进化钩子 |
| 工具定义 | Zod Schema + 行为标记 | 手写 JSON Schema / Pydantic | TS 生态标准，类型安全，自动生成 OpenAI 格式 |
| 工具并发 | 读写分离 + Promise.all | 全串行 / 全并行 | 借鉴 Claude Code，安全且高效 |
| MCP 方向 | 先 Server 后 Client | 同时双向 / 只做 Client | Server 端立即有用（Claude Code 可调用），风险最低 |
| 上游调用 | 原生 fetch | openai 包 / Vercel provider | brain 已有 openai-compat.ts，零新增依赖 |
| 新增依赖 | zod + @modelcontextprotocol/sdk | ai / langchain / openai | 最小化依赖，zod 是刚需，MCP SDK 是可选 |
