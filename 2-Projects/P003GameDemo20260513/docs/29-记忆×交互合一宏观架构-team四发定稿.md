# docs/29 · 小可「记忆 × 交互」合一宏观架构 —— team 四发综合定稿

> **缘起**:批1/2/3、docs/25-28 一直在「哪里有问题解哪里」打补丁。川哥要一份宏观统一方案,把**丝滑流畅(语音交互)**和**记忆极好(记忆系统)**两条线收敛成一套 demo 架构。
> **输入**:川哥的《实时语音交互 AI Agent 记忆系统 PRD V2.0》(北极星) + P003 现状代码 + docs/26/27/28。
> **方法**:team 顶级四发对抗(grok-4.3 第一性原理 / codex gpt-5.5 工程严谨 / gemini-3-flash / gemini-3.5-flash 深度),cc 综合裁决。
> **四家原始输出 + Context Pack 存档**:[`_doc29-memory-arch/`](_doc29-memory-arch/)(team-grok / team-codex / team-gemini-flash / team-gemini35-deep / _context-pack)。
> **定位(川哥拍板)**:北极星 + P003 先落地。范围:记忆 + 交互合一。日期:2026-06-20。

---

## 0. 一句话结论(四家共识 · 最高置信)

> **PRD V2 方向(北极星)对,但 demo 阶段几乎全部降维。** 不建 Redis/Qdrant/EventStore/Graphiti 任何一个;用**现有 `activeTurn`+`playbackGeneration`+FSM 保丝滑** + **SQLite 一张 append-only `memory_events` 表 + 保守提交门控 + 双轴来源仲裁保记忆** + **一套 turn envelope 把两条线接起来(统一协议,不统一变量)**。两周可落。

**P0「记忆极好」的定义(codex,作为验收北极星)**:
> 宁可少记,也不假记;宁可下一轮生效,也不阻塞当前语音;每条长期记忆都能解释来源;用户纠正一定覆盖旧记忆。

---

## 1. 四家共识地图(按置信度分层)

**🟢 四家一致(最高置信,直接定):**
1. **不照搬三存储**(Redis+Qdrant+EventStore+Graphiti)。P003 单进程 Node + `node:sqlite`,全套 = 从零建运维黑洞。
2. **versioned state 是记忆×交互合一枢纽,但绝不合并成单一 turnVersion**(直接印证 docs/28 ③ 的硬伤)。codex 表述最准:**「统一协议,不统一变量;统一事件关联,不统一状态机。」**
3. **Interrupt-safe 协议大幅裁剪**:现有 `activeTurn` 已覆盖交互脏流 ~80%。候选状态机只活在冷路径内存,挂 `activeTurn` 生命周期。**打断 = 不提交 = 天然零成本回滚**。
4. **向量召回不是 demo P0**(缓 P1/P2)。儿童记忆量小,结构化字段 + KG 已覆盖 80-95%。
5. **来源优先级仲裁 P0 必做**。
6. **PRD 押错了 demo 阶段重点**:真正瓶颈不是一致性/CQRS,而是**抽取质量 + 画像漂移控制 + 人设连贯**。

**🟡 三家共识(高置信,cc 已裁决):**
- **Event Log → P0 上 SQLite 一张极简 `memory_events` 表**(codex/gemini×2 主张 P0;grok 主张 P1)。**裁决采 3 家**:成本一张表,换溯源 + 纠错链(`revision_of`)+ 未来 CQRS 迁移地基;**但只上 append + 投影同事务,绝不上 replay 引擎/多消费者**(吸收 grok 的「别过度」)。

**cc 自认被纠正的预判**:cc 原赌「向量召回是最高 ROI 缺失增量」,**四家一致否掉**——demo 阶段结构化 + KG 已够,P0 上向量是过度工程。team 的价值正在于此(治 confirmation bias)。

---

## 2. 宏观合一架构(turn envelope 为枢纽)

