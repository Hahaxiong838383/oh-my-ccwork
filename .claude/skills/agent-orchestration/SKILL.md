---
name: agent-orchestration
description: Agent 编排模式 - 基于 ruflo(★19.3k) + oh-my-claudecode(★8.6k) + deer-flow(★25k) 的多智能体协同设计。触发词："多Agent"、"编排"、"swarm"、"agent协作"
---

# Agent 编排模式

> 参考项目：ruvnet/ruflo ★19.3k + Yeachan-Heo/oh-my-claudecode ★8.6k + bytedance/deer-flow ★25k

## 三种主流编排模式

### 模式1：Swarm（蜂群）
- **特点**：Agent 之间直接通信，动态分工
- **适用**：任务不固定、需要自适应分配的场景
- **ruflo 实现**：Distributed Swarm Intelligence，Agent 投票决策

### 模式2：Team（团队）
- **特点**：角色固定，Leader 分发任务给 Worker
- **适用**：任务结构清晰、角色分工明确的场景
- **OMC 实现**：`/team N 任务` — N 个 Agent 各司其职

## cc 的编排选择

| 场景 | 推荐模式 | 工具 |
|------|---------|------|
| IPO 报告（固定角色：采集/分析/写作） | Team | OMC `/team` |
| 代码审查（并行独立） | Swarm | OMC `/swarm` |
| 复杂任务规划 | 单 Agent + Codex 验证 | Claude + Codex CLI |
| 全自动工作流 | Autopilot | OMC `autopilot:` |

## ruflo 的关键设计（值得借鉴）

### 1. RAG + Agent 集成
Agent 执行前先检索相关记忆/文档，避免幻觉：
```
用户请求 → 语义检索(relevant context) → 注入 prompt → Agent 执行
```

### 2. MCP Native 支持
ruflo 原生支持 MCP server，Agent 可以直接调用：
- 飞书 MCP（lark-mcp）
- 本地工具 MCP（文件/代码执行）

### 3. 失败降级
单个 Agent 失败不影响整体：
```
Agent-A 超时 → 标记失败 → 其他 Agent 接管 → 记录失败原因
```

## cc 可直接用的编排命令

```bash
# OMC 团队模式（固定角色）
/team 3 "分析 IPO 市场并生成报告"

# OMC 并行模式（独立任务）
/swarm 4 "并行修复所有 TypeScript 类型错误"

# OMC 全自动模式
autopilot: 完成 github-radar 数据分析并发飞书

# OMC 持久模式（必须完成）
ralph: 修复飞书发送失败的 bug，不成功不停止
```

### 模式3：Harness（指挥官）★ deer-flow 新增
- **特点**：主 Agent（Harness）统一分配资源，根据任务时长动态派发 subagent
- **适用**：需要数分钟到数小时的复杂长任务，任务内部有研究→执行→产出的层次
- **deer-flow 实现**：研究(deep-research) → 编码(coding) → 创作(creation) 三阶段流水线
- **核心机制**：
  - **任务时长感知**：快任务（秒级）vs 慢任务（分钟/小时级）走不同调度路径
  - **沙箱隔离**：每个 subagent 在独立沙箱中运行，失败不污染主流程
  - **步骤间记忆**：每个阶段的输出作为结构化记忆注入下一阶段，非简单文件传递

```
任务输入
  ↓
Harness 评估任务时长 + 分解阶段
  ↓
[研究 subagent] → 结构化记忆 → [执行 subagent] → 结构化记忆 → [输出 subagent]
  ↓                             （沙箱隔离）
最终产出
```

## cc 的编排选择

| 场景 | 推荐模式 | 工具 |
|------|---------|------|
| IPO 报告（固定角色：采集/分析/写作） | Team | OMC `/team` |
| 代码审查（并行独立） | Swarm | OMC `/swarm` |
| 复杂任务规划 | 单 Agent + Codex 验证 | Claude + Codex CLI |
| 全自动工作流 | Autopilot | OMC `autopilot:` |
| **深度研究+执行（长任务）** | **Harness** | **手动分阶段 + /tmp 结构化传递** |

