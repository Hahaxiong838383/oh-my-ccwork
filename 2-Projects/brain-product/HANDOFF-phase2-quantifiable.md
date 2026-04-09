# Phase 2：可量化（Quantifiable）— 实施方案 + 交接文档

> 创建时间：2026-04-09 | 创建者：cc（Claude claude-opus-4-6）
> 前置依赖：Phase 1（可观测）四项 P0 已完成并部署（v0.7.0）
> 回滚点：main 分支当前 HEAD（`8763ce2`）

---

## 当前状态

- **brain 版本**：v0.7.0（Admin UI v2.7）
- **Phase 1 完成度**：4/4 P0 全部交付
- **Phase 2 目标**：让 brain 的行为可量化——信任度有数字、Skill 有生命周期、规则有引擎、异常有检测

---

## I. Phase 1 已完成清单

### 四项 P0

| # | 功能 | 文件 | 核心接口 | API 端点 |
|---|------|------|---------|---------|
| P0-1 | steering_tax 采集 | `src/services/steering-tax.ts` (321行) | `detectCorrection()`, `recordCorrection()`, `getSteeringTaxReport()` | `/admin/api/steering-tax` |
| P0-2 | 轨迹双流 | `src/services/experience-stream.ts` | outcome 分流 + per-tool 统计 | 内部服务 |
| P0-3 | 不可变审计日志 | `src/services/audit-log.ts` (125行) | `writeAuditLog()`, `getTodayRiskScore()`, `getAuditSummary()` | `/admin/api/audit-log` |
| P0-4 | SOUL.md 每轮加载 | `src/services/soul-loader.ts` | 5s 缓存核心摘要注入 system prompt | 内部服务 |

### 数据文件布局

```
data/
├── steering-tax/YYYY-MM-DD.jsonl   # 纠正事件（按日分文件）
├── experiences/YYYY-MM-DD.jsonl    # 经验流（成功/失败分流）
├── audit-log.jsonl                 # 不可变审计日志（单文件追加）
├── evolution-actions.jsonl         # 进化动作日志
├── keyword-extensions.jsonl        # 自进化关键词
└── config-overrides.json           # 自进化参数覆盖
```

---

## II. Phase 2 四项 P1 逐项分析

### P1-A: TrustState 量化

**目标**：将用户对 brain 的信任从主观感觉变成可计算的数字，驱动自主权动态调整。

**依赖**：
- steering-tax.ts — 纠正事件是 deny 权重的数据来源
- experience-stream.ts — 交互总数（approve 事件的基数）
- audit-log.ts — trust 事件写入审计日志

**核心数据结构**：

```typescript
// src/services/trust-state.ts

interface TrustEvent {
  readonly timestamp: string;
  readonly eventType: "approve" | "deny";
  readonly category: "prediction_accurate" | "proactive_adopted" | "routine_ok"
                   | "corrected" | "rejected" | "rollback";
  readonly weight: number;       // +3/+2/+1 或 -2/-1/-5
  readonly source: string;       // 触发来源（如 "steering-tax", "user-feedback"）
  readonly conversationId?: string;
}

interface TrustState {
  readonly score: number;         // 当前信任分
  readonly mode: "conservative" | "standard" | "autonomous";
  readonly lastUpdated: string;
  readonly lastDecayApplied: string;
  readonly eventCount: { approve: number; deny: number };
}

// 模式映射
// < 30 → conservative（所有非只读操作需确认）
// 30-70 → standard（已知模式自动执行，新模式需确认）
// ≥ 70 → autonomous（可主动发起进化提案）
```

**核心逻辑**：

1. **事件采集**：steering-tax 检测到纠正 → 自动生成 deny 事件；经验流记录成功交互 → 生成 approve 事件
2. **分数计算**：`score = Σ(approve × weight) - Σ(deny × weight) - decay(time)`
3. **每日衰减**：每 24h 衰减 5%（通过 cron 或请求时 lazy 计算）
4. **模式切换**：score 变化后重新计算 mode，写入审计日志