```
[Android 薄壳 + WebView]
  React FSM ── fsmEpoch ───────────► 只管 UI/麦克风状态(6态,见 docs/28)
  voice-client ── playbackGeneration ► 只管音频丢弃(与对话轮次正交)
        │  WS 消息统一带 envelope:{session_id, turn_id, response_id, playback_generation}
        ▼
[Server Pipeline]  activeTurn ──► ASR/LLM/TTS 旧回调守卫(已有)
  ├─ 热路径(只读,P95<50ms,★严禁 LLM 抽取★):
  │     profile-store 投影 + curriculum-kg 只读护栏 + memory_projection_version
  └─ 冷路径(turn 后异步):
        memory-extractor → 内存 DRAFT(Map<turn_id,Draft>) → 双轴仲裁 → commit gate
        │  commit 前校验 turn_id==activeTurn,不匹配 → 丢弃(= 打断回滚)
        ▼
[SQLite 单库]
  append-only memory_events(真相 + 溯源 + 纠错链)
        └─同事务─► profile-store(当前画像投影,热路径读它)
```

**交汇枢纽**:`turn_id` 是交互轮次与记忆 provenance 的**唯一纽带**。打断时 server `activeTurn++`,为旧 turn 跑的 extractor 在写库前发现 `activeTurn ≠ turn_id` → 直接丢弃 → 数据库零污染。**同一个守卫,既治丝滑打断,又治记忆不脏写。** 无需 PRD 的持久化候选状态机。

---

## 3. demo P0 清单(现状已有 → 只补什么)

**现状已有**(均已验证 · 读过源码,别重建):
- `profile-store.ts`:孩子画像唯一真相源(nickname/interests/personality_notes/recent_emotion/game_progress)= 当前画像投影雏形。
- `memory-extractor.ts`:turn 后异步抽取 + prompt 注入防护 + 并发 lost-update 防护 = 冷路径雏形。
- `pipeline.ts` `activeTurn`:ASR/LLM/TTS 旧回调守卫 = interrupt 守卫雏形。
- `curriculum-kg.ts`:纯内存只读 10685 节点 match<10ms = 热路径只读投影 + 延迟铁律。

**P0 只补 5 项(提交边界 + 可解释事件):**

| # | 补什么 | 工作量 |
|---|---|---|
| P0-1 | SQLite 新增 `memory_events` append-only 表(schema 见 §7) | 一张表 |
| P0-2 | memory-extractor 改双步:先 `INSERT memory_events` → **同事务**重建 profile 投影 | 改写入逻辑 |
| P0-3 | **commit gate**:ASR partial 永不写;只有 `definite` final 且 `turn_id==activeTurn` 才进抽取;被 `tts.turn_discard` 的轮次不写 | 门控逻辑 |
| P0-4 | **双轴仲裁**(authority × observation,见 §4.1) | 仲裁函数 |
| P0-5 | correction 抢占 supersede + LLM 推断默认 pending(复现 ≥2 次才进画像) | 抽取 prompt + 规则 |

**两个明确取舍:**
- **Event Log**:值得 P0,但只上 SQLite append-only 表,不上独立 EventStore/replay 引擎/多消费者投影。
- **向量召回**:不该 P0。等数据量逼出(多周上百条 episodic、结构化字段覆盖不了的自然语言回忆)再上,且优先 SQLite FTS,而非独立 Qdrant。

---

## 4. 关键修正(team 揪出 PRD/现状的坑)

### 4.1 🔑 不能把 ASR 一概当低优来源 —— 拆双轴(codex 独有,修正 PRD)
PRD `user_correction>parent_edit>tool>llm>asr` 方向对,但 P003 **所有儿童输入都过云 ASR**,若 ASR=低优则几乎没事实能 commit。拆**两轴**:

- **authority(谁在表达事实)**:`user_explicit` / `user_correction` / `parent_edit` / `tool`(题库判分) / `llm_inference`
- **observation(系统听清没)**:`asr_final` / `asr_uncertain` / `repeated` / `manual`

