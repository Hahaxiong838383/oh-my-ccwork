# 评审 Findings：P003「小可」记忆 + 交互合一宏观架构方案

## 0. 结论先行

### 总判断

【建议】P003 不应照搬 PRD 的 Redis + Qdrant + Event Log + Graphiti 全套北极星架构；应落地一个 **SQLite 单存储内的 CQRS-lite + turn/version 协议 + 保守记忆写入策略**。

目标不是“把所有记忆基础设施一次建完”，而是先证明三件事：

1. **语音交互不断、不乱、不回声**：已有 `activeTurn` / `playbackGeneration` / React FSM 分层 version 继续保留，不合并成一个全局 version。
2. **记忆不脏写、可解释、可修正**：新增最小 append-only 记忆事件表 + 来源优先级仲裁 + 候选状态门控。
3. **小可真的显得记得好**：把已有 `profile-store` 作为当前画像投影，强化抽取质量、保守提交、prompt 使用方式，而不是 P0 急着上向量库或 graph。

### 最重要架构判断

【建议】**versioned state / turn 一致性是记忆与交互合一的枢纽，但不能是“一个 turnVersion 统治三层”。**

正确做法是：

> 统一协议，不统一变量；统一事件关联，不统一状态机。

P003 应使用一组 version vector / lifecycle id：

| 层 | version / id | 作用 |
|---|---|---|
| React FSM | `fsmEpoch` / local state version | 防 UI reducer 旧状态覆盖新状态 |
| 前端播放 | `playbackGeneration` | 防旧 TTS 音频继续播放；与对话轮次正交 |
| Server pipeline | `serverTurnId` / `activeTurn` | 防旧 ASR/LLM/TTS 回调污染当前轮 |
| Assistant response | `responseId` | 区分同一 user turn 下不同 assistant 输出实例 |
| Memory ingestion | `candidateBatchId` / `memoryCandidateId` | 冷路径候选写入生命周期 |
| Memory projection | `memorySeq` / `projectionVersion` | 标识 prompt 使用的是哪一版记忆快照 |

它们之间通过 `session_id + turn_id + response_id + playback_generation + memory_seq` 关联，而不是压成一个 `turnVersion`。

---

# 1. 宏观合一架构

## 1.1 分层图

```text
┌──────────────────────────────────────────────────────────────┐
│ Android Compose 薄壳 + WebView                               │
│                                                              │
│  React Voice FSM                                             │
│  - SLEEPING / LISTENING / THINKING / SPEAKING / ...          │
│  - fsmEpoch: 只管 UI/FSM 状态演进                             │
│                                                              │
│  voice-client                                                │
│  - playbackGeneration: 只管音频播放代次                       │
│  - discardTurnAtOrBelow: 丢弃旧 TTS 音频                      │
└───────────────────────────────┬──────────────────────────────┘
                                │ WebSocket events
                                │ 带 session_id / turn_id / response_id
                                │ / playback_generation
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Server Turn Coordinator / Pipeline                           │
│                                                              │
│  已有能力：                                                    │
│  - activeTurn: ASR / LLM / TTS 旧回调守卫                     │
│  - capturedTurnMeta: 轮内 meta 快照                           │
│                                                              │
│  建议新增逻辑概念：Turn Ledger                                │
│  - user turn lifecycle: LISTENING → ASR_FINAL → RESPONDING    │
│    → TTS_STREAMING → CLOSED / INTERRUPTED                     │
│  - assistant response lifecycle: GENERATED / PLAYING          │
│    / DISCARDED / DELIVERED                                    │
│                                                              │
│  热路径：                                                     │
│  - 只读 Context Snapshot                                      │
│  - profile-store projection                                  │
│  - curriculum KG 只读护栏                                     │
│  - 禁止 LLM 抽取记忆                                          │
│  - 禁止同步写记忆                                             │
└───────────────────────────────┬──────────────────────────────┘
                                │ committed transcript / tool event
                                │ / correction event
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Cold Memory Ingestion                                         │
│                                                              │
│  memory-extractor                                             │
│  - 已有异步抽取                                                │
│  - 已有 prompt 注入防护                                        │
│  - 已有 lost-update 防护                                       │
│                                                              │
│  建议新增：                                                    │
│  - Candidate FSM: DRAFT / PENDING / COMMITTED / DISCARDED     │
│  - 来源优先级仲裁                                              │
│  - correction 抢占 / supersede                                │
│  - 只消费 eligible turn，不消费 partial / discarded 输出       │
└───────────────────────────────┬──────────────────────────────┘
                                │ commit
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ SQLite Single Storage                                         │
│                                                              │
│  append-only memory_events                                    │
│  - P0: SQLite 表即可，不引入独立 Event Store                   │
│  - 用于审计、解释、回放雏形、revision chain                    │
│                                                              │
│  profile-store                                                │
│  - 当前 Working Set / 当前画像投影                             │
│  - 继续作为热路径读取源                                        │
│                                                              │
│  feedback-store                                               │
│  curriculum-kg                                                │
└──────────────────────────────────────────────────────────────┘
```

