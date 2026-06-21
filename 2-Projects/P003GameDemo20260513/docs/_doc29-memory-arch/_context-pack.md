# 任务:为 P003「小可」实时语音 AI agent demo 设计【记忆 + 交互 合一】的宏观整体架构方案

你是首席架构师,**不是来挑 PRD 错别字的**。基于下面四块材料,给出一套统一的宏观方案,目标:**丝滑流畅(语音交互) + 记忆极好(长期稳定/可解释/可回溯/打断安全)** 的 demo 产品体验。

**定位(用户已拍板,这是你的尺子):北极星 + P003 先落地。**
- 北极星 = 记忆架构方向要对标 Mem0 / Letta / Graphiti 级别站得住(长期、可立 IP);
- P003 先落地 = demo 阶段先在「小可」这个真实产品里落最小可验证 MVP,不背三套存储的运维。
- **范围 = 记忆 + 交互合一**:不是只评记忆 PRD,要把「丝滑流畅(语音 FSM/延迟/打断)」和「记忆极好(本 PRD)」收敛成一套架构。用户原话:"不能哪里有问题解哪里,要从更宏观角度设计 demo 方案"——他厌倦了打补丁,要统一架构。

---

## 一、产品目标(O1)
一个儿童(K12)实时语音陪伴 Agent「小可」,孩子说话 → 小可秒级回应、能打断、能当场纠错;长期记住孩子的掌握/卡点/偏好/情绪/游戏进展,且记忆稳定、可被家长审计修订、打断时不脏写。

## 二、硬约束(O2 · P003 现实,均为【已验证】事实,别按 PRD 的理想假设推)
1. **ASR/TTS 是「火山引擎」云端大模型流式服务,不是本地 Whisper**(PRD 写 Whisper 是泛化举例)。火山流式 ASR 给不给 confidence / n-best **待验证**(现 volc-asr 只解析 text + definite 句尾标志)。
2. **分链路,非端到端**:火山 ASR + 云 LLM(gateway,每次完整 prompt)+ 火山 TTS 三段独立服务。没有"一个模型统一注意力",speculative/rebase/fork/attention-budget 这类端到端能力**做不了**。
3. **客户端是 Android Compose 原生薄壳 + WebView**,Web 核心 100% 复用,后端零改原则。
4. **后端 = 单进程 Node + `node:sqlite`(DatabaseSync)WebSocket server**。当前**没有 Redis、没有 Qdrant、没有任何向量/embedding、没有 event log、没有 graph DB**。PRD 那套(Redis Working Set + Qdrant + Event Log + Graphiti)对现状=**从零新建整套基础设施**。
5. **儿童单用户、单屏、demo 阶段**。合规(provenance/家长可控)是产品诉求但非 demo P0 阻塞项。

## 三、现有实现现状(均【已验证】· 读过源码 · 别当白纸、别重复造)
**记忆四件套(apps/server/src/):**
- `profile-store.ts`(333行,SQLite profile.db):孩子画像**唯一真相源**,family_member 表存 nickname/interests(含 confidence/source)/personality_notes/recent_emotion/game_progress(只留最近5条)。→ **已经是"单一真相源"雏形**。
- `memory-extractor.ts`(169行):turn 后**异步**从近几轮对话抽长期画像更新(改名/兴趣/性格/情绪/游戏进展),由 pipeline **出主链路异步调用,失败不影响语音**;已做 **prompt 注入校验**(防"改名为X"污染)+ **并发 lost-update 防护**(写时重读合并)。→ **已经是 PRD 的"冷路径异步抽取"!**
- `curriculum-kg.ts`(114行):K12 课程知识图谱,**纯内存只读** 10685 节点 4MB,match <10ms,**绝不在 ASR-final→首token 之间同步检索**(延迟铁律)。先修护栏离线验证 +40pp。→ **已经是 PRD 的"热路径只读预计算投影 + 延迟铁律"!**
- `feedback-store.ts`(303行):孩子吐槽/反馈 SQLite。

