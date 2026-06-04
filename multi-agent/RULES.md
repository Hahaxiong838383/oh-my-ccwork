# 多智能体协同规则

> 适用：cc (Claude) + grok (xAI) + codex (OpenAI) + gemini (Google) + omp 跨家族通道
> 更新：**2026-06-04 — v3 整合 omp 三家订阅闭环（A 写码档 + B 调研评审档 + 跨家族对抗审查）**
> 历史：2026-05-31 接入 Grok 第二套写码引擎；2026-06-02 grok-4.3 满血档；2026-03-11 从理想化四层闭环精简为实用版

---

## 核心结构（v3）

**三大 lane × 多档模型**：
- **A 写码档** — 4 档（grok-build / omp grok-4.3 / omp gpt-5.5 / omp gpt-5.4 review）
- **B 调研评审档** — 5 档（omp gemini-3-flash / 3.1-pro / VPS proxy 3.5-flash / **omp grok-4.3 推理** / **omp gpt-5.5 严谨评审**）
- **C/D 编排+异步** — cc 主线 + hermes 长跑

**成本视角**：三家订阅（SuperGrok + ChatGPT Team + Gemini OAuth）= **已付月费 sunk cost，调用边际 ¥0**。**唯一付费按量** = mycc VPS proxy 3.5-flash（仅在"需要 3.5 thinking"启用）。**默认走订阅，付费档按需触发**。

**路径选择原则**：**omp 路径优先（统一 `omp -p --model X/Y`）+ CLI 直调降级备用**（omp 崩/凭据失效逃生通道）。

---

## A 档：写码 Lane

| ID | 路径 | 引擎 | 上下文 | 速度 | 适用 |
|---|---|---|---|---|---|
| **A1 默认** | grok-build CLI 直调 | `grok-build` | 512k | ⚡⚡⚡ 最快 | 短任务 / 批量改 / 单文件 / <300 行 |
| **A2 满血/长ctx** | omp | `xai-oauth/grok-4.3` | 1M | ⚡⚡ + reasoning 分档 | >512k 上下文 / 需 effort 分档 / 同家族对比 |
| **A3 高stake默认** | **omp** | `openai-codex/gpt-5.5` | 272k | ⚡ 中等稳 | 认证 / 支付 / 数据迁移 / 生产事故 |
| **A3-fallback** | codex CLI 直调（降级）| `gpt-5.3-codex` / `gpt-5.4` / `gpt-5.5` | 272k-1M | 同上 | A3 omp 不通时逃生 |
| **A4 对抗审查** | omp | `openai-codex/gpt-5.4` | 400k | ⚡ 中等 | code review 主通道（轻量 review 单发即可）|

### A 档写码触发逻辑

```
写码任务
  ├─ <300 行 / 单文件 / 快速迭代 → A1 grok-build (默认)
  ├─ >512k 上下文 / 需 effort 分档 → A2 omp xai-oauth/grok-4.3
  ├─ 高 stake (认证/支付/迁移/事故) → A3 omp openai-codex/gpt-5.5
  └─ 轻量 code review → A4/B5 omp openai-codex/gpt-5.4 (单发)
```

---

## B 档：调研/研究/评审 Lane（v3 新增 grok / gpt 评审档）

| ID | 路径 | 引擎 | 上下文 | thinking 档 | 成本 | 独特价值 |
|---|---|---|---|---|---|---|
| **B1 默认** | omp | `google-gemini-cli/gemini-3-flash-preview` | 1M | minimal-high | ¥0 | Gemini 默认主力,短任务 |
| **B2 学术深度** | omp | `google-gemini-cli/gemini-3.1-pro-preview` | 1M | low/high | ¥0 | gemini 风格精准,长综合,Google ecosystem |
| **B3 顶级深度（付费）** | mycc VPS proxy `23.226.135.149:4000` | `gemini-3.5-flash` + max_tokens 65535 | 1M | minimal/medium/high | 💴 按 token | Vertex AI Global,thinking 最强 |
| **★ B4 grok 推理评审** | omp | `xai-oauth/grok-4.3` | 1M | minimal-**xhigh** | ¥0 | **第一性原理推理 / 反思维定式 / 物理直觉 / 非 Google 视角** |
| **★ B5 codex 严谨评审** | omp | `openai-codex/gpt-5.5` 或 `gpt-5.4` | 272k-400k | minimal-xhigh | ¥0 | **结构化逻辑链清晰 / 边界用例 / 偏正式格式** |
| **B-fallback** | gemini CLI 直调 | 同 B1/B2 | 同上 | 同上 | ¥0 | omp 不通时降级 |

### B 档调研/评审触发逻辑（按风格选）

```
评审/调研任务
  ├─ 短调研 / 提取 / 分类 → B1 omp gemini-3-flash (默认,最快)
  ├─ 学术综合 / 长文分析 → B2 omp gemini-3.1-pro
  ├─ 推理深度 / Why / 第一性原理 → B4 omp grok-4.3 thinking=high
  ├─ 严谨结构化 / 代码评审风格 → B5 omp gpt-5.5 thinking=high
  ├─ 顶级深度 / 批判性思考 → B3 VPS proxy 3.5-flash high (付费)
  └─ 轻量 code review → B5 omp gpt-5.4 high (单发)
```

