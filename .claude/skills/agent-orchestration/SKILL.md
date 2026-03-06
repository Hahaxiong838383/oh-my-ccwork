---
name: agent-orchestration
description: Agent 编排模式 - 基于 ruflo(★19.3k) + oh-my-claudecode(★8.6k) 的多智能体协同设计。触发词："多Agent"、"编排"、"swarm"、"agent协作"
---

# Agent 编排模式

> 参考项目：ruvnet/ruflo ★19.3k + Yeachan-Heo/oh-my-claudecode ★8.6k

## 两种主流编排模式

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

## 编排的核心原则

1. **最小化 Agent 数量**：1 个 Agent 能解决的，不用 3 个
2. **任务原子化**：每个 Agent 的任务必须可以独立成功/失败
3. **共享状态用文件**：Agent 之间通过 `/tmp/` 下的 JSON 文件交换数据
4. **结果可比较**：并行 Agent 的输出格式要一致，方便 cc 裁决

## 与 cc 现有工作流的集成点

- `github-radar` 的 Step2 分析 → 可以用 OMC swarm 并行分析各分类
- IPO 报告生成 → 可以用 OMC team 角色化（采集/分析/写作/发送）
- 复杂 bug 修复 → ralph 模式持久运行直到成功