## 1.2 核心合一原则

### Finding 1：交互与记忆的统一点不是“状态机”，而是“事件边界”

【已验证事实】

- 交互层已有：
  - server `activeTurn`
  - front-end `playbackGeneration`
  - React FSM 重构中的 6 态 FSM
- 记忆层已有：
  - `profile-store`
  - `memory-extractor`
  - `curriculum-kg`
  - `feedback-store`

【判断】

交互线和记忆线真正需要共享的是：

1. 哪个 user turn 被 ASR final 确认；
2. 哪个 assistant response 实际被播放/未被丢弃；
3. 哪些事件可以作为记忆写入来源；
4. 哪版记忆被放入了 prompt。

不是共享一个全局 `turnVersion`。

【建议】

P003 应定义一个轻量事件契约：

```ts
TurnEvent {
  session_id
  turn_id
  response_id?
  playback_generation?
  event_type:
    | asr_partial
    | asr_final
    | llm_started
    | tts_started
    | tts_discarded
    | tts_delivered
    | user_barge_in
    | user_correction
    | tool_result
    | turn_closed
  timestamp
}
```

记忆冷路径只消费满足条件的事件：

- `asr_final` 且 `turn_id` 未被废弃；
- `user_correction` 优先处理；
- `tool_result` / game progress 可直接作为高可信来源；
- assistant 生成内容只有在确认 delivered 或 action committed 后，才允许影响记忆；
- partial ASR、被丢弃 TTS、旧 `activeTurn` 回调不进入记忆候选。

---

# 2. versioned state / turn 一致性：如何同时服务丝滑打断和记忆不脏写

## 2.1 不应合并的三类 version

### Finding 2：`activeTurn`、`playbackGeneration`、FSM version 不能合并

【已验证事实】

- `activeTurn` 是 server pipeline 轮次守卫。
- `playbackGeneration` 是前端音频播放代次。
- React FSM 的 version 是 UI reducer 的状态演进防护。

【判断】

三者语义不同：

| 机制 | 解决的问题 | 不能替代什么 |
|---|---|---|
| `activeTurn` | server 异步回调过期 | 不能表示客户端音频是否已经播放 |
| `playbackGeneration` | barge-in 后丢弃旧音频 | 不能表示 server 当前逻辑轮 |
| FSM version | UI 状态一致性 | 不能作为后端记忆提交依据 |

【建议】

使用“版本向量”而不是“单 version”：

```ts
InteractionEnvelope {
  session_id
  server_turn_id
  response_id
  playback_generation
  fsm_epoch
  memory_projection_version
}
```

每层只信任自己权威的 version，但跨层消息都带完整 envelope，方便丢弃旧消息、解释日志、复盘记忆来源。

## 2.2 记忆候选状态机与交互 turn 的关系

### Finding 3：PRD 的 DRAFT/PENDING/COMMITTED 应挂在冷路径，不应侵入语音热路径

【建议】

P003 可采用如下关系：

```text
ASR partial
  → 不产生记忆候选

ASR final
  → 如果 turn_id == activeTurn
  → 进入 memory extraction
  → 生成 DRAFT candidate

DRAFT
  → 来源高可信且无冲突：COMMITTED
  → 来源弱 / ASR 易漂移 / LLM 推断：PENDING
  → 被用户纠正 / 对应 turn 被废弃：DISCARDED

COMMITTED
  → append memory_events
  → update profile-store projection
  → memory_projection_version + 1
```

