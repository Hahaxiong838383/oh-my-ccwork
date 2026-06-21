# 宏观合一架构方案与评审报告

## 一、 控制面与记忆面合一架构（Turn-Guard Unified Protocol）

为了在没有复杂分布式事务和多种存储介质的前提下，实现“丝滑打断”与“记忆零脏写”，设计以下**控制面与记忆面统一的版本协同协议**：

```
[客户端]                                [服务端 Node.js / SQLite]
   │                                         │
   ├─ 1. 用户说话 (ASR Start)                │
   │  (FSM 切换至 LISTENING, 递增本地 Turn)   │
   ├───────────────────[ WS: USER_TALK ]────>│ ── 2. 分配逻辑轮次 activeTurn = N
   │                                         │    ── 热路径：SELECT * FROM profile WHERE ... (<5ms)
   │                                         │    ── 组装上下文 -> LLM 流式输出 -> TTS 流式推送
   │                                         │
   │<──────────────────[ WS: TTS_CHUNK ]─────┤
   ├─ 3. 播放音频 (playbackGen=G)             │
   │                                         │
   ├─ 4. 用户强行打断 (Barge-in / VAD)       │
   ├───────────────────[ WS: INTERRUPT ]────>│ ── 5. 立即递增 activeTurn = N + 1
   │                                         │    ── 抛弃所有旧轮次(<=N)的 LLM/TTS 处理
   │                                         │    ── 标记 turn N 为 ABORTED
   │                                         │
   │                                         │ ── 6. 异步冷路径触发 (memory-extractor.ts)
   │                                         │    ── 读取 turn N 的上下文快照
   │                                         │    ── 校验：activeTurn 已经是 N+1 且 turn N 已 ABORTED
   │                                         │    ── 【关键保护】：不提取、不写入，直接 ABORT 任务
   │                                         │
```

### 1. 三层 Version 的映射与联动关系
*   **客户端 React FSM `turnVersion` (控制面核心)**：代表用户可感知的逻辑交互轮次。每次用户开始说话或收到服务端新轮次信标时递增。
*   **客户端 `playbackGeneration` (播放面隔离)**：物理音频播放代次。每当发生打断（Barge-in）或切换时递增。与 `turnVersion` 正交，用于客户端声卡瞬间丢弃旧代次的音频 buffer（`discardTurnAtOrBelow`）。
*   **服务端 `activeTurn` (服务端与记忆面守护)**：服务端的全局逻辑轮次 ID。

### 2. 交互与记忆的交汇枢纽
**打断丢弃的“内存化”实现**：无需在数据库层引入复杂的分布式 `DRAFT/COMMITTED` 状态机。
*   **未打断（正常提交）**：Turn N 顺利结束，冷路径 `memory-extractor` 启动，传入参数 `targetTurn = N`。当提取完成准备写入数据库时，校验当前全局 `activeTurn === targetTurn`。若一致，写入 Event Log 表，并更新 profile 投影（状态转为 `COMMITTED`）。
*   **已打断（天然回滚）**：在 TTS 播放或 LLM 吐字过程中用户打断，服务端瞬间将 `activeTurn` 递增为 `N+1`。此时，为 Turn N 运行的 `memory-extractor` 协程或后续回调在写入前进行校验，发现 `activeTurn (N+1) !== targetTurn (N)`，**直接抛弃写入动作**。内存中的 `DRAFT` 状态随之销毁，数据库零污染。

---

## 二、 PRD 增量 × P003 决策表

| PRD 功能要素 | 决策 | 落地阶段 | 理由 | ROI |
| :--- | :--- | :--- | :--- | :--- |
| **Event Log (CQRS)** | **裁剪保留** | **P0** | 不引入独立 Event Log 中间件，直接在现有的 SQLite 中建一张 `memory_events` 表。作为单一真相源，异步重建 `profile` 投影。 | **高** (易实现，提供天然的审计与回溯能力) |
| **Vector 语义召回 (Qdrant)** | **缓做** | **P2** | 当前 Node 单进程 + SQLite，无 Qdrant 运维。儿童画像在 demo 阶段数据量极小，结构化匹配 + 内存 KG 已能覆盖 95% 场景。 | **低** ( demo 阶段引入向量数据库属于严重过度工程) |
| **Interrupt-safe 候选状态机** | **裁剪** | **P0** | 不在数据库层写状态机。利用内存中“`activeTurn` 锁与写前校验”实现打断即丢弃，天然保证一致性。 | **高** (极简代码规避事务回滚逻辑) |
| **Bitemporal 双时态** | **缓做** | **P2** | `valid_time` 和 `tx_time` 带来的复杂区间查询在 MVP 阶段没有业务场景支撑。 | **低** |
| **来源优先级仲裁** | **保留** | **P0** | 必须有。K12 场景中，家长修改（`parent_edit`）和用户当场纠正（`user_correction`）必须能瞬间覆盖 ASR 和 LLM 提取的历史事实。在 SQLite 更新投影时执行优先级数值对比即可。 | **高** (用几行 SQL 逻辑解决冲突一致性问题) |
| **Redis Working Set** | **裁剪** | **P0** | 用现有 `profile-store.ts`（SQLite 内存映射）替代 Redis。SQLite 本身读取时间 <1ms，无需引入二级缓存。 | **低** (多引入一个组件，多一层双写一致性风险) |
| **Stability 衰减淘汰** | **裁剪** | **P1** | 暂不上复杂的数学衰减模型。P0 阶段在冷路径中对 transient/ephemeral 类型数据采用简单的“只保留最近 N 条”策略。 | **中** |
| **家长 Audit** | **保留** | **P1** | 家长端可以直连 `memory_events` 表进行查询和 invalid 标记（软删除）。基于 CQRS 架构，这只是在 UI 上直接修改事件并重新投影。 | **高** (为产品合规与商业化立论点) |

