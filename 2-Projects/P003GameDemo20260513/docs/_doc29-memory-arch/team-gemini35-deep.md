### 一、 宏观合一架构：双轴三层状态机对齐

要实现“丝滑流畅+记忆极好”，必须将交互（时间轴控制）与记忆（数据一致性轴）在协议层进行强绑定。`turn_id`（轮次 ID）是串联两者的唯一全局纽带。

#### 1. 协议栈设计与分层对齐
系统从前到后分为三层，各层状态机及 Version 变量独立负责各自关注的物理实体，通过 `turn_id` 进行逻辑对齐：

```
[客户端 WebView FSM]
   ↳ 负责：UI交互状态 (LISTENING -> THINKING -> SPEAKING)
   ↳ 标识：turnVersion (本地计数，控制麦克风与UI动效)
       │
       ▼ (通过 WebSocket 传递 turn_id)
[客户端 Voice-Client 播放器]
   ↳ 负责：音频物理播放队列的抢占与清理
   ↳ 标识：playbackGeneration (单调递增，发生打断即 +1，丢弃该代次以下所有音频包)
       │
       ▼ (控制信令下发)
[后端 Pipeline 调度]
   ↳ 负责：ASR/LLM/TTS 管道分发与轮次拦截
   ↳ 标识：activeTurn (当前被允许执行的最新轮次)
       │
       ▼ (状态过滤)
[后端 Memory Candidate 状态机]
   ↳ 负责：异步记忆提取的安全写入
   ↳ 标识：turn_id 对应的内存 Draft 状态 (DRAFT -> PENDING -> COMMITTED)
```

#### 2. “打断与纠错”时，各层 Version 的协同演进序列
当用户在 Agent 发声过程中打断并进行口头纠正（例如：“不对，我不喜欢吃苹果，我喜欢吃香蕉！”）时，协同流程如下：

1. **打断检测（Client）**：
   * ASR 产生第一个 partial 字符。
   * WebView FSM 触发状态切换，本地 `turnVersion` 递增。
   * `playbackGeneration` 递增，立即静音本地播放器，并调用 `discardTurnAtOrBelow(activeTurn)`。
2. **打断上报（Client -> Server）**：
   * 发送 `BARGE_IN` 信令，携带当前被打断的 `interrupted_turn_id`。
3. **管道抢占（Server Pipeline）**：
   * 收到 `BARGE_IN`，若 `interrupted_turn_id <= activeTurn`，立即标记旧轮次为“已废弃”。
   * 废弃 TTS 队列，向客户端发送 `tts.turn_discard{upTo: interrupted_turn_id}`。
4. **内存 Draft 冻结（Server Memory）**：
   * 检查 `inFlightDrafts` 内存 map 中 `interrupted_turn_id` 的状态。
   * **决策**：由于该轮次被物理打断，其对应的 LLM 抽取 DRAFT 被标记为 `DISCARDED` 或 `FROZEN`（不向 SQLite 物理表提交任何脏数据）。
5. **纠错写入（New Turn）**：
   * 客户端重新发起新轮次，带上新 `turn_id` (例如 `turn_12`)。
   * 用户的纠错语义（“我不喜欢苹果，喜欢香蕉”）在新轮次中正常进入。
   * 异步冷路径提取出新事实，经过**来源优先级仲裁**（`user_correction` 优先级最高），触发 SQLite 覆盖（Supersede），更新 `profile-store.ts`，并写入变更日志。

---

### 二、 PRD 增量 × P003 决策表

针对 PRD V2 的设计要素，结合 P003 单进程 Node + SQLite 的技术现状，进行裁剪与分期决策：