**所以 PRD V2 相对现状的真实增量只有:** ① append-only Event Log(event sourcing / 审计回放,现在是直接 upsert SQLite,无日志无回放) ② **向量语义召回(现在完全没有,只有结构化字段 + KG 精确匹配)** ③ Interrupt-safe in-flight 候选状态机(DRAFT/PENDING/COMMITTED) ④ bitemporal valid_time×tx_time ⑤ 来源优先级仲裁表(user_correction>parent_edit>tool>llm>asr)。

**交互层现状 + 已定设计(站在肩膀上,别重设计这部分,只需说明如何与记忆合一):**
- `pipeline.ts`(server):有 `activeTurn`(轮次守卫,所有 ASR/LLM/TTS 异步回调 `turn!==activeTurn` 丢旧轮)+ `capturedTurnMeta`(轮内 meta 快照)。
- `voice-client.ts`(前端):`playbackGeneration`(音频**播放代次**,barge-in 时 +1)+ `discardTurnAtOrBelow`(收 server `tts.turn_discard{upTo}` 后丢旧音频)。
- `useMobileVoice.ts`(831行 React hook):**批3 正在重构为 6 态 FSM**(SLEEPING/LISTENING/THINKING/SPEAKING/AWAITING_FOLLOWUP/CLOSING,useReducer 手搓)+ 有界续问窗(窗内麦连续开)+ versioned state。
- **已知硬伤(我已指出)**:批3 设计想用"单一 turnVersion 收编 capturedTurnMeta/playbackGeneration/activeTurn",但这三者**跨三层**(React FSM / 前端 voice-client / 后端 pipeline)且 playbackGeneration 是"播放代次"与"对话轮次"正交,不能塞进一个 version。正解是分层各管 + 协议对齐。

## 四、已有上层架构判断(用户已认可的方向,别推翻重来,在此之上做合一)
语音 agent 工程本质 = 三流并发(Audio/Reasoning/Action)+ event-driven + **versioned state** + latency budget。三层控制框架:Reactive(FSM+interrupt)/ Cognitive(LLM streaming+uncertainty)/ Meta(attention scheduler)。P003 按此**分阶段落地 + 按分链路现实裁剪**:端到端假设(n-best uncertainty / speculative exec / 真 attention budget)不照搬。

---

## 五、记忆系统 PRD V2 全文(核心设计输入)

> 一句话:读写路径分离、以不可变事件日志为单一真相源(CQRS)的实时语音 Agent 记忆系统,亚秒级延迟下提供长期稳定/可解释/可回溯/打断安全的认知状态。

**与 V1 关键差异:** ① Memory Compiler 移出对话主链路(热/冷路径显式分离,LLM 抽取一律出热路径) ② Event Log = 单一真相源(CQRS),vector/graph/工作集全降级为可重建投影(消解双写一致性) ③ 去掉"编译器"过度工程叙事,本质是带冲突消解的异步 ingestion pipeline,仲裁用**来源优先级**而非 LLM confidence ④ graph/bitemporal 延后到真实场景逼出 ⑤ 护城河火力集中到唯一硬点:**Interrupt-safe 一致性协议**。

**核心差异化(护城河):** ① CQRS 化记忆一致性(事件日志真相源,存储都是可重建投影,双写问题架构层消解) ② **Interrupt-safe memory consistency protocol**(语音打断/当场纠错时记忆的保护、抢占、回滚)——语音 agent 真正没人做好、最贴 ASR 场景的难点,最值得立 IP/写论文。

**设计原则:** ①读写分离(热路径只读预计算投影,严禁 LLM 抽取;一切写入异步冷路径) ②单一真相源(append-only Event Log,vector/graph/工作集可从日志重建) ③来源优先级 > LLM confidence ④不在 place 修改(只追加 supersede/invalidation → interrupt 回滚零成本) ⑤Scope 纪律(graph/bitemporal 被需求逼出才上) ⑥不重复造轮子(bitemporal 直接复用 Graphiti/Datomic/SQL:2011)。

