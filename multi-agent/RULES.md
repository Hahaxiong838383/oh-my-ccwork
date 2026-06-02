# 多智能体协同规则

> 适用：cc (Claude) + grok (xAI) + codex (OpenAI) + gemini (Google)
> 更新：2026-05-31 — 接入 Grok 第二套写码引擎（双引擎并存 + Team 第 4 lane）
> 历史：2026-03-11 从理想化四层闭环精简为实用版

---

## 日常模式（默认）

### 路由规则

| 任务类型 | 路由 | 示例 |
|---------|------|------|
| 代码实现、快速迭代、批量改、子代理并行（默认写码） | → **grok** (`grok-build` 512k) | "实现登录功能"、"批量改这 20 个文件" |
| 高 stake（认证/支付/数据迁移/生产事故）/ 已验证链路 / 对抗审查 / 疑难根因 | → **codex** | "改支付逻辑"、"codex review 一下" |
| 超 512k 超长上下文 / 需 reasoning effort 分档 | → **omp 满血 grok-4.3**（1M，xAI 原生 + SuperGrok 订阅 OAuth） | "整仓重构超大依赖树"、"深度推理任务" |
| 调研、知识库同步、论文抓取、学术评审 | → gemini | "调研 XX 技术"、"同步到 FUTURUS" |
| 规划、决策、编排、终验、日常问答 | → cc | "设计架构"、"帮我看看" |