**改动文件**：

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/services/trust-state.ts` | 核心模块：事件记录、分数计算、衰减、模式映射 |
| 新建 | `data/trust-state.json` | 持久化当前 TrustState |
| 新建 | `data/trust-events.jsonl` | 信任事件流（append-only） |
| 修改 | `src/services/steering-tax.ts` | recordCorrection 后触发 trust deny 事件 |
| 修改 | `src/brain-api.ts` | 成功交互后触发 trust approve 事件 |
| 修改 | `src/server.ts` | 新增 `/admin/api/trust-state` 端点 |
| 修改 | `src/admin/admin-ui.html` | Admin UI 增加信任度面板 |

**复杂度**：中 | 预估 1 session

**风险点**：
- 冷启动问题：新部署时 score=0 处于保守模式，需要设定合理初始值（建议 50，标准模式）
- 衰减时机：lazy 计算（请求时算）vs cron（定时算）的一致性
- approve 事件过度膨胀：每次成功交互都 +1 会导致 score 快速飙升，需要每日上限或频率控制

---

### P1-B: Skill 自主沉淀

**目标**：复杂任务（>5 工具调用）完成后，brain 自主判断是否将该任务模式沉淀为可复用 Skill。

**依赖**：
- experience-stream.ts — per-tool 统计（判断工具调用次数）
- evolution-engine.ts — 进化框架（Skill 创建纳入进化管道）
- audit-log.ts — 记录 Skill 创建/老化/淘汰事件

**核心数据结构**：

```typescript
// src/services/skill-lifecycle.ts

interface SkillCandidate {
  readonly conversationId: string;
  readonly timestamp: string;
  readonly toolCalls: number;          // 工具调用次数
  readonly toolsUsed: string[];        // 使用的工具列表
  readonly taskSummary: string;        // LLM 生成的任务摘要
  readonly successRate: number;        // 本次任务成功率
}

interface SkillRecord {
  readonly id: string;                 // 唯一标识
  readonly name: string;               // Skill 名称
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly useCount: number;
  readonly successRate: number;        // 历史成功率
  readonly status: "active" | "aging" | "retired";
  readonly pattern: string;            // 匹配模式（何时触发）
  readonly template: string;           // 执行模板
}

// 生命周期规则：
// 创建：toolCalls > 5 && success → SKILLS_GUIDANCE 判断
// 老化：30天未使用 OR 成功率 < 60% → status = "aging"
// 淘汰：aging 状态持续 7 天无使用 → status = "retired"
// 修补：使用时检测过期 → 自动 patch
```

**核心逻辑**：

1. **候选检测**（post-hook）：每次交互完成后，检查 per-tool 统计，>5 次且成功 → 生成 SkillCandidate
2. **沉淀判断**（LLM）：将 candidate + 对话上下文交给 LLM 判断是否值得沉淀
3. **生命周期管理**（cron）：每日检查所有 active Skills，标记 aging/retired
4. **使用追踪**：brain-context 检索时匹配 Skill pattern，命中则更新 lastUsedAt 和 useCount

**改动文件**：

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/services/skill-lifecycle.ts` | 候选检测 + 沉淀判断 + 生命周期管理 |
| 新建 | `data/skills-registry.json` | Skill 注册表 |
| 新建 | `data/skill-candidates.jsonl` | 候选日志 |
| 修改 | `src/brain-api.ts` | 交互完成后触发候选检测 |
| 修改 | `src/services/evolution-engine.ts` | Skill 创建纳入进化管道（写审计日志） |
| 修改 | `src/server.ts` | 新增 `/admin/api/skills` 端点 |

**复杂度**：中高 | 预估 1.5 session

**风险点**：
- 与记忆系统的 memory-rules.md 规则驱动方案**不冲突**：Skill 是程序性记忆（how to do），memory-items 是陈述性记忆（what happened）
- LLM 判断质量：沉淀判断依赖 LLM，可能过度沉淀（建议初期保守，成功率 >80% 才沉淀）
- Skill 模板格式：需要定义清晰的模板 schema，否则沉淀的 Skill 不可执行

---

### P1-C: Constitutional Guard

**目标**：用声明式规则引擎替代散落在代码中的 if/else 权限检查，实现 L0 宪法的运行时门控。

**依赖**：
- audit-log.ts — 所有 guard 判定写入审计日志（尤其是 l0_boundary 类型）
- trust-state.ts（P1-A）— 部分规则的 verdict 取决于当前信任模式

**核心数据结构**：

