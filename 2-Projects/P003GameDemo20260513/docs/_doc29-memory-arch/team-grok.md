**结论先行（优先级排序）：**

**最高优先级发现**：P003 现状已具备 70% 的「记忆+交互合一」骨架（profile-store 单一真相源雏形 + activeTurn 轮次守卫 + playbackGeneration + 6 态 FSM），PRD V2 的 Interrupt-safe 协议与现有机制高度重叠，**无需新建候选状态机**，只需把 DRAFT/PENDING/COMMITTED 映射到 activeTurn 的 turn 生命周期即可。强行上 Event Log + Qdrant 会把 demo 推向「从零建三存储」运维黑洞，ROI 低。

**第二优先级**：demo MVP 最小增量是「把 memory-extractor 的异步抽取接上 activeTurn 守卫 + 来源优先级仲裁」，而非 Event Log。儿童记忆量小，结构化字段 + curriculum-kg 已覆盖 80% 场景，向量召回 P2 再上。

**第三优先级**：PRD 把火力集中到「interrupt-safe 一致性协议/CQRS」是**押错重点**。demo 真正瓶颈是「LLM 抽取质量 + 长期画像漂移 + 人设连贯」，而非工程一致性（activeTurn 已把脏写率压到很低）。

---

### 1. 宏观合一架构（记忆线 + 交互线统一）

**已验证事实**：现有三层 version（server activeTurn / client playbackGeneration / React turnVersion）与 PRD 的 DRAFT/COMMITTED 状态机**不是正交**，而是**同一 turn 生命周期的不同投影**。

**建议架构（分层清单，非图）**：
- **交互控制层（Reactive）**：useMobileVoice 6 态 FSM（SLEEPING→LISTENING→THINKING→SPEAKING→AWAITING_FOLLOWUP→CLOSING）+ playbackGeneration（音频代次）+ barge-in 逻辑。**保持不变**，只暴露 turnVersion 给下层。
- **记忆热路径（Cognitive，只读）**：profile-store + curriculum-kg +（可选）Working Set 快照。延迟铁律 P95<50ms，严禁 LLM 抽取。
- **记忆冷路径（Meta，异步）**：memory-extractor 接 pipeline 的 activeTurn 回调，输出带 provenance 的候选事件。**核心统一点**：把 PRD 的 in-flight 状态机直接映射到 activeTurn 的生命周期：
  - activeTurn 变更 → 冻结当前 DRAFT（不提交）
  - ASR final + 来源优先级通过 → 进入 PENDING→COMMITTED（写 profile-store）
  - correction 检测（user_correction 来源）→ 优先处理 correction，DRAFT 直接 DISCARDED
- **协议对齐（版本一致性枢纽）**：用单一 `turn_id + version` 贯穿三层 + 记忆候选。playbackGeneration 只管音频丢弃；activeTurn 只管 pipeline 守卫；记忆候选状态只在 extractor 内部，不落 Event Log（demo 阶段）。这样「丝滑打断」和「记忆不脏写」用同一守卫实现，无需新状态机。

**推断**：playbackGeneration 与 turnVersion 正交是已知硬伤，但可通过协议对齐（server 下发 `tts.turn_discard{upTo}` 时同时携带 memory_candidate_id）解决，不必合并成一个 version。

---

### 2. PRD 增量 × P003 决策表