例:「我叫小明」= user_explicit × asr_final → 可 stable commit;「他好像不懂分数」= llm_inference → 不进 Working Set,需复现/工具支持。

### 4.2 🔑 assistant 说的话默认禁止成为长期记忆(codex)
demo 最隐蔽的脏写不是孩子说的,是「小可自己说了一半被打断」。小可:「下一关去火星——」孩子:「不要!」→ 若写 `game_progress=已进火星` 就是脏写。**game_progress 只由游戏状态机/tool 写;assistant 文本不入长期记忆**(除非有 `tts_delivered`/action ack)。

### 4.3 curriculum-kg 当抽取护栏(gemini)
extractor 抽出实体先过 curriculum-kg 校验,K12 范围外/错字(小猫→小毛)不写 profile。复用现有 KG 零成本。

### 4.4 🌟 把「一致性」变成「人设亮点」(gemini-3.5 深度,最妙的产品洞察)
发现冲突(昨天喜欢苹果/今天香蕉)别后台默默纠错,让小可**主动反问**:「你昨天不是说最喜欢苹果吗,今天怎么变香蕉啦?」——把工程难题转成「小可真的记得、还会追问」的体验跃升。这才是 demo 打动人的护城河。

### 4.5 伪纠错防护(gemini-3.5)
ASR 可能把「我想看」听成「不要看」触发高优 correction 篡改画像 → 纠错需**强否定 + 明确指代**句式(「不是…是…」/「我没有…」/「刚才说错了」)才认,否则降级 pending。

### 4.6 Native 优先拦截打断(gemini)
别等 WebView React state 传递,Native 薄壳收到打断信号直接强静音播放器,防火山 ASR 录入小可自己的 TTS(AEC)。配合 [[feedback_p003_voice_v2_prompt_wake_optimization]]。

### 4.7 node:sqlite 别卡首 token(codex)
`DatabaseSync` 是同步 API。memory event append / 投影重建**绝不能**在 ASR-final → LLM first token 之间执行,放 turn 后冷路径;热路径只读小 profile snapshot(可缓存到 session context)。

---

## 5. PRD 要素 × P003 决策表(四家综合)

| PRD 要素 | 决策 | 阶段 | ROI |
|---|---|---|---|
| Event Log / CQRS | 裁剪为 SQLite 一张 append-only 表 | **P0** | 高 |
| 来源优先级仲裁 | 照搬精神,改**双轴**实现 | **P0** | 高 |
| Interrupt-safe 候选状态机 | 裁剪为冷路径内存 Map + commit gate | **P0** | 高 |
| stability 淘汰 | 简化 ephemeral/stable/pending 三档 + 复现门槛 | P0/P1 | 中 |
| 家长 audit / event replay | P0 留事件表地基,P1 做 UI | P1 | 中→高 |
| Redis Working Set | 不上,SQLite profile-store 已是 | — | 低 |
| 向量召回 Qdrant | 缓做(数据量逼出再上,优先 SQLite FTS) | P1/P2 | 低 |
| bitemporal | P0 只留 valid_from/to + revision_of 字段,不做区间查询 | P2 | 低 |
| Graph / Graphiti | 缓做,已有只读 KG | P2 | 低 |

---

## 6. 北极星 vs P0 边界(一句话)
> **北极星没押错,P003 P0 若重押完整 interrupt-safe/CQRS 就阶段性押错。** 已有 `activeTurn` 覆盖大量流式脏回调 + 单用户 demo 复杂度低 + ASR 无 n-best/confidence + profile-store 已是单一投影 → 体验短板在抽取质量/保守仲裁/prompt 使用/纠错链,不在分布式一致性。

---

## 7. 数据模型:`memory_events`(P0 落地版,综合 codex 双轴 + gemini 极简)

