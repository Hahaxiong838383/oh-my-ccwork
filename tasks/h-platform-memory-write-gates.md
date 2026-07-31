# H 平台记忆写入门（五道提交门 + score-before-update）

> 创建：2026-07-31 | 状态：待评审（方案，未实施）
> 来源：arXiv 2607.26598 *Living-Harness Is an Interactive-Agent Evolver* 的可搬件 ①
> 生产真值取自 dev198 `~/feishu-grok-bridge` HEAD `c752892`（2026-07-31 已验证）

## 目标

给 H 平台**已有**的记忆写入路径补两样东西：**写入侧提交门**和**先评分后写入的时序**。
不新建系统、不碰工具集、不改 owner 行为。

---

## 一、现状真值（已验证 · 非推断）

### 写入链路

| 环节 | 位置 | 现状 |
|---|---|---|
| 调用点 | `bridge.mjs:3289` | `void captureExchange(ctx.uid, { userText: mergedBody, replyText: reply, log })` |
| 实现 | `lib/memory-capture.mjs:120` | `captureExchange(uid, {userText, replyText, log})`，永不抛，失败只记日志 |
| 触发时机 | 回复投递完成后**立即** fire-and-forget | 不阻塞回复（这个设计是对的，保留） |
| 生效范围 | `ctx.kind === 'user'`（owner 走 `appendFriction`） | owner 不受影响 |

### 已有的七道门（`captureExchange` 内部，按执行顺序）

1. **隐私门** `classifyHr()` — HR/人事类一律不入库，且不记原文
2. **长度门** `MIN_CHARS = 8`，`SIGNAL_RE` 命中可旁路
3. **LLM 抽取门** — 五类才认，否则输出「无」
4. **格式门** — 必须 `- ` 开头、长度 > 4、单条截 300 字、最多 3 条
5. **输入去重** — `hashOf(userText)` → `dup-input`
6. **落点门** — `files.project[0] || files.global[0]`，无落点则 `no-target`
7. **产出去重** — 逐行哈希 + 目标文件正文归一化包含检查

底子比论文想象的好。缺的不是"有没有门"，是**门里缺了哪一维**。

### 关键缺口（本方案的起点）

已逐点核实（`grep -n "captureExchange" bridge.mjs`，全仓仅 3289 一个真实调用点，
4744 是 history-backfill 的函数注册）：

| 路径 | 位置 | 是否写记忆 | 摩擦信号 |
|---|---|---|---|
| 成功送达 | `bridge.mjs:3289` | ✅ `captureExchange` | owner→`appendFriction({ok:true})` |
| 失败 | `bridge.mjs:3385` 附近 | ❌ **不写** | owner→`appendFriction({ok:false})`；user→`appendUserFriction({kind,ok:false})` |

所以缺口**不是**「失败也照写」—— 失败根本不走写入路径。真实缺口更隐蔽：

**`delivered`（回复成功送达）被当成了「任务成功」的代理，而两者不是一回事。**

`captureExchange` 位于 `durableDelivery` 成功之后，此时唯一进入抽取上下文的"证据"
是 `replyText` —— **Bot 自己说的话**。Bot 谎报时（07-30 16:10 已实证并做过一轮
根治，`4e60dd7` 审计 wrapper），回复说「已为您创建日程」、送达成功、
`captureExchange` 就把「已完成 X」写进用户长期记忆。**这是自证**，正是论文
evidence gate 明令禁止的：更新必须 grounded in evaluator feedback，不能来自
agent 自身输出。

两条已有管道**互不连通**：
- `appendUserFriction`（`lib/user-friction.mjs`）已在采集 user 侧成败，
  `FRICTION_KINDS = ['task_ok','task_error','timeout','max_turns','stopped']`
- `lark-audit`（`lib/lark-audit.mjs`）已有**独立于 Bot 自述**的工具调用真实记录，
  行格式 `<iso>\tuid=<uid>\tpid=<pid>\tcmd=<域 子命令 …>`，
  `parseAuditLine()` 返回 `{at, uid, pid, cmd, head, kind}`，`kind ∈ {write, read}`，
  07-31 刚做到 9/9 租户覆盖

