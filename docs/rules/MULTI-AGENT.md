# MULTI-AGENT: 多智能体协同

| 字段 | 值 |
|------|-----|
| 优先级 | P1（核心规则在主文件）/ P2（详情在此） |
| 权重 | 0.75 |
| 是否常用 | 常用 |
| 是否必选 | 可选 |
| 触发条件 | 任务预估 >10 分钟 / 涉及代码批量实现 / 跨域调研 |
| 当前版本 | v3（2026-06-04 整合 omp 三家订阅 + A/B 双 lane + 跨家族对抗审查）|

## 强制规则（4 条，已在 CLAUDE.md P1 表）

1. 大任务（>10 分钟）必须拆分，分发给 A/B 各 lane 并行
2. cc 不负责批量实现 / 主评审，做规划和关键决策
3. **omp 路径优先**，CLI 直调作降级 fallback（omp 崩/凭据失效逃生通道）
4. 每次调用前自报 lane + provider/model + thinking + stake + 理由

## 角色分工（v3 双 lane 架构）

### A 档：写码 Lane

| ID | 引擎 | 上下文 | 调用入口 |
|---|---|---|---|
| **A1 默认** | grok-build CLI 直调 | 512k | `~/.grok/bin/grok --prompt-file … -m grok-build --no-subagents` |
| **A2 满血/长ctx** | omp xai-oauth/grok-4.3 | 1M | `omp -p --model xai-oauth/grok-4.3 --thinking high --auto-approve` |
| **A3 高stake默认** | omp openai-codex/gpt-5.5 | 272k | `omp -p --model openai-codex/gpt-5.5 --thinking high --auto-approve` |
| **A3-fallback** | codex CLI（降级）| 同上 | `codex exec --full-auto -c model="gpt-5.5"` |
| **A4 code review** | omp openai-codex/gpt-5.4 | 400k | `omp -p --model openai-codex/gpt-5.4 --thinking high --auto-approve` |

### B 档：调研/研究/评审 Lane（v3 新增 grok / gpt 评审档）

| ID | 引擎 | 上下文 | 独特价值 | 调用入口 |
|---|---|---|---|---|
| **B1 默认** | omp gemini-3-flash-preview | 1M | Gemini 默认主力,短任务 | `omp -p --model google-gemini-cli/gemini-3-flash-preview` |
| **B2 学术深度** | omp gemini-3.1-pro-preview | 1M | gemini 风格精准,长综合 | `omp -p --model google-gemini-cli/gemini-3.1-pro-preview --thinking high` |
| **B3 顶级深度（付费）** | mycc VPS proxy gemini-3.5-flash | 1M | Vertex AI,thinking 最强 | `curl 23.226.135.149:4000` + reasoning_effort + max_tokens 65535 |
| **★ B4 grok 推理评审** | omp xai-oauth/grok-4.3 | 1M | **第一性原理推理 / 反思维定式 / 非 Google 视角** | `omp -p --model xai-oauth/grok-4.3 --thinking high` |
| **★ B5 codex 严谨评审** | omp openai-codex/gpt-5.5 或 5.4 | 272k-400k | **结构化逻辑链清晰 / 边界用例** | `omp -p --model openai-codex/gpt-5.5 --thinking high` |
| **B-fallback** | gemini CLI 直调 | 同上 | omp 不通时降级 | `gemini -m gemini-3-flash-preview -p ...` |

### C/D 档

| 角色 | 定位 | 调用入口 |
|------|------|---------|
| **cc (Claude)** | 想清楚 / 决策 / 编排 / 终验 / commit/push / 风险预警询问 | — |
| **hermes (Nous)** | 长时（>30min）/ 跨平台消息 / 异步推送 | `mcp__hermes__messages_send(...)` |

> 模型 + thinking 档详表见全局规则 [`~/.claude/rules/engine-routing.md`](file:///Users/rayman.chen/.claude/rules/engine-routing.md)。

## 路由策略（v3）

### 写码任务路由

```
任务 → 按 stake 分档:
  ├─ 普通(<300 行/单文件) → A1 grok-build (默认最便宜)
  ├─ 超 512k 上下文 / 需 reasoning effort → A2 omp grok-4.3 1M
  ├─ 高 stake (认证/支付/迁移/事故) → A3 omp openai-codex/gpt-5.5
  └─ 高 stake / 高难度(>1000 行 跨子系统 算法核心) → A 双发(A1+A3)
```

### 评审/调研任务路由

```
任务 → 按风格分档:
  ├─ 短调研 / 提取 / 分类 → B1 omp gemini-3-flash (默认免费)
  ├─ 学术综合 / 长文分析 → B2 omp gemini-3.1-pro
  ├─ 推理深度 / Why / 第一性原理 → B4 omp grok-4.3 thinking=high
  ├─ 严谨结构化 / code review → B5 omp gpt-5.5 thinking=high (单发即可)
  ├─ 顶级深度 / 批判性思考 → B3 VPS proxy 3.5-flash (付费)
  └─ 高 stake / 高难度评审 → B 三发对抗(B4+B5+B2)
```

### 三发/四发对抗触发线（川哥钦定 2026-06-04）

| Stake 档 | 写码模式 | 评审模式 | 触发判定 |
|---------|---------|---------|---------|
| **普通** | 单发 | 单发 | 默认 |
| **中等** | 单发 + 关键时双发 | 双发（B4+B2）| cc 判断 |
| **高 stake / 高难度** ★ | **A 双发**（A1+A3）+ **B 三发评审**（B4+B5+B2）| **B 三发对抗**（B4+B5+B2）| 见下方判定 |
| **顶级** ⚠️ 手动触发 | A 双发 + **B 四发**（+ B3 付费档）| B 四发 | 川哥说"大活/高难度/不能错" 或 cc 风险预警询问 |

**高 stake 判定**（自动触发三发）：认证 / 支付 / 数据迁移 / 生产事故 / 安全凭据 / 不可回滚

**高难度判定**（自动触发三发）：>1000 行 / 跨子系统 / 并发 / 算法核心 / 顶级架构变更

**顶级 stake**（手动触发 + cc 预警询问）：生产关键路径 / 资金链路 / 全表 migration / 不可回滚 + 无 staging

### 其他规则

- 飞书机器人群聊场景：每条消息按 App ID 路由到对应引擎
- 正式项目可启用 Team 模式（A+B 双 lane + cc 编排），详见 [`multi-agent/RULES.md`](../../multi-agent/RULES.md)
- omp 多 provider 接入 SOP：[`4-Assets/SOP/omp-{supergrok,chatgpt,gemini}-bypass-import.sh`](../../4-Assets/SOP/)

## Why

cc 上下文有限（200K），批量代码实现会迅速吃满；A 档专攻代码、B 档专攻调研评审，分工后效率比 cc 单干高 3-5 倍。**v3 关键升级**：omp 三家订阅同 agent.db 共存 + 跨家族并发 1.3x 加速 → B 三发对抗（grok 推理 + gpt 严谨 + gemini 学术）成为高 stake 评审标准动作，三家训练数据/偏见/推理风格不同，互补性最大。

## 关联规则

- 引擎对应飞书 App ID 见 [`CC-IDENTITY.md`](CC-IDENTITY.md)
- codex 调用边角案例见 `~/.claude/projects/.../memory/feedback_codex_*.md`
- omp 接入完整手册见 `~/.claude/projects/.../memory/project_omp_grok43.md`
- 跨家族 OAuth 旁路范式见 `~/.claude/projects/.../memory/feedback_oauth_credential_bypass_via_shared_client_id.md`