```yaml
# data/constitutional.yaml — 声明式规则文件

version: 1
rules:
  # L0 保护：宪法文件不可写
  - id: l0-write-deny
    scope: "file:write"
    target: ["MANIFESTO.md", "SOUL.md", "constitutional.yaml"]
    verdict: deny
    reason: "L0 宪法文件不可被任何进化操作修改"

  # L1 进化门控：fitness 必须改善
  - id: l1-evolution-gate
    scope: "evolution:execute"
    condition: "fitness_delta > 0"
    verdict: allow
    fallback: deny
    reason: "进化操作必须改善联合适应度"

  # 信任模式门控
  - id: trust-conservative-gate
    scope: "action:non-readonly"
    condition: "trust_mode == 'conservative'"
    verdict: requires_confirmation
    reason: "保守模式下非只读操作需确认"

  # 每日风险上限
  - id: daily-risk-limit
    scope: "evolution:execute"
    condition: "daily_risk_score >= 100"
    verdict: deny
    reason: "单日累积风险分超过上限"
```

```typescript
// src/services/constitutional-guard.ts

interface GuardRule {
  readonly id: string;
  readonly scope: string;          // "file:write" | "evolution:execute" | "action:non-readonly"
  readonly target?: string[];      // 目标文件/端点列表
  readonly condition?: string;     // 条件表达式（简单 JS 表达式）
  readonly verdict: "allow" | "deny" | "requires_confirmation";
  readonly fallback?: "allow" | "deny";
  readonly reason: string;
}

interface GuardContext {
  readonly action: string;
  readonly target?: string;
  readonly trustMode: "conservative" | "standard" | "autonomous";
  readonly dailyRiskScore: number;
  readonly fitnessDelta?: number;
}

interface GuardResult {
  readonly ruleId: string;
  readonly verdict: "allow" | "deny" | "requires_confirmation";
  readonly reason: string;
}

// 核心函数
function evaluate(context: GuardContext): GuardResult;
function loadRules(): GuardRule[];
function reloadRules(): void;  // 规则文件变更后热重载
```

**核心逻辑**：

1. **规则加载**：启动时从 `data/constitutional.yaml` 加载规则，watch 文件变更热重载
2. **评估流程**：收到操作请求 → 构建 GuardContext → 遍历匹配的规则 → 返回最严格的 verdict
3. **审计集成**：每次 evaluate 结果写入 audit-log（type: "l0_boundary"）
4. **接入点**：evolution-engine 执行前调用 guard.evaluate()；brain-api 处理请求时调用

**改动文件**：

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/services/constitutional-guard.ts` | 规则引擎核心 |
| 新建 | `data/constitutional.yaml` | 声明式规则文件 |
| 修改 | `src/services/evolution-engine.ts` | runEvolutionCycle 前调用 guard.evaluate() |
| 修改 | `src/brain-api.ts` | 请求处理前调用 guard（信任模式门控） |
| 修改 | `src/server.ts` | 新增 `/admin/api/guard-rules` 端点（查看/重载规则） |

**复杂度**：中 | 预估 1 session

**风险点**：
- 条件表达式解析：用简单 JS eval 有安全风险，建议用白名单比较器（`==`, `>=`, `<`）而非通用 eval
- 规则冲突：多条规则匹配时的优先级——建议"最严格优先"（deny > requires_confirmation > allow）
- 热重载竞态：文件写入过程中读取可能读到不完整 YAML

---

### P1-D: 否决螺旋检测

**目标**：检测 brain 策略被连续否决的模式，自动触发降级和元认知反思，防止 brain 在错误方向上持续消耗。

**依赖**：
- steering-tax.ts — 纠正检测（deny 信号来源）
- trust-state.ts（P1-A）— 否决导致信任衰减 + 模式降级
- CLAUDE.md 元认知触发器 — 集成现有反思框架

**核心数据结构**：

```typescript
// src/services/veto-spiral.ts

interface VetoCounter {
  readonly consecutiveDenials: number;    // 连续否决次数
  readonly lastDenialAt: string;
  readonly currentDirection: string;      // 当前策略方向描述
  readonly denialHistory: ReadonlyArray<{
    timestamp: string;
    reason: string;
    correctionType: string;
  }>;
}

interface SpiralAlert {
  readonly level: "warning" | "critical";   // 3次=warning, 5次=critical
  readonly consecutiveDenials: number;
  readonly action: "pause_and_reflect" | "degrade_to_conservative";
  readonly metacognitionPrompt: string;     // 注入给模型的反思 prompt
}