**架构(热/冷分离 + CQRS):**
- 热路径(P95<50ms,★严禁 LLM 抽取★):① Working Set 查询(Redis KV,<10ms,只含 valid_time.to==null 的已提交真值快照) ② Vector Top-K(Qdrant,<40ms,可选语义召回)。→ Context Assembly(带 provenance/时间切片)→ LLM → TTS。热路径绝不调抽取 LLM、绝不写存储、绝不查 graph。
- 冷路径(turn 结束后异步,秒级可接受):① Candidate Extraction(LLM+规则,带 confidence+provenance) ② Conflict Resolution(来源优先级仲裁,输出 append/supersede/discard/pending) ③ Append to Event Log(唯一写真相动作) ④ Rebuild Projections(异步更新 Working Set/Vector/P2 Graph)。
- Event Log = 单一真相源:只往日志追加一次,所有存储各自异步消费独立重建;投影挂了 replay 重建,不需跨存储事务;审计/回放是免费副产品。

**记忆数据模型(Memory Event Contract):** typed semantic event:event_id / type(fact|preference|skill_state|episodic|correction|invalidation) / subject / predicate / object / valid_time{from,to:null=当前真值} / tx_time(不可改) / confidence(辅助) / provenance{source, turn_id, utterance_ref, revision_of(版本链)} / stability(ephemeral|stable|persistent) / sensitivity(low|med|high,K12家长控制) / metadata{learning_domain...}。契约规则:必须有 type+SPO 三元组;valid_time.to==null 才进 Working Set;revision_of 构成版本链,supersede/correction 必填;stability 决定淘汰与召回权重,ephemeral 默认不进 Working Set;K12 强制 sensitivity+provenance 进审计流。

**写入决策四类:** Append(新事实) / Supersede(关旧 valid_time.to + 追加新 + revision_of) / Discard(低价值/弱来源/重复) / Pending(可疑/低conf/ASR漂移,不进 Working Set,等复现或家长确认)。

**冲突消解(来源优先级,非 confidence):** user_correction(最高,当场纠正直接supersede即时生效) > parent_edit(高) > tool(中高,如题库判分) > llm_inference(中,需复现≥N次才升stability并进Working Set) > asr(低,易漂移默认ephemeral不直接成真值)。冲突类型×策略:Factual(高优来源胜/同级recency)、Temporal(关旧valid_time.to追加新)、Self-contradiction(correction事件+revision_of版本链)、Low-conf/ASR-drift(进pending等复现)。辅助信号:复现次数、recency;confidence 仅同级+recency打平时 tiebreak。

**★ Interrupt-safe 一致性协议(核心差异化):**
- in-flight 候选状态机(冷路径处理器内,**不在 Event Log**):DRAFT →(打断)冻结不提交;DRAFT→PENDING→COMMITTED(进 Event Log 才进真相)/ DISCARDED / SUPERSEDED(被 correction 抢占)。
- 关键不变量:**Working Set 只反映 COMMITTED 事件**,DRAFT/PENDING 对真相"尚不存在" → **回滚=不提交**(打断冻结的 DRAFT 永不 commit,天然干净,无需撤销)。这是"永不原地改 + event sourcing"的红利。
- 打断/纠错流程:① barge-in 区分 ASR partial/final,候选只在 final 且过来源优先级才 commit,partial 停 DRAFT ② correction 抢占:检测 user_correction → 暂停当前 DRAFT,优先编译 correction ③ 同指仲裁:correction 与冻结 DRAFT 指向同一 SPO → DRAFT 直接 DISCARDED 采用 correction;不同指 → 各自独立 commit ④ 恢复 vs 丢弃:打断后回到原话题且 DRAFT 仍有效 → 恢复至 PENDING;否则丢弃。
- 边界:Whisper 纠错延迟致 correction 晚于 DRAFT 已 commit → 退化为正常 supersede;连续多次打断 → 候选停 DRAFT 直到稳定 final,避免抖动写入。