## ruflo 的关键设计（值得借鉴）

### 1. RAG + Agent 集成
Agent 执行前先检索相关记忆/文档，避免幻觉：
```
用户请求 → 语义检索(relevant context) → 注入 prompt → Agent 执行
```

### 2. MCP Native 支持
ruflo 原生支持 MCP server，Agent 可以直接调用：
- 飞书 MCP（lark-mcp）
- 本地工具 MCP（文件/代码执行）

### 3. 失败降级
单个 Agent 失败不影响整体：
```
Agent-A 超时 → 标记失败 → 其他 Agent 接管 → 记录失败原因
```

## deer-flow 的关键设计（新增）

### 1. 任务时长分层
```
快任务（<1min）：直接单 Agent 处理
中任务（1-10min）：Team 模式，固定角色流水线
慢任务（>10min）：Harness 模式，动态 subagent + 沙箱隔离
```

### 2. 步骤间结构化记忆
不同于简单的文件传递，deer-flow 的阶段间记忆是有 schema 的：
```json
{
  "phase": "research",
  "findings": [...],       // 研究发现，供执行阶段使用
  "constraints": [...],    // 发现的限制条件
  "next_hints": [...]      // 对下一阶段的提示
}
```
**cc 应用**：`/tmp/` 下的中间 JSON 应包含 `phase` + `findings` + `next_hints`，不只是原始数据。

### 3. 研究优先原则（Research-First）
任何复杂任务，先做研究阶段，再做执行：
```
❌ 直接执行 "帮我写一个爬虫分析竞品"
✅ 先研究（竞品有哪些？数据在哪？反爬策略？） → 再执行
```

## cc 可直接用的编排命令

```bash
# OMC 团队模式（固定角色）
/team 3 "分析 IPO 市场并生成报告"

# OMC 并行模式（独立任务）
/swarm 4 "并行修复所有 TypeScript 类型错误"

# OMC 全自动模式
autopilot: 完成 github-radar 数据分析并发飞书

# OMC 持久模式（必须完成）
ralph: 修复飞书发送失败的 bug，不成功不停止

# Harness 模式（手动实现，适合长任务）
# Step1: 研究阶段 → /tmp/research.json（含 findings + next_hints）
# Step2: 执行阶段（读取 research.json）→ /tmp/execution.json
# Step3: 输出阶段（读取 execution.json）→ 最终产出
```

## 编排的核心原则

1. **最小化 Agent 数量**：1 个 Agent 能解决的，不用 3 个
2. **任务原子化**：每个 Agent 的任务必须可以独立成功/失败
3. **共享状态用结构化 JSON**：Agent 之间通过 `/tmp/` 下的 JSON 文件交换数据，包含 `phase`/`findings`/`next_hints`
4. **结果可比较**：并行 Agent 的输出格式要一致，方便 cc 裁决
5. **按时长选模式**：快→单 Agent，中→Team，慢→Harness

## deer-flow 记忆架构（2026-03-09 新增）

deer-flow 最新版本的记忆系统值得 cc 参考的 3 个关键设计：

### 1. 六槽位时间分层记忆（≠ 平铺事实）

| 槽位 | 时间维度 | 内容 | 更新频率 |
|------|---------|------|---------|
| workContext | 当前 | 当前项目/技术栈（2-3句） | 每周 |
| personalContext | 静态 | 偏好/性格（1-2句） | 极少 |
| topOfMind | 并发 | **3-5个并发关注主题**（详细段落） | 每次会话 |
| recentMonths | 近1-3月 | 活动摘要（4-6句） | 每月 |
| earlierContext | 3-12月前 | 历史模式（3-5句） | 每季度 |
| longTermBackground | 长期 | 不变基础事实（2-4句） | 极少 |

**对 cc 的启示**：`status.md` 里的「今日焦点」改为「当前并发主题（3-5个）」，更真实反映多任务状态

### 2. 矛盾检测 + 主动删除（`factsToRemove` 模式）

deer-flow 在 LLM 更新 prompt 里包含 `factsToRemove` 字段：当新信息和旧 fact 矛盾时，LLM 直接返回要删除的 fact ID，而不是标记 `[已废弃]`。