// 阈值常量
// SPIRAL_WARNING_THRESHOLD = 3   → 暂停 + 元认知反思
// SPIRAL_CRITICAL_THRESHOLD = 5  → 降级保守模式 + 请求用户校准
```

**核心逻辑**：

1. **计数器更新**：每次 steering-tax 检测到纠正 → `incrementDenial()`
2. **重置条件**：成功交互（无纠正）→ `resetCounter()`；用户明确认可 → `resetCounter()`
3. **螺旋检测**：
   - 连续 3 次 → 生成 warning SpiralAlert，注入元认知反思 prompt
   - 连续 5 次 → 生成 critical SpiralAlert，调用 trust-state 强制降级到 conservative
4. **反思 prompt 模板**：
   ```
   [元认知] 触发信号：否决螺旋（连续 {n} 次被纠正）
   - 当前策略方向：{direction}
   - 最近否决原因：{reasons}
   - 请分析：我的推断基于什么假设？这个假设哪里有问题？
   - 建议：暂停当前方向，等待用户重新校准
   ```

**改动文件**：

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/services/veto-spiral.ts` | 否决计数 + 螺旋检测 + 反思生成 |
| 新建 | `data/veto-state.json` | 持久化当前计数器状态 |
| 修改 | `src/services/steering-tax.ts` | recordCorrection 后调用 veto-spiral.incrementDenial() |
| 修改 | `src/brain-api.ts` | 成功交互后调用 resetCounter()；检测到 alert 时注入反思 prompt |
| 修改 | `src/services/trust-state.ts`（P1-A） | 接收 critical alert 后强制设 mode=conservative |
| 修改 | `src/server.ts` | 新增 `/admin/api/veto-spiral` 端点 |

**复杂度**：低中 | 预估 0.5 session

**风险点**：
- "连续"的定义：同一 session 内连续 vs 跨 session 连续？建议跨 session（持久化计数器）
- 误报：用户连续问不同问题但都触发纠正检测 → 实际不是螺旋。建议加"同一方向"判断
- 与 P1-A 的循环依赖：veto-spiral 调 trust-state 降级，trust-state 的 deny 事件又触发 veto-spiral。需要设防重入标志

---

## III. 与记忆系统对齐的关系分析

### P1-B（Skill 沉淀）vs 记忆系统规则驱动方案

**结论：不冲突，互补关系。**

| 维度 | Skill 沉淀（P1-B） | 记忆系统（BLUEPRINT） |
|------|-------------------|---------------------|
| 记忆类型 | 程序性记忆（how to do） | 陈述性记忆（what happened） |
| 存储位置 | `data/skills-registry.json` | `data/memory-items.md` |
| 驱动方式 | 代码逻辑（TypeScript） | LLM + 规则文档（memory-rules.md） |
| 触发时机 | 复杂任务完成后（>5 工具调用） | 每次交互后（post-hook 提取事实） |

两者可以共存：一次复杂交互后，skill-lifecycle 判断是否沉淀 Skill，同时 memory post-hook 提取事实写入 memory-items。

### Constitutional Guard vs memory-rules.md

**结论：格式可借鉴，但 scope 不同。**

- Constitutional Guard 的规则是**运行时门控**（allow/deny/confirm），用 YAML
- memory-rules.md 是**LLM 行为指导**（如何提取事实、如何检测矛盾），用自然语言
- 建议：Guard 规则用结构化 YAML，memory 规则继续用自然语言 markdown（LLM 更容易理解）

### 优先级建议

```
推荐执行顺序：

Phase 2 四项 P1（本文档）          记忆对齐（BLUEPRINT）
─────────────────────          ──────────────────
P1-A: TrustState 量化     ←→   可并行：BLUEPRINT P0（抽取 memory-rules.md）
P1-C: Constitutional Guard ←→   可并行：BLUEPRINT P1（post-hook + items 读写器）
P1-D: 否决螺旋检测        ←→   可并行：BLUEPRINT P2（每日巩固 scheduler）
P1-B: Skill 自主沉淀       →    之后：BLUEPRINT P3（Admin UI 记忆面板）
```

理由：
1. P1-A 和 P1-C 是基础设施，其他模块依赖它们
2. P1-D 依赖 P1-A（trust-state 降级），但代码量小，可与 P1-A 同 session
3. P1-B 最复杂且独立性最高，放最后
4. 记忆对齐 P0-P2 与 Phase 2 无硬依赖，可并行推进

---

## IV. 文件分工表（并行 Agent 策略）

### 可并行的两组