**记忆写入路径两个都没接。** 论文的全部价值就是把 evaluator 信号接进写入门 ——
H 平台两端都已具备，缺的只是那根线。

> 与 `tasks/mycc-scheduler-accounting.md` 的
> 「`adapter.chat` 只有成功一种结局，四天连记 ✅ 成功」同源：下游记账采信了
> 上游的自述而非客观态。区别是 scheduler 污染日志，这里污染用户长期记忆。

---

## 二、论文五门 vs 现状差距

| 论文门 | 现状 | 差距 | 优先级 |
|---|---|---|---|
| **evidence**（必须有 evaluator 反馈支撑） | **完全缺** | 成功失败一视同仁照写 | 🔴 G1 |
| **scope**（提交到正确任务族） | 缺 | 落点是「第一个找到的文件」，无任务族概念 | 🟡 G3 |
| **schema**（结构化字段 + confidence） | 部分 | 是自由文本行，无 kind/confidence/来源 | 🟡 G4 |
| **merge**（语义哈希合并 + 累积支持度） | 部分 | 有双哈希去重，但**重复即丢弃**，不累积支持度 | 🟡 G5 |
| **constraint**（不得覆盖冻结域规则） | 部分 | 隐私门有；无「不得与既有硬规则冲突」这层 | ⚪ 暂不做 |

论文消融：去掉 SOP 门控掉 9.71 分，比去掉记忆本体（5.75）和状态图（3.59）都多。
**约束比内容更重要** —— 所以先补门，不急着扩大写入量。

---

## 三、改动清单

### G1 · evidence gate（最高收益，当天可做）

**判据**：区分记忆行的两种来源，只对后者要求外部证据。

| 来源 | 例 | 证据要求 |
|---|---|---|
| **用户侧断言** | 偏好、决定、待办、约定 | 用户说的就算数，与任务成败无关，**不设门** |
| **助手侧断言** | 「已完成 X」「已创建 Y」 | 是 Bot 自述，**必须有 audit 佐证** |

现状把两者混在一起交给同一个 PROMPT，所以第二类拿不到任何外部约束。

**改 `bridge.mjs:3289`** — 传入本块已有变量，零新增计算：

```js
if (ctx.kind === 'user') {
  void captureExchange(ctx.uid, {
    userText: mergedBody,
    replyText: reply,
    log,
    evidence: {
      delivered: Boolean(delivered),  // 已有：送达成功 ≠ 任务成功，仅作时间锚
      sec,                            // 已有
      startedAt: Date.now() - sec * 1000,  // audit 时间窗下界
    },
  })
  // ... 现有 .then/.catch 不变
}
```

**改 `lib/memory-capture.mjs`** — 抽取之后、写盘之前，逐行过 audit 交叉验证：

```js
// evidence gate（Living-Harness §B.2）：助手侧的「已完成」断言必须有
// 独立于 Bot 自述的证据。lark-audit 由 wrapper 层记录，Bot 改不了它 ——
// 这是本平台最接近 evaluator feedback 的客观信号。
// 用户侧断言（偏好/决定/待办）不受此门约束：那是用户说的，不是 Bot 说的。
const DONE_RE = /已(完成|创建|新建|发送|提交|更新|修改|删除|添加|安排|预约)|建好了|发出去了|搞定/
const gateOn = String(process.env.H_MEMORY_EVIDENCE_GATE || '1') !== '0'
if (gateOn && o.evidence?.startedAt) {
  const wrote = await hadWriteCall(uid, o.evidence.startedAt)  // 见下
  if (!wrote) {
    const before = fresh.length
    fresh = fresh.filter((l) => !DONE_RE.test(l))
    if (fresh.length < before) {
      log('evidence gate dropped unsupported claim', uid, `${before - fresh.length} 条`)
    }
    if (!fresh.length) return { written: 0, skipped: 'no-evidence' }
  }
}
```