关键不变量：

> 热路径只读 `profile-store` 中已 committed 的 projection；DRAFT / PENDING 永不进入 prompt 当前真相。

这能同时满足：

- 打断时不写脏记忆；
- 当前响应不被冷路径阻塞；
- 记忆变化从下一轮开始生效；
- 未来可审计。

## 2.3 activeTurn 已覆盖了什么，没覆盖什么

### Finding 4：现有 `activeTurn` 已覆盖交互脏流，但没有完整覆盖记忆脏写

【已验证事实】

`activeTurn` 已经让 ASR / LLM / TTS 旧回调被丢弃。

【判断】

它覆盖了：

- 旧 LLM token 不应继续发；
- 旧 TTS 音频不应继续播；
- 旧 ASR callback 不应驱动当前响应。

但它没有天然覆盖：

1. 冷路径 memory-extractor 晚到后仍提交旧事实；
2. assistant 说了一半被打断，但系统把“已说出的内容”写成 game progress；
3. 用户马上纠正：“不是，我不是喜欢恐龙”，但上一轮兴趣已被 commit；
4. extractor 从近几轮 conversation history 抽取时，混入了已被 discard 的 assistant 输出。

【建议】

不用重做完整 PRD 的复杂 interrupt-safe 协议，但 P0 至少需要：

- memory extraction 输入必须是 **eligible transcript**，不是原始全量 history；
- 每条候选带 `turn_id` / `response_id` / `utterance_ref`；
- commit 前检查 turn / response 状态；
- user correction 可 supersede 同 SPO 的旧事件；
- assistant-derived memory 默认禁止，除非有 delivered/action ack。

---

# 3. PRD 增量 × P003 决策表

| PRD 要素 | P003 决策 | 阶段 | ROI | 理由 |
|---|---|---:|---:|---|
| Event Log / CQRS | **裁剪**：SQLite append-only `memory_events` + profile projection；不引入独立 Event Store | P0 | 高 | demo 需要审计、解释、纠错链；但全量 event sourcing / replay 工具 P0 过重 |
| Qdrant 向量召回 | **缓做**；P0 不上 Qdrant | P1/P2 | 低→中 | 儿童单用户 demo 记忆量小；已有结构化 profile + KG 更稳；新 infra 运维成本高 |
| Interrupt-safe 候选状态机 | **裁剪落地**：DRAFT/PENDING/COMMITTED 只在冷路径；不侵入热路径 | P0/P1 | 高 | activeTurn 覆盖流式回调，但不覆盖冷路径脏写；最小门控有价值 |
| bitemporal | **缓做**；P0 只保留 `valid_from` / `valid_to` / `revision_of` 字段 | P2/P3 | 低 | demo 不需要复杂 valid_time × tx_time 查询；schema 预留即可 |
| 来源优先级仲裁 | **照搬精神，裁剪实现** | P0 | 高 | 成本低，直接提升稳定性；但需区分 authority source 与 ASR observation quality |
| Redis Working Set | **不照搬**；继续用 SQLite profile-store + 进程内缓存 | P0 | 中 | 单进程、单用户 demo 不需要 Redis；profile-store 已是 Working Set 雏形 |
| stability 淘汰 | **裁剪**：先做 stable / ephemeral / pending 三档 | P0/P1 | 中 | 防止情绪、一次性 ASR 漂移污染长期画像 |
| 家长 audit / event replay | **分阶段**：P0 事件表打基础；P1 做家长可见审计/修订 | P1 | 中→高 | demo P0 不一定做完整 UI，但事件日志应从 P0 开始积累 |
| Graph / Graphiti | **缓做** | P2 | 低 | K12 多跳知识图谱已有只读 KG；个人记忆 demo 暂不需要 graph DB |
| 三存储架构 Redis + Qdrant + EventLog | **不照搬** | 非 P0 | 低 | 与 P003 单进程 SQLite 现实冲突，运维成本大于收益 |

---

# 4. demo MVP 最小增量：两周内最值得做什么

## 4.1 现状已有 X

【已验证事实】

P003 已经有：

1. `profile-store.ts`
   - SQLite profile
   - nickname / interests / personality_notes / recent_emotion / game_progress
   - 已经是当前画像投影雏形