---

## 三、 Demo MVP 最小增量设计路径

**现状已有**：基于 SQLite 的 `profile-store.ts`（直接 upsert）、异步触发的 `memory-extractor.ts`、服务端的 `activeTurn` 丢弃机制。

**两周内完成 MVP 所需的最小增量（只需补三项）**：

### 1. 新增 SQLite 表：`memory_events`
在当前 SQLite 数据库中新建一张 append-only 事件表，字段设计如下：
```sql
CREATE TABLE memory_events (
    id TEXT PRIMARY KEY,
    turn_id INTEGER,
    event_type TEXT, -- 'FACT', 'PREFERENCE', 'CORRECTION', 'INVALID'
    subject TEXT,
    predicate TEXT,
    object TEXT,
    source TEXT,     -- 'user_correction', 'parent_edit', 'llm_inference', 'asr'
    priority INTEGER, -- 10 (user), 9 (parent), 5 (llm), 1 (asr)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 2. 重构 `memory-extractor.ts` 的写入与投影重建
修改现有的直接更新 `profile` 表的行为，改为双步走：
1.  **写入事件**：提取出的 SPO 关系直接 `INSERT INTO memory_events`。
2.  **异步触发投影重建**：触发 `rebuildProfileProjection(subject)`，执行如下同步 SQL 逻辑（伪代码）：
    ```sql
    -- 找出该 subject 优先级最高且未被 INVALID 的最新值，写入 profile 表
    REPLACE INTO profile (nickname, interests, recent_emotion)
    SELECT object, ... FROM memory_events 
    WHERE subject = ? AND event_type != 'INVALID'
    ORDER BY priority DESC, created_at DESC LIMIT 1;
    ```

### 3. 在 Node 端暴露简单的事件撤销/修改接口
为家长端/纠错端提供 `INSERT INTO memory_events (event_type='INVALID')` 的接口，自动触发投影重建，瞬间完成记忆的审计与回溯。

---

## 四、 关键风险与填坑指南

### 1. 火山云端 ASR 的打断滞后与数据污染风险
*   **风险**：由于使用火山流式 ASR，用户在说出纠错话语时（如：“不对，我喜欢的是土豆！”），客户端检测到 VAD 立即触发 Barge-in 截断。但由于网络延迟，云端 ASR 仍在源源不断地向 Node 发送上一轮被截断话语的残缺识别文本（ASR Partial/Final）。
*   **填坑方案**：在服务端增加 `lastInterruptedTurn` 拦截器。一旦发生 `INTERRUPT`，将当前 `activeTurn` 记录在拦截器中。在此之后收到的、属于 `<= lastInterruptedTurn` 的任何 ASR 识别文本，直接丢弃，严禁送入 `memory-extractor` 提取，防止提取出被截断的错乱事实。

### 2. 客户端/服务端 Version 乱序与时序错位
*   **风险**：在弱网环境下，客户端发送的 `INTERRUPT` 消息与服务端的 ASR 推送可能发生应用层乱序，导致客户端 FSM 错置。
*   **填坑方案**：服务端下发的每一包音频、TTS 控制帧、以及状态变更，必须强制携带当前的 `server_turn_version`。客户端收到消息时，若发现消息携带的 `version < FSM.turnVersion`，直接做静音和丢弃处理；若 `version > FSM.turnVersion`，则强制同步拉起客户端的 FSM 状态。

---

## 五、 第一性原理与独家视角：PRD 是否押错了重点？

### 1. 一致性是“伪命题”，提取精度才是“真生死”
*   **诊断**：PRD V2 花了大量篇幅设计 `DRAFT -> PENDING -> COMMITTED` 状态机、双时态、锁和事务回滚。**这在 P003 单进程 Node + SQLite + 服务端 `activeTurn` 轮次守护的架构下，属于自造靶子自己打。**
*   **事实**：因为 `activeTurn` 的拦截机制已经从流量入口处拦截了被打断轮次的异步处理，脏数据根本进不去 `extractor`。

### 2. 真正的瓶颈在哪里？
在这个 demo 中，要让孩子和家长觉得“记忆极好”，瓶颈根本不在事务一致性，而在于**“画像漂移的控制”**与**“短期上下文与长期记忆的边界划分”**。
*   **痛点 A：ASR 识别错别字导致画像污染**。孩子说“我喜欢小猫”，ASR 识别成“我喜欢小毛”。LLM 提取出 `(孩子, 喜欢, 小毛)` 写入画像，这个脏事实会永久污染后续对话。
*   **痛点 B：LLM 异步抽取的幻觉与过度泛化**。孩子随口一句“今天真热，我想吃冰淇淋”，LLM 可能会强行提取出长期偏好 `(孩子, 偏好, 冰淇淋)`，导致后续人设不断推荐冰淇淋，引起家长反感。

### 3. 架构优化建议（火力的正确集中点）
1.  **引入 K12 Curriculum-KG 离线护栏**：
    利用现有的 `curriculum-kg.ts`（只读，匹配极其高效）。当 `memory-extractor` 提取出新的实体和事实时，**必须先经过 KG 校验**。如果是 K12 范围外的实体或错别字，不予写入 `profile`；如果高度相关，才允许入库。
2.  **设置稳定阈值（Stability Guard）**：
    LLM 推理出的长期事实在 `memory_events` 中初始标记为 `STABILITY_EPHEMERAL`。只有当该事实在后续对话中被孩子主动复现 $\ge 2$ 次，或直接得到用户/家长确认时，才在投影重建时升级为 `STABILITY_STABLE`，并写入 `profile`。这能直接过滤掉 90% 的随口闲聊产生的无效记忆。

署名：gemini（Google）