**对 cc 的启示**：session 结束写 memory-items 时，主动对比旧条目，发现矛盾 → 直接删旧条

### 3. 事实置信度 + 自动淘汰

- 每条 fact 有 `confidence`（0-1），低于 0.7 不入库
- 上限 100 条，超出时按置信度淘汰最低分的
- cc 的 ★ 系统可对应：★★★ ≈ 0.9，★★ ≈ 0.7，★ ≈ 0.5，无标注 ≈ 0.3（考虑淘汰）

### 4. 主动上下文压缩（最新特性）

deer-flow 在长任务中主动压缩已完成子任务的上下文：
```
子任务完成 → 摘要化（压缩到 2-3 句） → offload 到文件系统 → 清出上下文空间
```

**关键数据**：context 接近 80% 时触发压缩，确保长任务不爆窗口

**对 cc 的启示**：
- 长任务（如 theory-radar 多轮抓取）每阶段完成后，主动压缩并写入 `/tmp/phase-N-summary.json`
- 可使用 `/sessions compact` 命令（NanoClaw v2）

### 5. 文件系统三分区持久化

deer-flow 明确划分三个存储路径：
| 路径 | 用途 | cc 对应 |
|------|------|---------|
| `/mnt/user-data/uploads/` | 用户输入文件 | `1-Inbox/` |
| `/mnt/user-data/workspace/` | 工作目录（中间产物） | `/tmp/` 或 `tasks/` |
| `/mnt/user-data/outputs/` | 最终交付物 | `4-Assets/` 或 `2-Projects/` |

### 6. 子 Agent 完全上下文隔离

deer-flow 的每个子 Agent 运行在独立上下文中：
- **无父 Agent 上下文可见**：子 Agent 只看自己的任务 + 通过文件传递的结构化数据
- **无兄弟 Agent 可见**：并行 Agent 之间无直接通信，通过共享文件汇总
- **对 cc 的启示**：避免在子 Agent prompt 中传递整个对话历史，只传任务定义 + 结构化 JSON 上下文

---

## wshobson/agents 模型分层策略（★30.8k）

wshobson 的 112 专业 Agent 按成本/性能分 3 层：

| 层级 | 模型 | 适用 Agent | cc 对应 |
|------|------|-----------|---------|
| Tier 1 | Opus 4.6 | 架构、安全、复杂审查 | planner, architect, security-reviewer |
| Tier 2 | 继承上下文 | 标准开发工作 | code-reviewer, tdd-guide, debugger |
| Tier 3 | Sonnet 4.6 | 文档、基础设施、常规 | doc-updater, refactor-cleaner |

**核心原则**：用最便宜的模型完成任务。Tier 1 仅在需要深度推理时使用。

### 新增 Agent（来自 wshobson 深度分析，2026-03-10）

| Agent | 用途 | 状态 |
|-------|------|------|
| ai-engineer | LLM/RAG 应用构建、向量检索管道（Opus 4.6） | ✅ 已创建 |
| prompt-engineer | Prompt 优化、CoT/ToT 推理链设计 | ✅ 已创建 |
| incident-responder | P0-P3 事故响应 + 飞书告警 | ✅ 已创建 |
| observability-engineer | 监控/SLO/告警体系（Node.js + mycc 专项） | ✅ 已创建 |
| data-engineer | ETL 管道（黄金/IPO 数据场景） | 待创建（中优先级） |
| frontend-developer | mycc-web React/Next.js 专项 | 待创建（中优先级） |
| architect-review | 架构批判性评审（与 architect 配合） | 待创建（中优先级） |

---

## 与 cc 现有工作流的集成点

- `github-radar` 的 Step2 分析 → 可以用 OMC swarm 并行分析各分类
- IPO 报告生成 → 可以用 OMC team 角色化（采集/分析/写作/发送）
- 复杂 bug 修复 → ralph 模式持久运行直到成功
- **深度研究任务**（如竞品分析、技术调研）→ Harness 模式，研究 → 执行 → 产出三阶段