2. `memory-extractor.ts`
   - turn 后异步抽取
   - 失败不影响语音主链路
   - prompt 注入防护
   - lost-update 防护

3. `curriculum-kg.ts`
   - 只读内存 KG
   - match <10ms
   - 不进入 ASR-final → first token 同步检索路径

4. 交互层
   - server `activeTurn`
   - front-end `playbackGeneration`
   - `tts.turn_discard`
   - React FSM 重构方向明确

所以 P0 不应该重建记忆系统，而是补齐“提交边界”和“可解释事件”。

---

## 4.2 只需补 Y

### P0-1：SQLite append-only 记忆事件表

【建议】

新增一个最小 `memory_events` 概念即可，不需要独立 infra。

字段建议：

```ts
MemoryEvent {
  event_id
  session_id
  child_id
  turn_id
  response_id?
  type:
    | fact
    | preference
    | skill_state
    | episodic
    | correction
    | invalidation
    | game_progress
  subject
  predicate
  object_json
  valid_from
  valid_to?
  tx_time
  source_authority:
    | user_explicit
    | user_correction
    | parent_edit
    | tool
    | game_state
    | llm_inference
  observation_quality:
    | asr_final
    | asr_uncertain
    | repeated
    | manual
  stability:
    | ephemeral
    | stable
    | persistent
  sensitivity
  confidence?
  utterance_ref?
  revision_of?
  metadata_json
}
```

### 关键修正：不要把“ASR”直接当作来源优先级

【判断】

PRD 里 `user_correction > parent_edit > tool > llm > asr` 的方向是对的，但 P003 有一个现实问题：

> 小可的所有儿童口头输入都经过云 ASR。  
> 如果把 ASR 一概视为低优来源，那几乎所有用户事实都不能 commit。

【建议】

拆成两轴：

1. **authority source**：谁在表达事实？
   - child explicit self-report
   - user correction
   - parent edit
   - tool/game result
   - LLM inference

2. **observation quality**：这句话被系统听清楚了吗？
   - ASR final
   - ASR uncertain
   - repeated
   - manual parent edit

例如：

- “我叫小明”  
  - authority = `user_explicit`
  - observation = `asr_final`
  - 可 stable commit

- “我可能喜欢……”  
  - authority = `user_explicit`
  - observation = `asr_final`
  - 但语义弱，先 pending

- “他好像不懂分数”  
  - authority = `llm_inference`
  - observation = `derived`
  - 不直接进 Working Set，需工具/复现支持

这是 P003 必须修正 PRD 的地方。

---

### P0-2：事件 append + profile projection 同事务

【建议】

P0 不要追求纯 Event Sourcing。

现实做法：

```text
memory-extractor
  → arbitrator
  → append memory_events
  → update profile-store projection
```

这两个动作可以在同一个 SQLite transaction 内完成。

这样做的好处：

- 保留现有 profile-store 热路径；
- 不引入 Redis/Qdrant；
- 有 audit trail；
- 有 revision chain；
- 未来可以 replay；
- demo 两周可落。

【判断】

如果只是“SQLite 直接 upsert profile，不留 append-only 记录”，短期也能跑，但会失去：

- 家长审计；
- 为什么小可这么认为；
- 纠错链；
- 脏写排查；
- 未来 CQRS 迁移路径。

所以：

> Event Log 在 demo 阶段值得上，但只能上 SQLite append-only 变更表，不上完整 event sourcing 平台。

---

### P0-3：最小 interrupt-safe commit gate

【建议】

不用把 PRD 的完整 DRAFT/PENDING/COMMITTED 全量复杂状态做完，但要有 commit gate。

最小规则：

```text
1. ASR partial 永不写记忆。

2. 只有 ASR final 且 turn_id == activeTurn 时，
   user utterance 才能进入 extraction。

3. 被 tts.turn_discard 覆盖的 assistant response，
   其 assistant-derived memory 不允许 commit。

4. 用户纠正类 utterance 优先处理：
   - “不是”
   - “我不是叫 X”
   - “我不喜欢 Y”
   - “刚才说错了”
   - “我是说 Z”
   命中后生成 correction / invalidation / supersede。

5. LLM 推断型记忆默认 pending，
   不直接进入 profile Working Set。

6. skill_state 优先来自工具/题目判分，
   不来自 LLM 主观猜测。
```