`hadWriteCall` 复用 `lib/lark-audit.mjs` 现成的 `auditLogPathFor` + `parseAuditLine`：
读该 uid 的 audit 日志尾部，判断 `[startedAt, now]` 窗口内是否存在 `kind === 'write'`
的记录。**只读不写**，日志缺失时**fail-open**（返回 true，不拦）—— 审计尚未对该租户
开启时不能误伤，且 fail-open 必须配可观测，见下方验收。

- **回滚**：`H_MEMORY_EVIDENCE_GATE=0`
- **验收（三段，缺一不可）**：
  1. **谎报被拦**：让 Bot 在无权限场景下声称完成（自然触发，别提示），
     确认日志出现 `evidence gate dropped unsupported claim`，且记忆文件无「已完成」行
  2. **真做不被误伤**：跑一次真实成功的写类任务，确认记忆正常写入、无 drop 日志
  3. **用户侧不受影响**：发一句纯偏好（如「以后都用这个格式」），确认照常写入
- **验收禁忌**：prompt 里**不许**出现「这次会失败」「不要记」之类措辞 ——
  07-31 已踩过「探针自带答案」（`verify-audit-coverage.mjs` 自注入 `H_LARK_AUDIT:'all'`）。
- **fail-open 可观测**：`hadWriteCall` 因日志缺失而放行时必须打一条独立日志，
  否则「门没拦」和「门没跑」在输出上同形 —— 这是 `feedback_verification_path_vs_production_path`
  记过的坑，fail-open 不配观测等于把报错换成日后错结论。

### G2 · score-before-update 时序

论文原文（§B.1）：episode 先跑完 → evaluator 打分 → **分数落盘后**才提取证据写入；
任务内的反思缓冲用完即弃，绝不直接进持久记忆。

H 平台没有 benchmark evaluator，但有**三级可用信号**：

| 级 | 信号 | 何时可得 | 成本 |
|---|---|---|---|
| L1 | runner `ok` + `sec` | 同 tick | 0（G1 已覆盖） |
| L2 | 飞书 ACK `delivered` | 同 tick | 0（G1 已覆盖） |
| L3 | **用户下一轮反馈** | 下一轮消息 | 需 pending 缓冲 |

- **阶段 A（做）**：L1 + L2 —— 就是 G1，零额外时序改动。
- **阶段 B（先不做，记着）**：L3 负反馈撤回。把本轮写入标 `pending`，
  下一轮用户消息若命中负反馈词（`不对|还是不行|重来|错了|不是这个|我说的是`），
  撤回上一轮 pending 条目。
  **成本**：要给 `seen` 库加状态机 + 跨轮上下文，且撤回本身是新的失败面。
  **建议**：等 G1 跑满两周、`no-evidence` 命中率有数了再决定。

### G3 · scope gate

现状 `files.project[0] || files.global[0]` = 落到第一个找到的文件。
论文要求提交到对应 task family，检索时同族优先（top-k=3）。

最小改法：复用 `lib/task-hints.mjs` 已有的意图识别（`isCalendarWriteTask`）
作为第一个 family 标签，写入时在行尾附 `<!-- family:calendar -->`。
**先只做标注不做路由** —— 有了标签才谈得上按族检索，反过来不成立。

### G4 · schema gate 升级

`lib/memory-lifecycle.mjs` **已经有**现成的枚举，直接复用，不要另造：

```js
MEMORY_KINDS = new Set(['fact', 'rule', 'decision', 'gotcha'])
MEMORY_COGNITIVE_TYPES = new Set(['episodic', 'semantic'])
MEMORY_LIFECYCLES = new Set(['short', 'mid', 'long'])
```

改法：让抽取 PROMPT 输出 `- [kind] 正文` 形式，解析时校验 kind ∈ MEMORY_KINDS，
不合法的走一次修复重试，再不合法**直接丢弃**（论文：malformed 给一次修复机会，
仍违反 schema 则 discard）。

