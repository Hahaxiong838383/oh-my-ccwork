# 多智能体协同规则

> 适用：cc (Claude) + codex (OpenAI) + gemini (Google)
> 更新：2026-03-11 — 从理想化四层闭环精简为实用版

---

## 日常模式（默认）

### 路由规则

| 任务类型 | 路由 | 示例 |
|---------|------|------|
| 代码实现、批量改仓库、重构 | → codex | "实现登录功能"、"重构模块" |
| 调研、知识库同步、论文抓取 | → gemini | "调研 XX 技术"、"同步到 FUTURUS" |
| 规划、决策、编排、日常问答 | → cc | "设计架构"、"帮我看看" |

路由由 `autoRouteEngine()` 自动判断，也可手动指定引擎。

### 强制规则（仅 2 条）

1. **大任务（预估 >10 分钟）必须拆分** — 分发给 codex/gemini 并行执行，cc 只编排不硬啃
2. **cc 不负责批量实现** — cc 做规划和关键决策，写代码交给 codex

### 角色定位

| 角色 | 职责 | 不做什么 |
|------|------|---------|
| cc (Claude) | 想清楚、做决策、编排任务 | 不写大段样板代码 |
| codex (OpenAI) | 写代码、改仓库、跑测试 | 不做架构决策 |
| gemini (Google) | 搜资料、写报告、找问题 | 不争主实现 |

### 信息黑板（GWT — Global Workspace Theory，2026-03-31 起）

三引擎通过 `0-System/blackboard.md` 共享实时状态：

| 功能 | 说明 |
|------|------|
| **注意力状态** | cc 在接收任务时更新聚焦/负载/选择原因（AST 元模型） |
| **引擎状态** | 每个引擎完成任务后更新自己的行（当前任务/状态/时间） |
| **共享上下文** | 引擎间传递的实时信息（避免信息在串行调度中丢失） |
| **待接力任务** | A 引擎完成后需要 B 引擎接力的任务 |

**cc 在分发任务前**：更新黑板的引擎状态和注意力状态。
**codex/gemini 完成任务后**：更新自己的行 + 写入共享上下文。

### 简单问答

直接回，不起 Agent，不调外部工具。

---

## 正式项目模式（按需启用）

> 仅用于大型正式项目（预估 >1 天），日常任务不需要。

启用条件：用户明确说"启动正式项目模式"或任务规模明显需要。

### 四层闭环流程

```
Layer 1 规格（cc 输出 SPEC.md + AC.md）
      ↓
Layer 2 并行产出（codex 主实现 + gemini 对照/补边界）
      ↓
Layer 3 自动化验收（测试 + lint + type check）
      ↓
Layer 4 裁决（cc 审查 + 合并 + REVIEW.md）
```

### 正式模式额外规则

1. 没有 AC 不允许生成代码
2. 并行输出必须可比较
3. 所有验证必须自动化
4. 每个阶段创建 git checkpoint

### 回滚点

```bash
git add -A && git commit -m "checkpoint: 描述"
git reset --soft HEAD~1
```

---

## MCP 调用方式

```typescript
// Codex（MCP server: "x"）
mcp__x__ask_codex({
  agent_role: "executor",
  prompt: "实现用户登录功能",
  working_directory: "/Users/rayman.chen/mycc",
  context_files: ["multi-agent/context/SPEC.md"]
})

// Gemini（MCP server: "g"）
mcp__g__ask_gemini({
  agent_role: "scientist",
  prompt: "生成边界测试用例",
  files: ["multi-agent/context/SPEC.md"]
})
```

---

## 飞书三机器人群聊

- **群 chat_id**: `oc_f4a09ffbd709b39c917b927ecb9d96b6`
- cc (FEISHU1) + codex (FEISHU4) + gemini (FEISHU5)
- 发群消息用 `open-feishu-mcp` 的 `send_message`
- 三机器人均可调用飞书 MCP 工具

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `multi-agent/context/` | SPEC/AC/ARCH 模板（正式项目模式用） |
| `.claude/skills/agent-orchestration/` | Agent 编排 skill |
| `.claude/skills/mycc/scripts/src/channels/feishu.ts` | 飞书通道（含 autoRouteEngine） |