### P0-4：禁止 assistant speech 直接成为事实

【判断】

实时语音 demo 中最容易脏写的不是“孩子说的话”，而是“小可自己说了但孩子没听完的话”。

例如：

- 小可：“那我们下一关去火星——”
- 孩子打断：“不要！”
- 如果系统把 game_progress 写成“已进入火星关”，就是脏写。

【建议】

P0 规则：

- game progress 只由游戏状态机 / tool result 写入；
- assistant 文本本身不作为长期记忆来源；
- 如果必须写 assistant-derived memory，必须等待 `tts_delivered` 或明确 action commit。

---

### P0-5：热路径 Context Snapshot

【建议】

热路径只读：

1. profile-store 当前 projection；
2. 最近少量 game progress；
3. KG 只读结果；
4. memory_projection_version。

不要在 ASR-final → LLM first token 间做：

- LLM extraction；
- vector search；
- graph traversal；
- SQLite 大范围扫描；
- 冷路径写入等待。

推荐 prompt 中带：

```text
Memory snapshot version: 42
Known stable facts:
- nickname: 小明，source: child explicit, last confirmed: ...
- interests: 恐龙，source: repeated child explicit, confidence: ...
- current skill: 分数加法卡点，source: tool result, ...
Do not mention uncertain/pending memories as facts.
```

---

# 5. Event Log 和向量召回的明确取舍

## 5.1 Event Log：值得上，但只能上轻量版

### Finding 5：P0 上完整 CQRS 是过度；P0 不留事件又会失去长期架构地基

【建议】

P0 采用：

```text
SQLite append-only memory_events
+
profile-store current projection
+
可选 last_event_id / revision_of
```

不要 P0 做：

- 独立 Event Store；
- Redis projection；
- Qdrant projection；
- 多消费者投影重建；
- graph projection；
- 完整 replay UI。

【判断】

P0 目标是让每个 profile 字段能回答：

- 这条记忆来自哪句话？
- 哪一轮产生？
- 是否被纠正过？
- 当前为什么是这个值？
- 如果孩子纠正，如何 supersede？

做到这些，demo 的“记忆极好”体感会明显提升。

## 5.2 向量召回：不该是 demo P0

### Finding 6：P003 儿童单用户 demo 的记忆瓶颈不是向量召回

【已验证事实】

现状没有 Qdrant、没有 embedding、没有 vector infra。

【判断】

P0 上 Qdrant 的问题：

- 新增 infra 运维；
- 延迟预算更复杂；
- 儿童单用户早期记忆量小；
- profile 结构化字段已经覆盖姓名、兴趣、情绪、卡点、游戏进展；
- K12 skill 更适合 tool/KG 结构化，不适合靠语义向量猜。

【建议】

P0 不上 Qdrant。

替代方案：

1. profile-store 结构化字段；
2. game_progress 最近 N 条；
3. feedback-store；
4. curriculum KG；
5. 必要时用 SQLite FTS / JSON metadata 做轻量 episodic 检索，而不是独立向量库。

向量召回应等到出现真实需求：

- 孩子多周对话上百条；
- 需要自然语言回忆“上次你说过那个关于恐龙的故事”；
- 结构化字段无法覆盖 episodic memory；
- 记忆量超过 prompt snapshot 可承载范围。

---

# 6. 关键风险 / 坑

## 6.1 火山云 ASR 改变了 PRD 的假设

### Finding 7：PRD 的 Whisper / n-best / confidence 假设不能照搬

【已验证事实】

P003 使用火山云端流式 ASR，目前只解析 text + definite 句尾标志；confidence / n-best 待验证。

【风险】

如果依赖 ASR confidence：

- 当前不可用；
- 低 confidence pending 逻辑无法实现；
- n-best rebase / speculative 相关设计不可实现。

【建议】

P003 P0 使用：

- `definite` 作为 final gate；
- correction pattern；
- repetition；
- source authority；
- parent/tool confirmation；
- conservative write policy。

不要设计依赖：

- n-best；
- token-level confidence；
- local ASR rollback；
- endpoint model unified attention。