### G5 · merge gate 加累积支持度

现状：重复内容 → `skipped: 'dup'` → **静默丢弃**。
论文：语义相似则**合并并累加 confidence**。

差别很实际：同一条偏好用户说了 5 次，说明它比只说过 1 次的重要得多，
但现在第 2~5 次全被当噪音扔了，系统反而不知道它更重要。

最小改法：`seen` 库从 `Set` 升为 `Map<hash, {count, firstAt, lastAt}>`，
命中重复时 `count++` 而非直接 return。`count >= 3` 的条目在记忆文件里标 `★`。
**不改写入量，只改权重可见性** —— 风险最低的一档。

---

## 四、论文帮不了的部分（必须自己补）

作者在 Limitations §D 明确承认**没有**这三样，而你的规模已经和它实验同量级
（论文 MultiWOZ-Restaurant 域 3 轮攒到 951 条记忆；你的 A canonical 现在 719 条）：

| 缺口 | 论文原话 | 你的现状 |
|---|---|---|
| 回滚 | "do not provide full rollback" | 无。写进用户记忆文件后只能手改 |
| 陈旧条目清除 | "no systematic stale-entry removal" | 无。过期偏好会永久影响检索 |
| 回归测试 | "no regression testing over previously solved tasks" | 无。改门之后无法证明旧行为没坏 |

**这三样比五道门更值得做**，但不在本方案范围（本方案 = 可搬件 ①）。
论文还有一处隐患值得记：状态膨胀不收敛，Retail 域边数三轮 `+456/+456/+456`
完全线性，无饱和迹象 —— 别指望它自己稳住。

---

## 五、边界（不做什么）

- **不碰工具集与基础上下文** —— 论文的冻结原则，也是 H 平台 owner 零影响的要求
- **不动 `evolve-advisor.mjs` 的人在回路** —— 论文是全自动无人审核，你现在的
  卡片式决策（`buildDecisionPackage` / `parseEvolveDecision`）**比论文更保守**，
  这是优点不是差距，不要为了对齐论文把它改成自动
- **不做全自动 harness 演化** —— 论文八个环境全是模拟器，有 evaluator 定义的
  成功标准；H 平台是真实多租户飞书用户，不具备该前提
- **owner 路径零改动** —— 本方案只动 `ctx.kind === 'user'` 分支

---

## 待办

- [x] 前置核查（2026-07-31 完成）：全仓仅 `bridge.mjs:3289` 一个真实调用点，
      位于成功送达分支；失败路径不写记忆。**G1 前提据此重写**（原设想的
      「失败降级」不成立，真缺口是 delivered 被当成 ok、Bot 自述即证据）
- [ ] G1 evidence gate（`hadWriteCall` + `H_MEMORY_EVIDENCE_GATE` 开关 +
      单测 + 三段真机验收 + fail-open 可观测）
- [ ] G5 merge 支持度计数（低风险，可与 G1 同批）
- [ ] G4 schema kind 校验（复用 memory-lifecycle 枚举）
- [ ] G3 scope family 标注（只标不路由）
- [ ] 观察两周：统计 `no-evidence` / `dup` 命中率，再决定 G2 阶段 B
- [ ] 部署前按铁律核「远端↔线上同源」：healthz 版本 + md5 对撞 + `git log` 双向

## 进度记录

- 2026-07-31：方案成文。生产代码结构已在 dev198 `c752892` 上逐项核实
  （写入链路 / 七道现有门 / 成败信号位置 / memory-lifecycle 枚举 /
  lark-audit 行格式 / user-friction 字段）。未实施，未部署。
- 2026-07-31：**G1 首版写错并已更正**。原稿假设「失败分支也调 captureExchange，
  故失败时降级」，核查证伪：失败路径根本不写记忆。真实缺口是
  `delivered ≠ ok`、Bot 自述被当成证据。改为接 lark-audit 做交叉验证。
