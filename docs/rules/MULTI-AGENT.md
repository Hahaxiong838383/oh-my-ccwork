# MULTI-AGENT: 多智能体协同

| 字段 | 值 |
|------|-----|
| 优先级 | P1（核心规则在主文件）/ P2（详情在此） |
| 权重 | 0.75 |
| 是否常用 | 常用 |
| 是否必选 | 可选 |
| 触发条件 | 任务预估 >10 分钟 / 涉及代码批量实现 / 跨域调研 |

## 强制规则（已在 CLAUDE.md P1 表）

1. 大任务（>10 分钟）必须拆分，分发给 codex/gemini 并行执行
2. cc 不负责批量实现，做规划和关键决策

## 角色分工

| 角色 | 定位 | MCP 调用 |
|------|------|---------|
| cc (Claude) | 规划、决策、编排 | — |
| codex (OpenAI) | 写代码、改仓库、跑测试 | `mcp__x__ask_codex(...)` |
| gemini (Google) | 搜资料、写报告、调研 | `mcp__g__ask_gemini(...)` |
| hermes (Nous) | 多平台消息、长时任务、非 Claude 推理 | `mcp__hermes__messages_send(...)` |

## 路由策略

- 路由由 `autoRouteEngine()` 自动判断，也可手动指定
- 飞书三机器人群聊场景：每条消息按 App ID 路由到对应引擎
- 正式项目可启用四层闭环流程，详见 [`multi-agent/RULES.md`](../../multi-agent/RULES.md)

## Why

cc 上下文有限（200K），批量代码实现会迅速吃满；codex 专攻代码，gemini 专攻调研，分工后效率比 cc 单干高 3-5 倍。

## 关联规则

- 引擎对应飞书 App ID 见 [`CC-IDENTITY.md`](CC-IDENTITY.md)
- codex 调用边角案例见 `~/.claude/projects/.../memory/feedback_codex_*.md`