---

## 6.2 分链路系统不能做端到端 rebase

### Finding 8：当前系统只能“下一轮生效”，不能真实 rebase 当前 LLM 注意力

【已验证事实】

P003 是火山 ASR + 云 LLM gateway + 火山 TTS 三段分链路，每次完整 prompt。

【判断】

所以以下北极星能力 P003 P0 不具备：

- 一个模型统一注意力；
- speculative execution；
- 当前响应中途基于新记忆重排 attention；
- 真实 fork/rebase 当前推理。

【建议】

记忆 projection 更新后，从下一轮 prompt 生效即可。

当前轮如果发生用户纠正：

- 通过交互 FSM 打断旧 TTS；
- 开新 turn；
- 新 turn prompt 读取已 commit correction；
- 不尝试修补旧 LLM 流。

---

## 6.3 WebView / Native 双层容易产生“谁是权威”的混乱

### Finding 9：客户端只应负责播放与 UI 状态，不应成为记忆真相来源

【判断】

Android Compose + WebView 架构下，若把记忆状态散落到 native / Web / server 三边，会很难排查。

【建议】

- server turn_id 是记忆 provenance 的权威；
- playbackGeneration 只证明“旧音频应不应播”，不证明“事实是否成立”；
- 客户端可以回传 `tts_delivered` / `tts_discarded`，但 memory commit 仍由 server 决定；
- React FSM 不参与记忆写入判断，只发事件。

---

## 6.4 `node:sqlite` DatabaseSync 可能阻塞热路径

### Finding 10：SQLite 同步 API 可用，但要避免冷路径写入卡住首 token

【已验证事实】

后端是单进程 Node + `node:sqlite` `DatabaseSync`。

【风险】

如果 memory event append / projection rebuild 在 ASR-final → LLM first token 之间同步执行，会影响语音丝滑度。

【建议】

- 热路径只读小 profile snapshot；
- 冷路径写入放 turn 后；
- 不做大范围 replay；
- 不做 vector embedding；
- 不在首 token 前等待 memory extraction；
- profile projection 读结果可缓存到 session context。

---

## 6.5 记忆污染最大风险：LLM 推断过度

### Finding 11：demo 中最伤体验的是“假记得”，不是“少记一点”

【判断】

儿童场景下，错误长期画像会非常突兀：

- 把一次情绪当长期性格；
- 把 ASR 错字当兴趣；
- 把 LLM 猜测当学习卡点；
- 把未完成游戏状态写成已完成；
- 把孩子一句玩笑当事实。

【建议】

P0 写入策略应偏保守：

| 类型 | P0 写入策略 |
|---|---|
| nickname / 自称 | explicit user final 可 commit；纠正最高优先级 |
| interest | explicit + 语义清晰 commit；弱表达 pending；重复后 stable |
| recent emotion | ephemeral，短期有效，不进长期稳定画像 |
| personality_notes | P0 慎写，最好 pending 或 parent visible |
| skill_state | 只从题目判分 / tool / 明确教学结果写 |
| game_progress | 只从游戏状态机写 |
| LLM inference | 默认 pending，不作为 prompt 真值 |

---

# 7. 第一性原理：demo“记忆极好”的真正瓶颈是什么？

## 7.1 不是向量库，也不首先是完整 CQRS

### Finding 12：P003 demo 的第一瓶颈是“记忆写入质量 + 使用方式”，不是存储形态

【判断】

北极星方向上，CQRS / Event Log / interrupt-safe 是正确的长期架构方向。

但 P003 demo 的“记忆极好”体感主要来自：

1. **小可记得准**
   - 不乱记；
   - 不把玩笑当事实；
   - 不把 ASR 漂移当事实；
   - 能接受纠正。

2. **小可用得自然**
   - 不生硬复读 profile；
   - 在合适时机提到孩子兴趣；
   - 教学时引用真实卡点；
   - 游戏进度连续。

3. **小可可解释**
   - 家长/开发者能看到：这条记忆从哪来；
   - 纠错后能生效；
   - 错误能追溯。

4. **小可不影响语音流畅**
   - 首 token 不等记忆抽取；
   - 打断不拖泥带水；
   - 冷路径失败不影响对话。