**写码双引擎并存，cc 按任务挑**（川哥钦定 2026-05-31，2026-06-02 接入 grok-4.3 满血档）：默认 grok（`grok-build`，512k），命中「高 stake/对抗审查/已验证链路」走 codex，**超 512k 升级到 omp 的 `xai-oauth/grok-4.3`（1M）**。**高 stake 实现可 grok+codex 双发对比 / grok-build+grok-4.3 同家族不同档对比**（各出一版，cc 跑测试挑优 / 互为对抗审查）。模型 + effort 详表见 [`~/.claude/rules/engine-routing.md`](file:///Users/rayman.chen/.claude/rules/engine-routing.md)。⚠️ grok-build 调用必带 `-m grok-build --no-subagents` + 绝对路径；omp 必带 `--model xai-oauth/grok-4.3` 完整路径（短名 `grok-4.3` 会模糊匹配到 kilo gateway 报 "No API key for kilo"）。

### 强制规则（3 条）

1. **大任务（预估 >10 分钟）必须拆分** — 分发给 grok/codex/gemini 并行执行，cc 只编排不硬啃
2. **cc 不负责批量实现** — cc 做规划和关键决策，写代码交给 grok（默认）或 codex（高 stake）
3. **写码引擎自报** — 派 grok/codex 前一行自报模型 + effort + 选它的理由（见 engine-routing.md「调用前自报」）

### 角色定位

| 角色 | 职责 | 不做什么 |
|------|------|---------|
| cc (Claude) | 想清楚、做决策、编排任务、终验、commit/push | 不写大段样板代码 |
| grok (xAI) | 写码（默认）、快速迭代、批量改、超长上下文实现 | 不做架构决策 |
| codex (OpenAI) | 写码（高 stake）、改仓库、跑测试、对抗审查 | 不做架构决策 |
| gemini (Google) | 搜资料、写报告、学术评审、找问题 | 不争主实现 |

### 信息黑板（GWT — Global Workspace Theory，2026-03-31 起）

四引擎（cc / grok / codex / gemini）通过 `0-System/blackboard.md` 共享实时状态，每个引擎各占一行：

| 功能 | 说明 |
|------|------|
| **注意力状态** | cc 在接收任务时更新聚焦/负载/选择原因（AST 元模型） |
| **引擎状态** | 每个引擎完成任务后更新自己的行（当前任务/状态/时间） |
| **共享上下文** | 引擎间传递的实时信息（避免信息在串行调度中丢失） |
| **待接力任务** | A 引擎完成后需要 B 引擎接力的任务 |

**cc 在分发任务前**：更新黑板的引擎状态和注意力状态。
**grok/codex/gemini 完成任务后**：更新自己的行 + 写入共享上下文。

### 简单问答

直接回，不起 Agent，不调外部工具。

---

## Team 模式 / 正式项目模式（按需启用）

> 用于大型正式项目（预估 >1 天）或跨日工作量（>4h），日常任务不需要。

### 启动条件（满足任一）

- ✅ 跨日工作量（>4h）/ 大型正式项目（>1 天）
- ✅ 涉及外部知识（中文 NLP / 学术文献 / SOTA 方案）→ 必带 gemini
- ✅ 高 stake 决策（架构变更 / base ckpt / 认证支付）
- ✅ 用户明确说"启动正式项目模式 / Team 模式"
- ❌ 单文件 <100 行小修（cc 主线直接做更快）

### 四 lane 并行（cc 编排 + grok + codex + gemini）

```
Layer 1 规格（cc 输出 SPEC.md + AC.md，含数据契约 + 判定矩阵 + "不在范围内"明示）
      ↓
Layer 2 四 lane 并行产出（各占 blackboard 一行，互不阻塞）：
        • cc    — 主线编排 / 关键决策 / 写验收脚本
        • grok  — 写码主力（默认）：快速迭代 / 批量 / 超长上下文实现
        • codex — 写码（高 stake lane）/ 对照补边界 / 对抗审查
        • gemini— 学术评审 / 边界用例 / 外部知识（与写码并行，不串行等）
      ↓
Layer 3 自动化验收（测试 + lint + type check，cc 主 shell 自跑一遍）
      ↓
Layer 4 裁决（cc 审查 + 合并 + REVIEW.md，commit/push）
```

> **写码 lane 由 cc 按日常路由分派 grok / codex**：默认 grok（`grok-build`）；高 stake 走 codex；高 stake 实现可双发对比（grok + codex 各一版，cc 跑测试挑优 / 互为对抗审查，类似 grok `--best-of-n` 的跨引擎版）。多引擎并行改同仓文件时用 `grok -w`（worktree）或独立 worktree 防冲突。

### Team 模式额外规则

1. 没有 AC 不允许生成代码；cc spec 必须严格 + 含"不在范围内"明示（避免 grok/codex 自由发挥）
2. 并行输出必须可比较（双发对比时同一 AC）
3. 所有验证必须自动化，且 **cc 主 shell 自跑一遍**（不信 grok/codex sandbox 自报"测试通过"）
4. 每个阶段创建 git checkpoint
5. **派 grok/codex 的 prompt 必含绝对文件路径列表**（不假设引擎知道仓库结构）+ 落盘路径 + `## Summary ≤5 行`，且 cc 发 prompt 前逐个文件 `ls`/`find` 校验

### 回滚点

```bash
git add -A && git commit -m "checkpoint: 描述"
git reset --soft HEAD~1
```

---

## 引擎调用方式

> 写码/调研引擎的**唯一调用 = bash CLI 直调**（`grok -p` / `codex exec` / `gemini -p`），禁用 MCP/skill 包装（见全局 `memory/reference_engine_cli_calling.md`）。模型 + effort 选择见 [`~/.claude/rules/engine-routing.md`](file:///Users/rayman.chen/.claude/rules/engine-routing.md)。

```bash
# Grok（默认写码引擎，xAI）— prompt 从文件读。⚠️ 必 -m grok-build + 绝对路径；判断成功看 exit0+stdout 非空（不看 stderr 的 .mcp.json 噪音）
~/.grok/bin/grok --prompt-file /tmp/grok_prompt.md \
  -m grok-build --effort high \
  --output-format plain --no-subagents \
  --cwd /Users/rayman.chen/mycc \
  > /tmp/grok_log.md 2>/tmp/grok_err.md &
# 偶发 text/plain → 重试 1-2 次，仍失败降级 codex（详见 engine-routing.md grok_run 包装）。禁 `timeout grok …`（exit 127）。高 stake 可加 --best-of-n 3 / --check

# omp 满血 grok-4.3（超 512k 上下文 / 需 reasoning effort 分档 / 同家族对比，xAI 原生 + SuperGrok 订阅 OAuth）
# ⚠️ PATH 必须含 ~/.bun/bin；model 必须用完整路径 xai-oauth/grok-4.3（短名 grok-4.3 模糊匹配到 kilo gateway 出错）
# ⚠️ --auto-approve 跳所有交互；--thinking 取 minimal/low/medium/high/xhigh
PATH="$HOME/.bun/bin:$PATH" omp -p \
  --model xai-oauth/grok-4.3 --thinking high \
  --auto-approve \
  --no-extensions --no-skills --no-rules \
  --append-system-prompt "$(cat /tmp/omp_prompt.md)" \
  "执行任务" \
  > /tmp/omp_log.md 2>&1 &
# 失败模式：①"No API key for kilo" → 漏了 xai-oauth/ 前缀；②"No API key found for xai-oauth" → ~/.omp/agent/agent.db 凭据丢/refresh 失败,重新 import ~/.grok/auth.json
# SuperGrok OAuth 凭据从 ~/.grok/auth.json 旁路导入（同 OAuth client_id b1a00492-…）：
#   python3 -c "..." 转格式后 omp auth-broker import /tmp/omp_xai_creds.json --provider=xai-oauth
# 模板见 /tmp/verify_omp_grok43.sh 或 docs/rules/MULTI-AGENT.md

# Codex（高 stake 写码 / 对抗审查，OpenAI）
codex exec -C /Users/rayman.chen/mycc --full-auto \
  -c model="gpt-5.3-codex" -c model_reasoning_effort="high" \
  - < /tmp/codex_prompt.md > /tmp/codex_log.md 2>&1 &

# Gemini（调研 / 评审，Google）— prompt 内嵌全文
gemini -m gemini-3-flash-preview -p "$(cat /tmp/gemini_prompt.md)"
```

> cc 用 Monitor 等引擎退出（不轮询），完成后**主 shell 自跑测试验收**，再由 cc 主线 commit/push（grok/codex sandbox 不让写 .git）。

---

## 飞书三机器人群聊

- **群 chat_id**: `oc_f4a09ffbd709b39c917b927ecb9d96b6`
- cc (FEISHU1) + codex (FEISHU4) + gemini (FEISHU5)
- 发群消息用 `open-feishu-mcp` 的 `send_message`
- 三机器人均可调用飞书 MCP 工具
- **grok 暂无飞书机器人（App ID 未配），仅 CLI 直调，不占群聊 lane**；如需上群聊需先申请 App ID（不猜）

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `multi-agent/context/` | SPEC/AC/ARCH 模板（正式项目模式用） |
| `.claude/skills/agent-orchestration/` | Agent 编排 skill |
| `.claude/skills/mycc/scripts/src/channels/feishu.ts` | 飞书通道（含 autoRouteEngine） |