**Agent 组 1：信任+否决（P1-A + P1-D）**
- 新建 `src/services/trust-state.ts`
- 新建 `src/services/veto-spiral.ts`
- 新建 `data/trust-state.json`、`data/trust-events.jsonl`、`data/veto-state.json`
- 修改 `src/services/steering-tax.ts`（增加 trust/veto 触发）
- 修改 `src/brain-api.ts`（approve 事件 + 反思注入）

**Agent 组 2：宪法守卫（P1-C）**
- 新建 `src/services/constitutional-guard.ts`
- 新建 `data/constitutional.yaml`
- 修改 `src/services/evolution-engine.ts`（接入 guard）

**串行：Skill 沉淀（P1-B）**——依赖组 1 和组 2 完成后的接口
- 新建 `src/services/skill-lifecycle.ts`
- 新建 `data/skills-registry.json`、`data/skill-candidates.jsonl`
- 修改 `src/brain-api.ts`（候选检测）
- 修改 `src/services/evolution-engine.ts`（Skill 创建纳入管道）

**最后统一：Admin UI + server.ts + 版本升级**
- 修改 `src/server.ts`（4 个新端点）
- 修改 `src/admin/admin-ui.html`（信任度/Guard/Skill/螺旋面板）
- 更新 `package.json` + `src/server.ts` 版本号 → v0.8.0

### 文件冲突风险矩阵

| 文件 | 组1 改 | 组2 改 | P1-B 改 | 冲突风险 |
|------|-------|-------|---------|---------|
| `steering-tax.ts` | ✅ | - | - | 无 |
| `brain-api.ts` | ✅ | ✅ | ✅ | **高**（三组都改）→ 建议串行 |
| `evolution-engine.ts` | - | ✅ | ✅ | 中（两组改）→ 不同函数，可并行 |
| `server.ts` | - | - | - | 无（统一最后改） |
| `admin-ui.html` | - | - | - | 无（统一最后改） |

**关键约束**：`brain-api.ts` 是交叉点，组 1 和组 2 并行时各自标注修改位置，最后由主 Agent 合并。

---

## V. Agent Prompt（精确到代码片段级）

### Agent 组 1 Prompt：TrustState + VetoSpiral

```
你的任务：实现 brain Phase 2 的 P1-A（TrustState 量化）和 P1-D（否决螺旋检测）。

## 背景
brain v0.7.0，Phase 1 已完成。现在要实现信任度量化和否决螺旋检测。

## 需要新建的文件

### 1. src/services/trust-state.ts
功能：信任分数自动计算 + 衰减 + 模式映射

数据结构参考 MANIFESTO.md：
- trust_score = Σ(approve × weight) - Σ(deny × weight) - decay(time)
- approve 权重：预测准确 +3, 主动服务被采纳 +2, 日常无误 +1
- deny 权重：被纠正 -2, 被拒绝 -1, 造成回滚 -5
- 衰减：每 24h 衰减 5%
- 模式映射：<30 conservative, 30-70 standard, ≥70 autonomous
- 初始值：50（standard 模式）

导出函数：
- recordTrustEvent(event: TrustEvent): void — 写入 trust-events.jsonl + 更新 trust-state.json
- getTrustState(): TrustState — 读取当前状态（含 lazy 衰减计算）
- forceTrustMode(mode: string): void — 被 veto-spiral 调用，强制降级

持久化：
- data/trust-state.json — 当前快照
- data/trust-events.jsonl — 事件流（append-only）

### 2. src/services/veto-spiral.ts
功能：检测连续否决模式，触发元认知反思和信任降级

常量：SPIRAL_WARNING = 3, SPIRAL_CRITICAL = 5

导出函数：
- incrementDenial(reason: string): SpiralAlert | null — 递增计数，检查阈值
- resetCounter(): void — 成功交互后重置
- getVetoState(): VetoCounter — 当前状态

持久化：data/veto-state.json

逻辑：
- 3 次连续 → 返回 warning alert（含反思 prompt）
- 5 次连续 → 返回 critical alert + 调用 trust-state.forceTrustMode("conservative")
- 成功交互 → resetCounter()
- 防重入：critical alert 触发降级时不递归触发新的 deny 事件

### 3. 修改 src/services/steering-tax.ts
在 recordCorrection() 函数末尾增加两行调用：
- import { recordTrustEvent } from './trust-state.js'
- import { incrementDenial } from './veto-spiral.js'
- 调用 recordTrustEvent({ eventType: "deny", category 映射自 correctionType, weight 映射 })
- 调用 incrementDenial(correction.correctionType)

correctionType → trust 映射：
- explicit_deny → "corrected", weight: -2
- redirect → "corrected", weight: -2
- undo_request → "rollback", weight: -5
- repeat_request → "rejected", weight: -1
- frustration → "rejected", weight: -1

### 4. 修改 src/brain-api.ts（只标注不执行，等主 Agent 合并）
需要增加的位置：
- 成功响应后：recordTrustEvent({ eventType: "approve", category: "routine_ok", weight: 1 })
- 成功响应后：vetoSpiral.resetCounter()
- 检测到 SpiralAlert 时：将 metacognitionPrompt 注入 system message

## 规范
- 所有 interface 用 readonly 字段（不可变）
- 异步写入用 appendFileSync（审计级别数据不能丢）
- 每个写操作都要调 writeAuditLog()
- 不引入新依赖，只用 fs/path
```