| PRD 设计要素 | 决策 | 阶段 | 理由 | ROI |
| :--- | :--- | :--- | :--- | :--- |
| **Event Log / CQRS** | **裁剪** | P0 | 无需引入独立日志系统（如 Kafka/Qdrant 日志），在现有 `profile.db` 中新建一张 `memory_events` 变更历史表即可。所有写入先写此表，再同步/异步投影至画像表。 | **高** |
| **Qdrant 向量语义召回** | **缓做** | P2 | demo 阶段儿童记忆体量极小（单人核心事实 < 100 条）。完全可以通过结构化字段过滤 + 内存 KG 检索覆盖 90% 场景。无需承担向量库运维和 Embedding 延迟成本。 | **低** |
| **Interrupt-safe 候选状态机** | **裁剪** | P0 | 在 Node 内存中维护一个轻量级的 `inFlightDrafts = Map<turn_id, Draft>`。打断时直接标记该 `turn_id` 对应的 Draft 为无效，阻止其写入 SQLite。无需做持久化状态机。 | **高** |
| **Bitemporal（双时态）** | **缓做** | P2 | Demo 阶段不需要回溯“在过去某个时间点我以为孩子知道什么”。一个简单的 `created_at` 加版本链 `revision_of` 即可支持纠错回溯。 | **低** |
| **来源优先级仲裁** | **照搬** | P0 | demo 体验的刚需。必须优先保证“用户口头纠正”和“家长后台修改”能即时覆盖 LLM 异步抽取的模糊事实。 | **高** |
| **Redis Working Set** | **裁剪** | P0 | 单进程 Node + SQLite，Node 进程内内存（Memory Map / Cache）就是天然的 Working Set，查询延迟 < 1ms，无需 Redis。 | **低** |
| **Stability 淘汰机制** | **裁剪** | P0 | 简化为 FIFO（如 `profile-store.ts` 已有的只保留最近 5 条情感状态）+ 静态时间窗口衰减，无需复杂的衰减函数计算。 | **中** |
| **家长 Audit / Event Replay** | **缓做** | P1 | P003 核心是跑通语音链路，家长审计非阻塞性功能，利用 `memory_events` 表的追加历史，后续做查询即可，无需实时 Replay 引擎。 | **中** |

---

### 三、 demo MVP 最小增量方案

本两周迭代周期内，ROI 最高且改动最小的落地路径如下：

#### 1. 现状已有 vs 需补齐的增量
* **已有**：基于 SQLite 的 `profile-store.ts` 读写、基于异步 LLM 的 `memory-extractor.ts` 抽取、以及 `pipeline.ts` 的 `activeTurn` 守卫。
* **只需补齐**：
  1. **内存 Draft 隔离区**：在 `memory-extractor.ts` 启动异步 LLM 抽取前，在内存中挂载 `inFlightDrafts` 容器。
  2. **打断阻断器**：在 `pipeline.ts` 接收到 `BARGE_IN` 信令时，不仅清理 TTS，还要同步调用 `memoryExtractor.cancelDraft(interrupted_turn_id)`。
  3. **SQLite 变更日志表 (`memory_events`)**：
     ```sql
     CREATE TABLE memory_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         turn_id INTEGER,
         event_type TEXT, -- 'APPEND', 'SUPERSEDE', 'DISCARD'
         subject TEXT,
         predicate TEXT,
         object TEXT,
         source TEXT, -- 'user_correction', 'llm_inference', 'parent_edit'
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     );
     ```
  4. **极简优先级仲裁**：在写入 `profile-store.ts` 前，若待写入事实对应的 `source` 优先级低于已存在的（例如 LLM 抽取的推论试图覆盖用户明确的纠正），则不写入画像表，仅记入 `memory_events` 归档。

#### 2. 关于 Event Log 和向量召回的决断
* **Event Log 是否值得上**？
  * **结论**：**不值**。不要引入独立的消息中间件或事件存储库。用 SQLite 的 `memory_events` 关联表代替，它天然支持 ACID 事务，对于单进程 Node + SQLite 架构，这是最稳妥、零运维成本的做法。
* **向量召回是否应当是 demo P0**？
  * **结论**：**不应当**。K12 课程场景下，儿童的记忆检索主要依赖强相关的“课程进度”、“最近卡点”、“明确偏好”。通过 `profile-store.ts` 的结构化查询以及 `curriculum-kg.ts` 的只读知识图谱匹配，足以完成高质量的 Prompt 组装。向量检索在上下文极少时容易引入噪音（把似是而非的无关话题召回进 Context），在 P003 阶段弊大于利。

---

### 四、 关键风险与技术坑