---

## ★ 核心新规则：跨 stake 三发对抗触发（川哥钦定 2026-06-04）

| Stake 档 | 写码 lane 模式 | 评审 lane 模式 | 触发判定 |
|---------|---------------|---------------|---------|
| **普通**（默认）| 单发（按 A 档路由）| 单发（按 B 档路由）| 默认 |
| **中等** | 单发 + 关键时双发对比 | 双发（B4 + B2 推理 vs 学术）| cc 判断 |
| **高 stake / 高难度** ★ | **A 双发**（A1 + A3）+ **B 三发评审**（B4 + B5 + B2）| **B 三发对抗**（B4 + B5 + B2）| 见下方判定 |
| **顶级** ⚠️ 川哥手动触发 | A 双发 + **B 四发**（B4 + B5 + B2 + B3 加付费档） | B 四发 | 川哥说"大活/高难度/不能错" 或 cc 风险预警 |

### 高 stake / 高难度 判定（自动触发三发）

满足任一立即升级到"高 stake/高难度"：

**高 stake**:
- 认证 / 支付 / 数据迁移 / 生产事故
- 安全相关（CVE / 凭据处理 / 加密）
- 不可回滚（migration / 删数据 / DROP TABLE）

**高难度写码**（v3 新增触发线）:
- 任务行数 >1000 行
- 跨子系统 / 跨包 / 跨语言
- 涉及并发 / 算法核心 / 性能关键路径
- 大范围重构 / 顶级架构变更

### 顶级 stake（手动触发 + cc 主动预警）

**触发方式**：
- 川哥明确说"大活 / 高难度 / 不能错 / 全力 / 顶级"
- cc 检测到下面"风险预警关键词" → **主动问川哥是否升级**：

cc 风险预警清单（看到这些主动问川哥）:
- 生产关键路径 / 生产环境核心
- 资金 / 支付链路 / 财务
- 全量数据操作 / 全表 migration
- 安全凭据轮换 / 权限提升
- 不可回滚 + 无 staging 验证

cc 自报格式：
```
[风险预警] 检测到「<关键词>」,这看起来是顶级 stake 任务。
建议升级到 B 四发对抗(grok+gpt+gemini+VPS proxy)+ A 双发实现。
要不要启动顶级模式? (yes/no)
```

---

## 通用 lane 调用清单

```bash
# A1 grok-build (默认写码,最快最便宜)
~/.grok/bin/grok --prompt-file /tmp/p.md -m grok-build --effort high --no-subagents --cwd /path

# A2 omp xai-oauth/grok-4.3 (满血/长 ctx)
omp -p --model xai-oauth/grok-4.3 --thinking high --auto-approve "..."

# A3 omp openai-codex/gpt-5.5 (高 stake 写码)
omp -p --model openai-codex/gpt-5.5 --thinking high --auto-approve "..."

# A3-fallback codex CLI (omp 不通时降级)
codex exec -C /path --full-auto -c model="gpt-5.5" -c model_reasoning_effort="high" - < /tmp/p.md

# B1 omp gemini-3-flash-preview (默认调研,免费)
omp -p --model google-gemini-cli/gemini-3-flash-preview --thinking minimal --auto-approve "..."

# B2 omp gemini-3.1-pro-preview (学术深度,免费)
omp -p --model google-gemini-cli/gemini-3.1-pro-preview --thinking high --auto-approve "..."

# B3 VPS proxy 3.5-flash (顶级深度,付费)
curl -H "Authorization: Bearer fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4" \
  http://23.226.135.149:4000/v1/chat/completions \
  -d '{"model":"gemini-3.5-flash","messages":[...],"max_tokens":65535,"reasoning_effort":"high"}'

# B4 omp xai-oauth/grok-4.3 (推理深度评审,免费)
omp -p --model xai-oauth/grok-4.3 --thinking high --auto-approve "..."

# B5 omp openai-codex/gpt-5.4 or 5.5 (严谨结构化评审 + 轻量 code review,免费)
omp -p --model openai-codex/gpt-5.4 --thinking high --auto-approve "..."

# ─── B 三发对抗(高 stake/高难度评审标准模板) ───
PROMPT_FILE=/tmp/review.md  # 评审内容 + diff + 评审角度

omp -p --model xai-oauth/grok-4.3 --thinking high --auto-approve "$(cat $PROMPT_FILE)" > /tmp/r-grok.md 2>&1 &
omp -p --model openai-codex/gpt-5.5 --thinking high --auto-approve "$(cat $PROMPT_FILE)" > /tmp/r-gpt.md 2>&1 &
omp -p --model google-gemini-cli/gemini-3.1-pro-preview --thinking high --auto-approve "$(cat $PROMPT_FILE)" > /tmp/r-gem.md 2>&1 &
wait
# cc 综合三家 finding, 取并集去重, 标各家独有发现, 跑测试验证

# ─── 顶级 B 四发(川哥手动触发 / cc 预警后确认才用) ───
# 上面三家 + B3 VPS proxy 3.5-flash (付费档,thinking 最强)

# ─── 高 stake 写码 A 双发 + B 三发评审 联动 ───
# Stage 1: A 双发实现
~/.grok/bin/grok --prompt-file /tmp/impl.md -m grok-build --effort high --no-subagents --cwd /path > /tmp/a-grok.md 2>&1 &
omp -p --model openai-codex/gpt-5.5 --thinking high --auto-approve "$(cat /tmp/impl.md)" > /tmp/a-gpt.md 2>&1 &
wait
# cc diff 两版 + 挑优 / 合并

# Stage 2: B 三发评审 cc 选定版本
DIFF=$(cd /path && git diff main..HEAD)
PROMPT="审查这段 diff: \n\n$DIFF"
omp -p --model xai-oauth/grok-4.3 --thinking high --auto-approve "$PROMPT" > /tmp/r-grok.md &
omp -p --model openai-codex/gpt-5.5 --thinking high --auto-approve "$PROMPT" > /tmp/r-gpt.md &
omp -p --model google-gemini-cli/gemini-3.1-pro-preview --thinking high --auto-approve "$PROMPT" > /tmp/r-gem.md &
wait
# cc 综合所有信号(双发实现差异 + 三家评审 finding) 决策
```