### Agent 组 2 Prompt：Constitutional Guard

```
你的任务：实现 brain Phase 2 的 P1-C（Constitutional Guard 声明式规则引擎）。

## 背景
brain v0.7.0。需要用声明式 YAML 规则替代散落的 if/else 权限检查。

## 需要新建的文件

### 1. data/constitutional.yaml
初始规则集（5-8 条）：
- l0-write-deny: 禁止写入 MANIFESTO.md / SOUL.md / constitutional.yaml
- l1-evolution-gate: 进化操作必须 fitness_delta > 0
- daily-risk-limit: 单日风险分 >= 100 时拒绝进化
- trust-conservative-gate: conservative 模式下非只读操作需确认
- audit-log-protect: 审计日志文件不可删除或覆盖

规则格式：
```yaml
version: 1
rules:
  - id: string
    scope: string          # "file:write" | "evolution:execute" | "action:non-readonly"
    target?: string[]      # 目标列表
    condition?: string     # 简单条件："key op value"（仅支持 ==, !=, >=, <=, >, <）
    verdict: "allow" | "deny" | "requires_confirmation"
    fallback?: "allow" | "deny"
    reason: string
```

### 2. src/services/constitutional-guard.ts

导出函数：
- evaluate(context: GuardContext): GuardResult — 遍历规则，返回最严格 verdict
- loadRules(): GuardRule[] — 从 YAML 解析规则
- reloadRules(): void — 热重载

GuardContext：
```typescript
interface GuardContext {
  readonly action: string;        // 如 "file:write", "evolution:execute"
  readonly target?: string;
  readonly trustMode: "conservative" | "standard" | "autonomous";
  readonly dailyRiskScore: number;
  readonly fitnessDelta?: number;
}
```

条件评估：不用 eval()，用白名单比较器解析 "key op value" 格式：
- 解析条件字符串为 { key, operator, value }
- 从 context 中取 key 对应的值
- 执行比较返回 boolean
- 不支持的格式 → 默认 true（条件通过）

优先级：deny > requires_confirmation > allow（最严格优先）

### 3. 修改 src/services/evolution-engine.ts
在 runEvolutionCycle() 函数中，现有的 isRiskLimitExceeded() 检查之后，增加：
- import { evaluate } from './constitutional-guard.js'
- 构建 GuardContext，调用 evaluate()
- verdict === "deny" → 写审计日志 + 返回 null
- verdict === "requires_confirmation" → 写审计日志 + 返回 null（自动模式不支持确认）

### 4. 修改 src/brain-api.ts（只标注不执行，等主 Agent 合并）
需要增加的位置：
- 请求处理前：evaluate({ action: "action:non-readonly", trustMode: currentTrustMode, ... })
- verdict 为 deny/requires_confirmation 时，返回相应提示

## 规范
- YAML 解析：用 js-yaml 库（如果已有）或手写简单解析器
- 规则文件 watch：用 fs.watchFile 或启动时加载 + 提供 reload API
- 每次 evaluate 结果都写 audit-log
```

---

## VI. 部署流程