1. **云端 ASR（火山引擎）不确定延迟导致的“迟到 Final”**
   * **风险**：当用户在 `turn_1` 说话中途打断（例如说了半句），客户端立即静音并开启 `turn_2`。但云端 ASR 的 `turn_1` Final 文本可能会因为网络延迟延迟到达后端。此时后端若盲目执行 `turn_1` 的 memory extraction，会导致脏记忆写入。
   * **对策**：`memory-extractor` 在接收到 `extract` 请求时，必须校验当前请求的 `turn_id` 是否等于系统当前的最新成功轮次。若 `turn_id < activeTurn - 1`（已被新轮次覆盖且已被打断），则直接丢弃该提取任务。

2. **WebView 与 Native 之间的打断延迟**
   * **风险**：WebView 内的 React FSM 切换状态有毫秒级延迟，可能导致用户已经开始说话，但 Native 音频播放器尚未静音，导致火山 ASR 录入 Agent 自身的 TTS 声音。
   * **对策**：必须由 Native 薄壳优先拦截物理打断信号（如 ASR Partial 或物理按键），直接在 Native 层执行播放器强静音，同时上报后端，而不能等待 WebView 的 React state 传递链。

3. **ASR 识别错误导致的“伪纠错”**
   * **风险**：儿童发音不清，ASR 将普通对话错误识别为纠错指令（例如将“我想看”识别为“不要看”），导致触发高优先级的 `user_correction` 篡改了正确的画像。
   * **对策**：在 `memory-extractor` 的 LLM Prompt 中加入严格的“纠错置信度校验”。只有当句式含有强否定且指代明确（如“不是...是...”、“不对，我没有...”）时，才标记为 `user_correction`，否则一律降级为 `llm_inference` 优先级，需在后续轮次中复现才生效。

---

### 五、 第一性原理与独有视角：PRD 是否押错了宝？

#### 1. 核心瓶颈分析
这个语音陪伴 Demo 要做到“记忆极好”，**真正的瓶颈不是“高并发下的分布式一致性协议/CQRS”，而是“小儿多动多变带来的抽取噪声控制”与“LLM 在冷路径上的画像漂移”。**

* **儿童用户的真实画像特征**：注意力切换极快（前一秒喜欢奥特曼，后一秒喜欢小汽车），表达支离破碎，发音存在多处含混。
* **如果照搬 PRD 的强一致性工程方案**：团队会花费 80% 的精力去解决 SQLite/Qdrant 双写一致性、DRAFT 状态机的回滚事务等“分布式玩具问题”。但最终会发现，由于 ASR 识别垃圾和儿童口齿不清，LLM 抽取出了一堆诸如 `(小可, 喜欢, 嗷嗷嗷)` 或 `(小可, 年龄, 30岁)` 的废垃圾，或者因为 LLM 提取幻觉频繁覆盖正确画像。

#### 2. PRD 的偏置与矫正建议
* **PRD 偏置了“高并发分布式”假设**：PRD 假设了一个海量并发、分布式持久化、多端写入的复杂场景，试图用标准的 CQRS + 双时态去套。但 P003 是单进程 Node + SQLite 的单机玩具模型。
* **真正应该押宝的地方（Demo 体验短板）**：
  1. **提取的降噪过滤器**：必须在 `memory-extractor.ts` 中建立一层基于规则的“拼写/常识过滤器”（例如，若提取出年龄 > 18，直接 Discard）。
  2. **从“单次提取写入”改为“多轮置信累加”**：不能 LLM 提取一次就修改一次画像。除了明确的口头纠正（`user_correction`）外，常规事实（如“喜欢恐龙”）必须在 `memory_events` 中出现次数 $\ge 2$ 次，且在不同 turn 中被提及，才允许投影至 `profile-store` 画像表。
  3. **基于 Context 的动态遗忘（主动澄清）**：当 LLM 发现冲突时（例如昨天喜欢苹果，今天说喜欢香蕉），不要让系统在后台默默纠错，而是在 Cognitive 层触发 Agent 主动反问：“小可，你昨天不是说最喜欢苹果吗，今天怎么变成香蕉啦？”——**将“一致性解决”转化为“人设连贯有趣的交互特征”**，这才是语音 Agent 体验跃升的护城河。

署名：gemini（Google）
