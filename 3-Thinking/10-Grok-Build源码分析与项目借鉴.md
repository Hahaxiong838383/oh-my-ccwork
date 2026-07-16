# Grok Build 源码分析与项目借鉴

> 日期：2026-07-16  
> 来源：`xai-org/grok-build`，本地分析 commit `b189869`（`Publish harness and TUI open-source`）  
> 用途：给 Claude / Grok / Codex 共同调用的架构锚点，后续优先落到 `ai-ops-cockpit` 的 `ops-tool-runtime`。

## 一句话结论

Grok Build 不是单纯的“代码生成 CLI”，而是一个完整的终端智能体运行时：把模型、工具注册、权限、会话、记忆、MCP、技能、工作区和 TUI/headless/ACP 多入口统一成一个可审计的执行系统。

对川哥当前项目最值得借的是：**ToolBridge + Permission + Session Trace + Headless Runtime**。最短路径不是复刻整个 Grok Build，而是在 `ai-ops-cockpit` 先做一个小而硬的 `ops-tool-runtime`，把现有零散巡检/修复脚本收束成“可发现、可授权、可回放、可复用”的工具运行时。

## 源码结构与核心能力

| 模块 | 作用 | 可借鉴点 |
|---|---|---|
| `xai-grok-pager` | CLI/TUI 入口，提供 `grok` 命令、headless、ACP、agent mode、resume、memory、model、worktree 等参数 | AI Ops 可以同时支持网页入口、定时入口、人工触发入口 |
| `xai-grok-agent` | Agent 构建器与 profile 配置，决定工具集、权限模式、模型、skills、memory、hook、MCP | 把“不同项目/不同风险等级”做成 profile，而不是到处写 if |
| `xai-grok-tools` | ToolBridge 工具桥，负责工具定义、注册、调用分发、MCP/skills/gitignore/resource 管理 | `ai-ops-cockpit` 最该借：统一工具注册表和执行入口 |
| `xai-grok-shell` | 模型 turn loop：模型输出 → 工具调用 → 工具结果回填 → 继续推理 | OPS Grok 可从“问答”升级为“带证据执行循环” |
| `xai-grok-memory` | gated memory，默认不强开，使用 markdown 存储和查询 | MyJavis/LnMem 可借鉴“显式开启、可追踪、非隐式污染” |
| `xai-grok-mcp` | MCP server/client、OAuth、stdio/SSE/http transport、凭据管理 | cc-agent / multica 可借鉴外部工具接入层 |

## 运行原理

### 1. 入口层：一个 runtime，多种打开方式

Grok Build 的命令入口不是只面向 TUI。源码里同时支持：

- 交互式 TUI：人直接在终端里和 agent 对话。
- headless：无界面执行任务，适合自动化。
- ACP：让外部编辑器/客户端按协议接入。
- stdio / leader：适合被上层 orchestrator 或多 agent 系统调用。
- session resume：会话可恢复，而不是每次从零开始。

这说明它把“界面”和“执行核心”拆开了：TUI 只是其中一个壳，真正核心是后端 agent runtime。

### 2. AgentBuilder：把模型、工具、权限、上下文装配成一个 agent

`AgentBuilder` 的职责是装配，而不是直接执行任务：

- 读取配置与 agent profile。
- 选择模型与推理参数。
- 注入默认工具集、MCP 工具、skills、hook、memory。
- 生成工具定义和 prompt context。
- 最终交给 shell/session 层执行。

这个设计对 AI Ops 很重要：不同生产项目应该是不同 profile，例如：

- `readonly-inspect`：只能读状态、日志摘要、健康接口。
- `controlled-repair`：必须 action token + 确认词 + 冷却。
- `deploy-operator`：高风险，默认不开放或只给 cc/人工。

### 3. ToolBridge：工具不是脚本清单，而是可治理的能力层

Grok Build 的 `ToolBridge` 统一处理：