**延迟预算:** Working Set<10ms / Vector<40ms / Context Assembly<10ms / 记忆对单轮总贡献 P95<50ms;冷路径(抽取/仲裁/重建)秒级。
**成本:** 写入即决策(弱来源discard);episodic 老化压缩为摘要;淘汰 = stability×recency×importance,ephemeral 优先。
**K12 合规:** 每条带 provenance+sensitivity,独立 audit stream;家长 audit=event replay(近乎免费);高 sensitivity 走 approval workflow(P3);端侧/联邦(P3)。
**评测:** LoCoMo(多跳/时间/纠错)、矛盾率、陈旧事实率、纠错生效延迟、打断脏写率/错误commit率、热路径P50/P95、每turn写入率/压缩率/token成本。
**实施路线:** P0 MVP(Contract+异步抽取+Event Log真相源+Working Set+Vector+来源优先级仲裁+热冷分离,**单存储vector+日志起步不上graph**)→ P1(Interrupt-safe协议+家长audit)→ P2(Graph投影多跳/bitemporal区间查询,**仅当LoCoMo类多跳被真实场景逼出**)→ P3(K12特化)。关键纪律:P0 不背三存储运维;graph 价值只在确需多跳时;大量 K12 记忆用 vector+结构化metadata+event log 已覆盖~80%。

---

## 六、你必须产出的(每家独立给,我会综合四家取并集 + 标各家独有发现)

1. **宏观合一架构(一张分层图/清单)**:记忆线与交互线如何统一?**核心追问:versioned state / turn 一致性,是不是记忆与交互两条线的交汇枢纽?** P003 现有 activeTurn(server)/playbackGeneration(前端)/FSM turnVersion(React)三层 version,与 PRD 的 Interrupt-safe 候选状态机(DRAFT/COMMITTED)是什么关系?能否用同一套 turn/version 协议同时驱动"丝滑打断"和"记忆不脏写"?

2. **PRD 增量 × P003 决策表**:对每个 PRD 要素(Event Log/CQRS、向量召回 Qdrant、Interrupt-safe 候选状态机、bitemporal、来源优先级仲裁、Redis Working Set、stability 淘汰、家长 audit/event replay)给:**照搬 / 裁剪 / 缓做**,阶段(P0/P1/P2),理由,ROI(高/中/低)。

3. **demo MVP 最小增量**:这两周能落、ROI 最高的。明确"现状已有 X → 只需补 Y"。特别回答:**Event Log 在 demo 阶段值不值得上**(还是 SQLite 直接 upsert + 一张 append-only 变更表就够)?**向量召回该不该是 demo P0**(儿童记忆量小,结构化字段+KG 是否已够)?

4. **关键风险/坑**:分链路(火山云 ASR,非本地 Whisper)、WebView、儿童 demo 对 PRD 假设的冲击。尤其:PRD 的 Interrupt-safe 协议假设"本地 ASR 纠错延迟",但 P003 是云 ASR + 已有 activeTurn 轮次守卫——协议是否被现有机制部分覆盖、是否过度设计?

5. **你的第一性原理 / 独有视角**:这个 demo 要做到"记忆极好"的**真正瓶颈**是什么?是 PRD 押注的"一致性协议/CQRS",还是别的(抽取质量?召回相关性?长期画像漂移?人设连贯?)?**PRD 是否押错了重点**——把工程火力放在 interrupt-safe 一致性(可能现有 activeTurn 已覆盖大半),而忽视了 demo 体验真正的短板?诚实说。

**输出要求**:结论先行,带优先级与理由。区分【已验证事实/推断/建议】。不要复述 PRD,要给判断和取舍。中文。