| PRD 要素 | 决策 | 阶段 | 理由（已验证事实） | ROI |
|----------|------|------|------------------|-----|
| Event Log（append-only 单一真相源） | 缓做 | P1 | profile-store 已是 upsert 单一真相源，memory-extractor 已做 lost-update 防护；上 Event Log 需新建表+replay 逻辑，demo 阶段多此一举 | 低 |
| 向量召回 Qdrant | 缓做 | P2 | 儿童单用户，结构化字段 + KG（10685 节点）已够；PRD 说「80% 场景覆盖」 | 低 |
| Interrupt-safe 候选状态机 | 裁剪 | P0 | 直接复用 activeTurn + 来源优先级；DRAFT=activeTurn 冻结，COMMITTED=写 profile-store；现有 pipeline 已丢旧轮回调 | 高 |
| bitemporal | 缓做 | P2 | 只有当多跳/时间区间查询被真实场景逼出才上；demo 无此需求 | 低 |
| 来源优先级仲裁 | 照搬（裁剪实现） | P0 | 已在 memory-extractor 有 prompt 校验+并发防护，扩展 user_correction > parent_edit > llm > asr 即可 | 高 |
| Redis Working Set | 缓做 | P1 | SQLite profile-store 已是快照；Redis 增加运维 | 低 |
| stability 淘汰 | 缓做 | P1 | episodic 老化压缩可先用 profile-store 的 recent_emotion 最近 5 条 | 中 |
| 家长 audit / event replay | 缓做 | P1 | 现有 feedback-store + profile-store 已带 provenance，replay 是免费副产品 | 中 |

**已验证事实**：PRD V2 相对现状的「真实增量只有 5 项」，上面已全部裁剪/缓做。

---

### 3. demo MVP 最小增量（两周可落，ROI 最高）

**现状已有**：
- profile-store（唯一真相源）
- memory-extractor（异步抽取 + 防护）
- pipeline activeTurn（轮次守卫）
- curriculum-kg（热路径只读）

**只需补**：
- 在 memory-extractor 里加入「来源优先级 + correction 抢占」逻辑（复用现有 prompt 校验）
- 把 DRAFT/PENDING 状态映射到 activeTurn 生命周期（不新建表）
- 在 profile-store 加 sensitivity/provenance 字段（已有 family_member 表扩展即可）

**Event Log 值得上吗？** 不值得。SQLite 直接 upsert + 一张轻量变更表（仅记录 revision_of）已够 demo；Event Log 的 replay/审计价值在 P1 家长 audit 时再上。

**向量召回该不该是 P0？** 不该。儿童记忆量小，结构化 + KG 已覆盖；上 Qdrant 是 PRD 理想假设，对 P003 现状是「从零新建」。

**推断**：两周可验证「打断时不脏写 + 当场纠错生效」的闭环，远比建 Event Log + Vector 有价值。

---

### 4. 关键风险/坑

**已验证事实**：
- 分链路现实（火山云 ASR 只有 text + definite，无 n-best/confidence）直接冲击 PRD「local ASR 纠错延迟」假设。
- 现有 activeTurn 已把「partial 停 DRAFT、final 才 commit」做了 80%，PRD 的 Interrupt-safe 协议**部分被覆盖**，继续按 PRD 实现会**过度设计**。
- WebView + Android Compose 薄壳：JS bridge 状态同步有额外延迟，turnVersion 跨层传递可能出现时序漂移（playbackGeneration 已暴露此风险）。

**推断**：云 ASR 的 correction 延迟更高，PRD 假设的「correction 晚于 DRAFT commit」场景在 P003 会更频繁，需退化为正常 supersede 的兜底逻辑必须保留。

**建议**：不要把协议设计成「完美本地 ASR」模型，要以「云 ASR + activeTurn 守卫」为前提重新裁剪。

---

### 5. 第一性原理 / 独有视角

**demo 要做到「记忆极好」的真正瓶颈** 是 **LLM 抽取质量 + 长期画像漂移 + 人设连贯**，而非 PRD 押注的「一致性协议/CQRS」。

**已验证事实**：memory-extractor 已是异步冷路径 + prompt 校验，activeTurn 已把脏写率压低；profile-store 已是结构化单一真相源。

**推断**：PRD 把工程火力放在 interrupt-safe（可能 activeTurn 已覆盖大半）和 Event Log/CQRS 上，是**把 demo 体验的真正短板（抽取幻觉、兴趣漂移、情绪不连贯）放在次要位置**。儿童 demo 的北极星是「孩子觉得小可记得住我、不会突然忘」，而不是「事件日志可审计」。

**建议**：P0 把火力放在「提升 memory-extractor 的抽取 prompt 质量 + 加入 stability 简单老化规则」上，远比建新存储有价值。PRD 的「护城河」在 demo 阶段是伪命题，先把丝滑 + 基本记忆稳住再说。

**署名：grok（xAI）**
