# Claude Code 多引擎协同优化方案 v0.1

> 提案人：cc (claude-opus-4-7)
> 日期：2026-04-19
> 目的：让 cc ↔ codex ↔ gemini 协同更丝滑

## 背景

当前 cc 通过 bash 直调 `codex exec` 和 `gemini -p` 协同三引擎。已建设的能力：
- multi-agent/RULES.md 定义路由 + GWT 黑板（blackboard.md）
- codex-* skills（status/cancel/result/team-dev/adversarial-review/review/rescue）
- agent-orchestration skill 借鉴 ruflo + oh-my-claudecode + deer-flow
- multi-agent/scripts/workflow.sh 四层闭环 + 门禁

## 痛点诊断

1. **同步阻塞**：bash exec 调用同步等待，cc 主线被卡，靠 codex-status 轮询
2. **上下文重传**：每次 codex/gemini 调用都要 cat SPEC/AC/blackboard，无 sticky cache
3. **状态共享延迟**：blackboard.md 是 markdown 非结构化，cc 必须 read 才知道 codex 进度
4. **三跳变四跳**：cc → codex → cc → gemini → cc，cc 中转浪费 token
5. **失败处理弱**：codex sandbox 限制频繁踩坑（见 feedback_agent_team_lessons / feedback_codex_rescue_longoutput）

## 业内 Agent Swarm 优质参考

| 项目 | 借鉴点 |
|------|--------|
| OpenAI Agents SDK / Swarm | handoff() + context_variables |
| LangGraph | StateGraph + Send API + checkpoint |
| AutoGen v0.4 | Actor model + GroupChat + 异步消息 |
| CrewAI | hierarchical/consensus 三种 process |
| Microsoft Magentic-One | Task Ledger + Progress Ledger 双账本 |
| claude-flow / ruv-swarm | MCP-native worker pool + queen agent |

## 优化建议（按 ROI 排序）

### P0-1：Codex/Gemini Subagent 化

**改造**：把 codex/gemini 包装成 Claude Code 原生 subagent type（类似已有 `codex:codex-rescue`），扩展为 `codex:executor` / `gemini:researcher`。

**关键能力**：
- 通过 Agent tool 调用，支持 `run_in_background: true`
- 完成后自动 envelope 回传，主线不阻塞
- 多个并行 codex 实例可同时跑

**收益**：消除 codex-status/codex-result 手动查询；主线持续工作。

**风险**：
- subagent 包装层维护成本
- codex 进程并发导致 sandbox 冲突（已有 feedback_agent_team_lessons 提到）
- envelope schema 设计需稳定

### P0-2：Sticky Context Pack

**改造**：高频上下文（SPEC/AC/blackboard/相关代码）打包为内容寻址 bundle，存 `.claude/context-cache/{sha256}.tar.gz`。调 codex 时仅传 hash 引用。

**实现**：
- bundle 包含 manifest.json + 文件内容
- codex 端命中 cache 直接 mount，未命中走旧逻辑
- 类似 nix store / docker layer 的内容寻址

**收益**：长会话 codex 调用 token 降 60%+；相同上下文不重复传输。

**风险**：
- cache 失效策略复杂（文件改了 hash 变，但 ref 没换）
- 跨机器（Air↔Mini↔Studio）cache 不共享
- 增量更新策略 vs 全量重传 trade-off

### P1-1：JSONL 事件黑板 + Monitor 订阅

**改造**：blackboard.md → blackboard.jsonl（append-only），每条事件含 schema：

```json
{"ts":"2026-04-19T10:00:00Z","agent":"codex","type":"progress","task_id":"T1","payload":{"step":"3/5","msg":"..."}}
```

cc 用 Monitor tool 流式订阅，不再轮询。

**收益**：实时进度可见；事件可重放；多 agent 写入无冲突（append-only）。

**风险**：
- markdown 黑板有 90% 是给人看的，jsonl 不可读需要 viewer
- Monitor tool 的限制（每行触发，太频繁会噪声）
- 与现有 GWT/AST 元模型冲突需迁移

### P1-2：Handoff 协议

**改造**：cc 不"调用"codex，而是把任务**移交**给 codex（明确 next_owner）。codex 完成后通过结构化 envelope 回传：