⚠️ **每次调用前自报**（写码/评审都要）：
```
[lane] <ID> <provider/model> + --thinking <X> / 任务=<...> / stake=<普通/中等/高/顶级> / 选它的理由=<...>
```

### 强制规则（v3 整合,4 条）

1. **大任务（预估 >10 分钟）必须拆分** — 分发给 A/B 各 lane,cc 只编排不硬啃
2. **cc 不负责批量实现 / 主评审** — cc 做规划和关键决策,写代码交 A,评审交 B,综合裁决在 cc
3. **omp 路径优先** — 默认走 omp(统一 `omp -p --model X/Y`),CLI 直调作降级 fallback,**遇 omp 进程崩/凭据失效一键切 CLI**
4. **每次调用前自报 lane + provider/model + thinking + stake + 理由**（写码/评审都要）

### 角色定位（v3 重写）

| 角色 | 职责 | 不做什么 |
|------|------|---------|
| **cc (Claude)** | 想清楚、做决策、编排任务、终验、commit/push、风险预警询问 | 不写大段样板代码、不主评审 |
| **A 写码档** | 写码、改文件、跑测试（4 引擎按 stake 升级，omp 路径优先）| 不做架构决策 |
| **B 调研评审档** | 调研、评审、对抗审查（5 引擎按风格选，三家跨家族对抗能力是 v3 最大新增）| 不写主代码 |
| **D hermes** | 长时（>30min）、跨平台消息、异步推送 | 不参与同步决策 |

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

### 多 lane 并行（v3：A 写码 + B 调研评审 + cc 编排 + D 异步）

```
Layer 1 规格（cc 输出 SPEC.md + AC.md，含数据契约 + 判定矩阵 + "不在范围内"明示）
      ↓
Layer 2 多 lane 并行产出（各占 blackboard 一行，互不阻塞）：
        • cc    — 主线编排 / 关键决策 / 写验收脚本 / 风险预警
        • A 写码 — 按 stake 升级：普通 A1 单发 / 高 stake/高难度 A1+A3 双发
        • B 评审 — 按 stake 升级：普通 B1 单发 / 高 stake/高难度 B4+B5+B2 三发对抗
        • D hermes — 长时（>30min）/ 异步推送（如需）
      ↓
Layer 3 自动化验收（测试 + lint + type check，cc 主 shell 自跑一遍）
      ↓
Layer 4 裁决（cc 综合 A 双发实现差异 + B 三发评审 finding + 自验测试 → REVIEW.md，commit/push）
```

> **写码 lane 由 cc 按日常路由分派**：普通走 A1（grok-build 最便宜）；超 512k 升 A2（omp grok-4.3 1M）；高 stake 走 A3（omp gpt-5.5）。**高 stake/高难度任务必须 A 双发对比**（A1 + A3，cc 跑测试挑优 / 互为对抗审查）。
> **评审 lane**：高 stake/高难度任务必须 **B 三发对抗**（B4 grok 推理 + B5 gpt 严谨 + B2 gemini 学术，三家跨家族独立视角）。
> **顶级 stake**（川哥手动触发 或 cc 风险预警询问后启动）：A 双发 + **B 四发**（B3 加 VPS proxy 3.5-flash 付费档）。
> 多引擎并行改同仓文件时用 `grok -w`（worktree）或独立 worktree 防冲突。

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

> **v3 路径策略（2026-06-04）**：**omp 路径优先**（统一 `omp -p --model X/Y`，三家订阅同 agent.db 共存 + 跨家族并发 1.3x 加速）+ **CLI 直调作降级 fallback**（omp 进程崩/凭据失效时一键切回）。模型 + effort 选择见 [`~/.claude/rules/engine-routing.md`](file:///Users/rayman.chen/.claude/rules/engine-routing.md)。
> CLI 直调注意事项见全局 `memory/reference_engine_cli_calling.md`（grok 5 铁律 / codex 调用模板等）。

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