- 工具定义暴露给模型。
- 工具调用参数解析。
- 本地工具 / MCP 工具 / skills 工具统一分发。
- gitignore、资源、项目文件边界。
- 执行结果回填给模型。

这就是 `ops-tool-runtime` 的核心范式：不要让 Grok 直接“知道脚本怎么跑”，而是让 Grok 看到受控工具，例如：

- `inspect_project_health(projectId)`
- `read_allowed_file(projectId, fileId)`
- `run_controlled_action(projectId, actionId, token, confirmText)`
- `collect_evidence(projectId, scope)`

### 4. Turn Loop：智能体的最小闭环

Grok Build 的执行循环可以抽象成：

```text
用户目标
  ↓
构建 prompt context + tool definitions
  ↓
模型输出推理/工具调用
  ↓
权限预检 + hook + MCP/tool dispatch
  ↓
工具结果回填
  ↓
模型继续判断，直到完成或阻塞
```

这比“调用一次大模型返回一段建议”强很多，因为它能形成证据闭环：模型不是凭空判断，而是边查、边执行、边校验。

### 5. 权限与并发：生产系统最关键的边界

源码里工具调用前有 preflight、权限模式、hook、MCP 授权，以及并发执行时的文件锁意识。对 AI Ops 的启发是：

- 读默认开放，但必须 allowlist。
- 写/重启/修复默认禁止，必须显式 action。
- 高风险动作必须确认词、token、冷却和回滚点。
- 每次工具调用都留 `execution record`。
- 同一个项目/文件/服务不能被多路 agent 并发写坏。

## 项目借鉴优先级

| 优先级 | 项目 | 借鉴方式 | 预期收益 |
|---|---|---|---|
| P0 | `2-Projects/ai-ops-cockpit` | 先做 `ops-tool-runtime`：ToolRegistry、PermissionPolicy、ExecutionRecord、EvidenceBundle、受控 action | OPS Grok 从“会分析”变成“可控执行 + 可追溯运维 runtime” |
| P0 | `2-Projects/cc-agent` | 抽象 ToolBridge / MCP / skills / `use_tool` / `search_tool` | cc-agent 不再是散脚本集合，而是统一工具层 |
| P0 | `2-Projects/multica-team-deploy` | 借鉴 leader / stdio / ACP / session resume / subagent lifecycle | 多客户端共享一个后端 agent runtime，减少会话漂移 |
| P0 | `2-Projects/MyJavis` | 借鉴 session persistence、tool result 回填、gated memory | 私人智能体从“实时聊天”增强为“可执行、可记忆、可审计” |
| P1 | `2-Projects/realtime-voice-agent` | 借鉴 turn loop 与工具结果回填，但适配语音 interrupt/VAD | 语音 agent 可安全调用工具，不阻塞实时对话 |
| P1 | `2-Projects/LnMem` | 借鉴 markdown memory store、显式启用、查询扩展 | 记忆层更可解释，避免隐式污染 prompt |
| P1 | `2-Projects/cpa-smart-router` | 借鉴 model catalog、profile、健康检查与失败回传 | 供应商/模型路由更像 runtime，而不是静态配置 |
| P1 | `2-Projects/chenchuan-site` | 借鉴 headless session、trace、admin ops 工具化 | 后台运维动作可被 AI Ops 接管，访客侧不混入运维复杂度 |
| P2 | `2-Projects/kidsbench-eval` | 借鉴 harness、toolset profile、隔离执行 | 评测任务更可复现 |
| P2 | `2-Projects/evo-desktop-ai` | 借鉴 TUI/后端 runtime 分离 | 桌面壳和智能体核心解耦 |

## 最短路径：`ai-ops-cockpit/ops-tool-runtime`

### 不做什么

第一阶段不要复刻 Grok Build 的 TUI、Rust workspace、完整 MCP、完整 skills 系统。那会太重。

### 先做什么