```json
{"verdict":"...","artifacts":[...],"next_owner":"gemini-review|cc-merge"}
```

把 cc → codex → cc → gemini → cc 四跳压成 cc → codex → gemini → cc 三跳。

**收益**：减少 cc 中转；token 节省；流水线化。

**风险**：
- codex/gemini 需要懂如何决定 next_owner（智能路由能力外溢）
- 失败回退路径不明（codex 失败时谁接手？）
- 与 cc 仲裁角色冲突

### P2：能力评分路由（可选）

`autoRouteEngine()` 字符串匹配升级为多维评分：任务类型匹配 × 当前负载 × 历史成功率。借鉴 CrewAI hierarchical process。

## 推荐落地顺序

1. **第一周**：P0-1 + P0-2（核心：消除阻塞 + 省 token）
2. **第二周**：P1-1（事件黑板）
3. **观察 2 周后**：P1-2、P2 按需

## 验收标准（待评审挑战）

- 长任务（>5min）cc 主线不阻塞，可并行做别的
- 重复调 codex 上下文 cache 命中率 >70%
- blackboard 事件延迟 <500ms
- 整体三引擎协同的 token 消耗降低 ≥40%

## v0.3 修订（采纳 codex 反驳 + 加上 gemini）

### 核心洞察
方案 A 的三件小事（envelope / sidecar 事件日志 / 任务分级）**天然是协议层**，三引擎通用。差异在于：每个引擎需要薄适配层把自己的输出/状态映射到统一协议。

### 三引擎适配矩阵（Phase 0 必交付）

| 维度 | cc | codex | gemini |
|------|----|----|----|
| 调用方式 | 主线直跑 | `codex exec` (单轮+session) | `gemini -p` (单轮无状态) |
| envelope 来源 | 自省式 | 让 codex prompt 内输出 JSON tail，wrapper parse | wrapper 强制要求"以 ```json 块结尾"，parse 失败回退结构化降级 |
| 事件日志写入 | 主线写 started/done | wrapper 在 spawn/exit 时代写 started/done；中间 milestone 由 codex 自己 echo | wrapper 只写 started/done（gemini 无中间状态） |
| 任务分级 | 全级（短/中/长） | 中-长（写代码、跑测试） | 短（调研、查资料、文档） |
| 失败降级 | 兜底 | 失败→cc 接手 | 失败→跳过研究环节，不阻塞主链 |

### Phase 0 落地（agent team 三路并行）

- **cc 主线**：写 envelope schema TS + events.jsonl helper + 三引擎 wrapper stub
- **codex 后台**：审 v0.3 设计 + 挑战 envelope schema 完整性 + sidecar 并发写安全
- **gemini 后台**：调研 2026 业内三引擎协同的 envelope/事件协议真实案例（autogen 0.4 / langgraph state / openai swarm / a2a 协议），给 cc 设计当弹药

**收益验证（数据驱动）**：跑 1 周后看真实分母，再决定 P0-1/P0-2 要不要做。

---

## 待对抗审查的关键问题

请 codex 重点挑战：

1. **subagent 包装是否真比 bash exec 优**？Claude Code Agent tool 的 background 机制，能否真的解决 codex CLI 长输出 truncate 问题？
2. **sticky context cache 的 invalidation 策略**：文件改动后 hash 变了，但调用方传的还是旧 hash，错误结果如何防御？
3. **JSONL 黑板 + Monitor 订阅**：Monitor tool 实际能力上限是什么？高频事件会不会反而成为新的瓶颈？
4. **Handoff 协议**：让 codex 决定 next_owner 是否过度赋权？fail-safe 怎么设计？
5. **整体方案是否过度工程**？现在的痛点是真痛点还是 cc 的认知偏差？哪些"丝滑"诉求其实可以靠规则约束 + 更好的 prompt 解决，不需要架构改动？
6. **隐含假设**：方案默认三引擎都活、都听话。代理网络故障/codex 限流/gemini 配额耗尽时降级路径？
7. **机会成本**：花 1-2 周做这个，对比直接用更成熟的开源框架（如 autogen / langgraph）二次封装，哪个更划算？