```bash
# 1. 开发完成后，更新版本号（三处同步）
# package.json: "version": "0.8.0"
# src/server.ts: 启动横幅 "mycc-brain v0.8.0"
# src/server.ts: /admin/api/status 响应 version: "0.8.0"

# 2. Admin UI 升版（如果有前端改动）
# src/admin/admin-ui.html: ADMIN_UI_VERSION = "v2.8"

# 3. 构建 + 部署
cd 2-Projects/brain-product/mycc-brain
bash deploy.sh

# 4. 验证
ssh studio-pub "pm2 logs brain --lines 10 --nostream"
# 确认版本号正确、无报错

# 5. 端点验证
curl -s https://<tunnel>/admin/api/status | jq '.version'
curl -s https://<tunnel>/admin/api/trust-state
curl -s https://<tunnel>/admin/api/guard-rules
curl -s https://<tunnel>/admin/api/veto-spiral
curl -s https://<tunnel>/admin/api/skills
```

---

## VII. 验收标准

### P1-A: TrustState
- [ ] A1: trust-state.json 正确初始化（score=50, mode=standard）
- [ ] A2: steering-tax 检测到纠正 → trust_score 正确下降
- [ ] A3: 成功交互 → trust_score 正确上升
- [ ] A4: 24h 未活动后 score 衰减 5%
- [ ] A5: score 跨越阈值时 mode 自动切换
- [ ] A6: `/admin/api/trust-state` 返回正确数据
- [ ] A7: 所有信任事件写入 audit-log

### P1-B: Skill 自主沉淀
- [ ] B1: >5 工具调用的成功任务触发候选检测
- [ ] B2: 候选写入 skill-candidates.jsonl
- [ ] B3: skills-registry.json 正确维护 Skill 生命周期状态
- [ ] B4: 30 天未使用的 Skill 标记为 aging
- [ ] B5: `/admin/api/skills` 返回注册表数据
- [ ] B6: Skill 创建事件写入 audit-log

### P1-C: Constitutional Guard
- [ ] C1: constitutional.yaml 加载成功，规则数 ≥ 5
- [ ] C2: 尝试写入 MANIFESTO.md → verdict=deny
- [ ] C3: 每日风险分超限 → 进化被阻止
- [ ] C4: conservative 模式下非只读操作 → requires_confirmation
- [ ] C5: `/admin/api/guard-rules` 返回当前规则列表
- [ ] C6: 所有 evaluate 结果写入 audit-log

### P1-D: 否决螺旋检测
- [ ] D1: 连续 3 次纠正 → warning alert 生成
- [ ] D2: 连续 5 次纠正 → critical alert + trust 降级到 conservative
- [ ] D3: 成功交互后计数器重置
- [ ] D4: 反思 prompt 正确注入 system message
- [ ] D5: `/admin/api/veto-spiral` 返回当前状态
- [ ] D6: 无重入循环（降级不触发新的 deny → veto 递归）

### 整体
- [ ] E1: 版本号 v0.8.0 三处一致
- [ ] E2: Admin UI 新增面板可正常访问
- [ ] E3: 所有新端点返回正确 JSON
- [ ] E4: deploy.sh 部署成功，pm2 无报错

---

## VIII. 不做的事

1. **不实现 L3 受控增殖**——Phase 3+ 的内容
2. **不实现辩证用户建模**——P2 优先级，Phase 2 不做
3. **不重构现有 evolution-engine**——只增加接入点，不改核心逻辑
4. **不实现 memory-rules.md 的 LLM 记忆处理**——属于 BLUEPRINT 路线，可并行但不在本 Phase 范围
5. **不创建 SOUL.md**——发现文件不存在，但 soul-loader.ts 已在工作（可能加载其他内容），不在本次范围改动

---

## IX. 可粘贴提示词（下个 Session 用）

```
读取 2-Projects/brain-product/HANDOFF-phase2-quantifiable.md，这是 Phase 2（可量化）的完整实施方案。

Phase 1 已完成（v0.7.0），现在要实现 Phase 2 四项 P1：
- P1-A: TrustState 量化（信任分数自动计算）
- P1-B: Skill 自主沉淀（>5 工具调用触发）
- P1-C: Constitutional Guard（声明式规则引擎）
- P1-D: 否决螺旋检测（连续否决自动降级）

执行策略：
1. 并行启动 Agent 组 1（P1-A + P1-D）和 Agent 组 2（P1-C）
2. 合并 brain-api.ts 的修改（三组都改这个文件）
3. 串行执行 P1-B（依赖组 1 和组 2 的接口）
4. 统一改 server.ts + admin-ui + 版本号
5. 部署验证

HANDOFF 中有精确到代码片段的 Agent Prompt，直接用。
```