因此 P0 投资优先级应是：

```text
turn/version protocol
> conservative commit gate
> append-only event audit
> source authority arbitration
> prompt memory usage policy
> parent/developer debug visibility
> vector recall
> graph/bitemporal
```

## 7.2 PRD 是否押错重点？

### 结论：北极星没押错，P003 P0 如果重押完整 interrupt-safe/CQRS 会阶段性押错

【判断】

PRD 把护城河押在 interrupt-safe memory consistency protocol，这在长期实时语音 agent 中是有价值的。

但对 P003 当前现实：

- 已有 `activeTurn` 覆盖了大量流式交互脏回调；
- 单用户 demo 的并发和存储复杂度低；
- ASR 没有 n-best / confidence；
- 没有向量 infra；
- profile-store 已是单一画像投影；
- 真正体验短板更可能是抽取质量、保守仲裁、prompt 使用、纠错链路。

所以 PRD 的重点需要降维：

```text
不要：完整 Event Sourcing + Redis + Qdrant + Graph + bitemporal
要：SQLite event audit + profile projection + turn eligibility + correction supersede
```

### 独有判断

【建议】P003 应把“记忆极好”定义为：

> 宁可少记，也不假记；宁可下一轮生效，也不阻塞当前语音；每条长期记忆都能解释来源；用户纠正一定覆盖旧记忆。

这比 P0 上 Qdrant 或完整 CQRS 更能打动 demo 用户。

---

# 8. 推荐阶段路线

## P0：两周 MVP

目标：不脏写、可解释、不中断语音。

建议落地：

1. Turn envelope / event contract；
2. eligible transcript 概念；
3. SQLite `memory_events` append-only 表；
4. event append + profile projection 同事务；
5. source authority + observation quality 双轴仲裁；
6. user correction supersede；
7. DRAFT / PENDING / COMMITTED 最小候选状态；
8. assistant-derived memory 默认禁写；
9. prompt 使用 `profile-store` stable projection；
10. P0 指标：
    - 打断脏写率；
    - 纠错生效延迟；
    - 每 turn 写入率；
    - pending / discarded 比例；
    - 热路径 memory 读取耗时；
    - 人工抽检记忆准确率。

## P1：demo 增强

目标：家长可控、记忆召回更丰富。

建议：

1. 家长 audit UI；
2. 家长修订产生 `parent_edit` event；
3. replay / rebuild profile projection 的内部工具；
4. stability 老化；
5. episodic memory 轻量检索；
6. 如果数据量增长，再评估 embedding / vector。

## P2：北极星扩展

目标：真实长期、多跳、复杂时间。

建议：

1. Qdrant / vector projection；
2. graph projection；
3. bitemporal 查询；
4. 多用户 / 多设备 consistency；
5. 高 sensitivity approval workflow；
6. LoCoMo 类长期记忆评测。

---

# 9. 最终建议清单

## 必做

1. 保留三层 version，不合并成一个 `turnVersion`。
2. 定义跨层 envelope：`turn_id` / `response_id` / `playback_generation` / `memory_projection_version`。
3. 记忆冷路径只消费 eligible transcript。
4. 新增 SQLite append-only memory event。
5. 继续用 profile-store 作为热路径 Working Set。
6. 来源仲裁拆成 authority source + observation quality。
7. correction 最高优先级，支持 supersede。
8. assistant speech 不直接写长期记忆。
9. LLM inference 默认 pending。
10. P0 不上 Qdrant / Redis / Graph。

## 不建议 P0 做

1. 完整 Event Sourcing 平台；
2. Qdrant；
3. Redis Working Set；
4. Graphiti / graph DB；
5. bitemporal 查询；
6. 依赖 ASR confidence / n-best；
7. speculative / rebase / fork；
8. 把 playbackGeneration 当 turn version；
9. 从全量 conversation history 直接抽记忆；
10. 把一次性情绪写成长期人格。

## 一句话架构

【建议】P003 的最优解是：

> 用现有 `activeTurn + playbackGeneration + FSM` 保证语音丝滑；用 SQLite append-only memory events + profile projection + conservative candidate commit gate 保证记忆稳定；用统一 turn envelope 把两条线接起来，但不把三层 version 合并。

署名：codex（OpenAI）