```sql
CREATE TABLE memory_events (
  event_id      TEXT PRIMARY KEY,
  session_id    TEXT,
  child_id      TEXT,
  turn_id       INTEGER,                 -- 与交互轮次同纽带,commit gate 校验用
  response_id   TEXT,                    -- 区分同 user turn 下不同 assistant 输出
  type          TEXT,                    -- fact|preference|skill_state|episodic|correction|invalidation|game_progress
  subject       TEXT,
  predicate     TEXT,
  object_json   TEXT,
  source_authority    TEXT,              -- user_explicit|user_correction|parent_edit|tool|game_state|llm_inference
  observation_quality TEXT,              -- asr_final|asr_uncertain|repeated|manual
  stability     TEXT,                    -- ephemeral|stable|persistent
  sensitivity   TEXT,                    -- low|medium|high (K12)
  confidence    REAL,                    -- 辅助信号,不作主仲裁
  valid_from    TEXT,
  valid_to      TEXT,                    -- null=当前真值;有值=已关闭历史版本(P0 只做 当前 vs 历史 二分)
  tx_time       TEXT,                    -- 不可改
  utterance_ref TEXT,
  revision_of   TEXT,                    -- 版本链;supersede/correction 必填(纠错回溯)
  metadata_json TEXT
);
```

**契约规则(冷路径强制)**:必须有 type + SPO 三元组;只有 COMMITTED 进表;`valid_to==null` 的最高 authority 最新事件 → 投影进 profile(热路径只读);LLM inference 默认 pending 不进 profile,复现 ≥2 次升 stable;assistant-derived 默认禁写。

---

## 8. 阶段路线

| 阶段 | 范围 | 验收指标 |
|---|---|---|
| **P0(两周 MVP)** | turn envelope + eligible transcript + `memory_events` 表 + 事件 append/投影同事务 + 双轴仲裁 + correction supersede + 最小 DRAFT/PENDING/COMMITTED + assistant 禁写 + 保守 prompt 使用 | 打断脏写率 / 纠错生效延迟 / 每 turn 写入率 / pending 比例 / 热路径记忆读耗时 / 人工抽检记忆准确率 |
| **P1** | 家长 audit UI + parent_edit event + 投影重建内部工具 + stability 老化 + episodic 轻量检索(SQLite FTS) | 家长可控 + 召回更丰富 |
| **P2(北极星扩展)** | Qdrant/vector 投影 + graph 投影 + bitemporal 区间查询 + 多设备一致性 + LoCoMo 评测 | 仅当多跳/语义回忆被真实场景逼出才启动 |

---

## 9. 与 docs/26/27/28 的关系
- **docs/26**(产品定义 · 对话生命周期状态机):本架构的产品语义来源。
- **docs/27**(语音 Agent 北极星 + 分层落地):本架构是其「记忆线」的具体化;同属「北极星 + 分层落地」范式。
- **docs/28**(批3 6 态 FSM):本架构的「交互线」。⚠️ docs/28 ③ 的「单一 turnVersion 收编三补丁」已被本文 §2 修正为「统一协议,不统一变量 + turn envelope」(docs/28 已同步更新)。
- **实施合并**:批3 FSM 与记忆 P0 共享 turn envelope,本是一条线 → 建议**合并成一个迭代**实施。

---

## 10. 实施提示词(下一轮 fresh context)
> P003 小可「记忆×交互合一」P0 实施:按 docs/29 + docs/28(已对齐)。① 定义 turn envelope(session_id/turn_id/response_id/playback_generation),三层 version 各管各不合并;② SQLite 新增 `memory_events` append-only 表(schema 见 docs/29 §7);③ memory-extractor 改「先 append event → 同事务重建 profile 投影」,只消费 eligible transcript(definite final + turn_id==activeTurn,被 tts.turn_discard 的轮次不写);④ 双轴仲裁(authority × observation),correction 抢占 supersede,LLM inference 默认 pending 复现≥2 升 stable,assistant 文本禁写长期记忆;⑤ 热路径只读 profile snapshot 绝不卡首 token。批3 FSM 与记忆 P0 合并迭代,共享 turn envelope。保住所有上线功能,部署真机验(打断脏写率 + 纠错生效 + 记忆准确率抽检)。四家原始设计见 docs/_doc29-memory-arch/。
