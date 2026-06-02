# MULTI-AGENT: 多智能体协同

| 字段 | 值 |
|------|-----|
| 优先级 | P1（核心规则在主文件）/ P2（详情在此） |
| 权重 | 0.75 |
| 是否常用 | 常用 |
| 是否必选 | 可选 |
| 触发条件 | 任务预估 >10 分钟 / 涉及代码批量实现 / 跨域调研 |

## 强制规则（已在 CLAUDE.md P1 表）

1. 大任务（>10 分钟）必须拆分，分发给 grok/codex/gemini 并行执行
2. cc 不负责批量实现，做规划和关键决策

## 角色分工

| 角色 | 定位 | 调用入口 |
|------|------|---------|
| cc (Claude) | 规划、决策、编排、终验、commit/push | — |
| **grok (xAI)** | **写代码（默认）/ 快速迭代 / 批量改（grok-build，512k）** | `~/.grok/bin/grok --prompt-file … -m grok-build --no-subagents`（CLI 直调） |
| **grok-4.3 满血档 (omp/xAI)** | **超长上下文（>512k 到 1M）/ 需 reasoning effort 分档（minimal–xhigh）/ 高 stake 实现备选** | `~/.bun/bin/omp -p --model xai-oauth/grok-4.3 --auto-approve`（CLI 直调，走 SuperGrok 订阅 OAuth） |
| codex (OpenAI) | 写代码（高 stake/已验证链路）/ 对抗审查 / 疑难根因 | `codex exec --full-auto`（CLI 直调） |
| gemini (Google) | 搜资料、写报告、学术评审、调研 | `gemini -p`（CLI 直调） |
| hermes (Nous) | 多平台消息、长时任务、非 Claude 推理 | `mcp__hermes__messages_send(...)` |

> grok / codex 模型与 effort 路由表见全局规则 [`~/.claude/rules/engine-routing.md`](file:///Users/rayman.chen/.claude/rules/engine-routing.md)。

## 路由策略

- **写码双引擎并存，cc 按任务挑**（川哥钦定 2026-05-31）：默认 grok（`grok-build`，512k）；高 stake/对抗审查/已验证链路走 codex；**超 512k 升级到 omp/`xai-oauth/grok-4.3`（1M 上下文，2026-06-02 接入）**。高 stake 实现可 grok+codex 双发对比 / grok-build+grok-4.3 同家族不同档对比。grok-build 调用必带 `-m grok-build --no-subagents`；omp 必带 `--model xai-oauth/grok-4.3`（短名 `grok-4.3` 会被模糊匹配到 kilo gateway 出错）。
- 调研/评审走 gemini；规划/决策/编排走 cc
- 飞书机器人群聊场景：每条消息按 App ID 路由到对应引擎
- 正式项目可启用四层闭环 / Team 模式（grok 为第 4 lane），详见 [`multi-agent/RULES.md`](../../multi-agent/RULES.md)

## Why

cc 上下文有限（200K），批量代码实现会迅速吃满；grok/codex 专攻代码、gemini 专攻调研，分工后效率比 cc 单干高 3-5 倍。grok 与 codex 互为独立写码视角，高 stake 时双发对比 / 交叉对抗审查提升质量。

## 关联规则

- 引擎对应飞书 App ID 见 [`CC-IDENTITY.md`](CC-IDENTITY.md)
- codex 调用边角案例见 `~/.claude/projects/.../memory/feedback_codex_*.md`