先做一个 TypeScript/Node 版最小运行时，包住现有 AI Ops 的巡检和受控修复能力：

| 最小组件 | 含义 |
|---|---|
| `ToolSpec` | 每个工具的名字、描述、参数 schema、风险等级、项目范围 |
| `ToolRegistry` | 所有工具统一注册和发现，提供 `listTools()` / `getTool()` |
| `PermissionPolicy` | 按风险等级决定只读、需确认、禁止、需人工接管 |
| `ToolRunner` | 唯一执行入口，负责参数校验、权限预检、超时、日志、结果封装 |
| `ExecutionRecord` | 每次执行的项目、工具、参数摘要、操作者、耗时、结果、证据路径 |
| `EvidenceBundle` | 巡检/修复后的结构化证据，不回传 secret 和正文敏感内容 |
| `ProjectProfile` | `chenchuan-site`、`CPA`、`IPTV`、`Theory Radar` 等项目各自 allowlist/action |

### 第一批工具

优先把已有成熟能力工具化：

- `inspect-project-health`
- `read-allowed-file`
- `inspect-kuma-status`
- `inspect-systemd-timer`
- `inspect-pm2-status`
- `run-controlled-action`
- `collect-public-probe`
- `summarize-evidence`

### API 形态

最小可用接口：

```text
GET  /api/ops-runtime/tools
POST /api/ops-runtime/tools/:toolName/run
GET  /api/ops-runtime/executions/:executionId
GET  /api/ops-runtime/projects/:projectId/profile
```

Grok / n8n / 网页按钮都走这同一层，而不是各自绕开直接跑脚本。

## 完成后的预期效果

| 维度 | 现在 | 完成后 |
|---|---|---|
| 工具入口 | 项目里散落脚本、API、按钮、n8n 节点 | 所有运维动作统一从 `ops-tool-runtime` 走 |
| Grok 能力 | 主要是读上下文、分析、给建议 | 可以基于工具定义执行只读巡检、收集证据、请求受控修复 |
| 安全边界 | 每个项目各自写 allowlist/action token | 统一 permission policy，按项目 profile 管控 |
| 可追溯性 | 依赖日志和人工回忆 | 每次工具调用都有 execution record 和 evidence bundle |
| 复用性 | CPA/IPTV/Theory Radar/个人站各做一套 | 新项目只需注册 profile + tools |
| 前端体验 | Cockpit 是项目面板 | Cockpit 变成“AI 运维控制台”，能展示工具、证据、动作状态 |
| 后续扩展 | 加新能力靠堆接口 | 后续可自然接 MCP、skills、leader、agent team |

一句话预期：**AI Ops Cockpit 会从“看板 + 若干受控按钮”升级成“可被 Grok 安全调用的运维工具运行时”。**

## 验收标准

- 任意项目可列出可用工具、风险等级、参数 schema。
- 只读工具不需要确认，但只能读 allowlist。
- 受控动作必须 action token + 精确确认词 + 冷却时间。
- 所有工具调用写入 execution record。
- 结果只返回状态、摘要、耗时、证据路径，不返回 secret、原始 token、私人 M3U、完整用户问题/回答正文。
- 同一项目同一高风险 action 并发时自动拒绝或排队。
- Grok 任务链路能通过 runtime 完成一次“巡检 → 证据 → 建议 → 确认后动作 → 动作后验收”。

## 关键边界

- `ops-tool-runtime` 不是让 Grok 获得 shell 权限，而是让 Grok 在白名单工具里行动。
- 初版不追求“通用万能 agent”，只服务 AI Ops 已接管的几个生产项目。
- 继续遵守既有边界：secret 不入 git/记忆/通知，Grok payload 只给必要事实，危险动作不自动化。
- Codex 可以做实现和验收，真正 AI Ops/Grok 任务仍应通过 `ops.hahaxiong.top` 的 Grok 4.5 链路执行。

