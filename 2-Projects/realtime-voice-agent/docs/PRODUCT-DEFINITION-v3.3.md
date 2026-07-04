# 通用型实时语音 Agent 产品定义 (V3.3)

> **定位**:一个**通用型**实时语音对话 Agent 平台。
> **北极星(MVP 主线)**:用 **Tier A(cascade)达成媲美火山引擎 RTC 的对话式 AI 体验**(打断自然、判停准、低延迟、抗噪、~1s)。
> **差异化护城河**:可控、可审计、带跨会话长期记忆的对话内核(CQRS 事件溯源 + interrupt-safe 一致性)。
> **演进可选项(非 MVP 临界路径)**:需要 Seeduplex 级"边听边说"时,把体验引擎热插为 Tier B/C,**记忆内核零重写**。

---

## 0. V3.3 变更摘要 — 对工程评审意见的回应

V3.3 在 V3.2 基础上做三处优化,均针对外部评审与「一步步 MVP 迭代到火山 RTC」的目标。下表逐条记录评审意见、V3.2 是否已覆盖、V3.3 如何处理,作为可审计的决策记录。

| 评审意见 | V3.2 是否已覆盖 | V3.3 处理 |
|---|---|---|
| 对标体系混用(RTC vs Seeduplex) | **已覆盖**(§1 拆成两个独立对标靶) | 保留,并在 §1 显式声明:**MVP 只追 Tier A→RTC**,Seeduplex 是后置可选 |
| latency 当作质量唯一代理 | **实质已覆盖**(§5 五维指标) | 采纳"能力维度矩阵"(§2 新增),用正交维度替代单点延迟叙事 |
| vendor metrics 需降级标记 | **已覆盖**(全文 E0–E4 体系 + 附录 E) | 保留,§10 增加"证据账本"汇总,把"E4 为空"提为第一优先级 |
| 记忆内核需补幂等/排序/replay | **半覆盖**(C.4 / F.6 / 引用 V2.3.2) | §6/§7 把一致性机制 inline 化,不再纯靠引用 |
| 缺失失败模式章节 | 风险级覆盖(§9) | **新增 §6 失败模式与降级策略**(结构化,inline) |

**一句话**:评审的工程直觉对,但多数"结构性问题"答在它未读的附录里;V3.3 真正吸收的是**能力矩阵**与**inline 失败模式**两项,并把全文重心从"对标论证"转为"**可验收的 MVP 执行**"。

---

## 1. 北极星与目标边界(MVP-first 重述)

调研发现火山有**两个不同层级**的"全双工",必须分开对标;**MVP 只锁定第一层。**

| 对标对象 | 本质 | 关键指标(证据) | 在本产品的定位 |
|---|---|---|---|
| **火山 RTC 对话式 AI** | cascade(ASR→LLM→TTS)over RTC + 云端 3A/降噪 + 帧级 VAD 智能打断 | 端到端可低至 **~1s**;全双工随时打断(volcengine 官方,**E3**) | **★ MVP 主线 = Tier A,无需 GPU** |
| **豆包 Seeduplex** | 原生全双工端到端语音大模型(Speech2Speech) | 裸模型 ~**700ms**;相比半双工误打断 -50%、抢话 -40%、判停延迟 -250ms、满意度 +8.34%(字节 Seed,**E3**) | 后置可选 = Tier B/C,需托管 API 或 GPU |

**目标边界(显式收敛)**:
- **In scope(MVP)**:Tier A 把火山 RTC 体验逐项工程堆出来 + 承载记忆内核。北极星就是这一条。
- **Out of scope(MVP)**:Seeduplex 级"真边听边说"。这是架构天花板差异(cascade 拿不到连续重叠语音生成),**只能靠 Tier B/C**,放到 M3 之后作为引擎热插。
- **诚实声明**:对内外统一口径——**Tier A 媲美火山 RTC,不声称媲美 Seeduplex**。两者不在同一对标空间。

> 为什么 Tier A 是更对的生产选择(不是"先用着"):端到端是黑盒,牺牲可控性 / 合规可审计 / 中途可拦截 / 记忆可注入(实时语音选型共识,**E1**)——而这正是本产品记忆内核的主场。

---

## 2. 能力维度矩阵(替代单一 latency 对标)★新增

用正交能力维度描述三类系统,明确**本产品在哪些维度对齐、哪些维度故意不追**。✔ 强 / ◐ 部分 / ✖ 弱或不支持。

| 能力维度 | 火山 RTC (cascade) | 托管 Realtime (s2s API) | 自托管双流 (Moshi 类) | **本产品策略** |
|---|---|---|---|---|
| 端到端延迟 | ◐ ~1s | ✔ ~700ms | ✔ ~700ms | Tier A 对齐 ~1s;不追 700ms |
| 打断自然度 | ✔ | ✔ | ✔ | **必须对齐**(VAD+语义判停) |
| 重叠语音 / 主动 backchannel | ✖ | ◐ | ✔ | **故意不追**(MVP 不要) |
| 中途可拦截 / 可注入 | ✔ | ✖ 黑盒 | ◐ | **本产品强项,放大** |
| 文字级可审计(event replay) | ✔ | ✖ 仅音频 | ◐ | **护城河,放大** |
| 跨会话长期记忆一致性真值 | ✖ RAG/知识库 | ✖ | ✖ | **唯一拥有方,核心差异** |
| 中文鲁棒 | ✔ | ✔ 豆包原生 | ✖ Moshi 弱 | Tier A 选中文 STT/TTS |
| 部署成本 / 自主可控 | 依赖火山 | 按分钟计费,黑盒 | 需 GPU | **引擎可换、可自托管** |

**读法**:本产品**不在"重叠语音 / 700ms"这条轴上和 Seeduplex 比**;而是在"延迟+打断自然度"对齐 RTC,然后在"可拦截 / 可审计 / 长期记忆一致性"这三条 RTC 与端到端都弱的轴上拉开差距。

---

## 3. 架构主决策:可插拔"体验引擎",记忆内核恒定 ★

把"语音体验层"抽象为可替换引擎,放在一个**稳定契约**之后;记忆内核消费同一份「转录 + turn 事件」契约,跨引擎不变。完整架构见 `ARCHITECTURE.md`。

```
            ┌─────────────────────────────────────────────┐
用户音频 ──► │   可插拔 体验引擎 (Experience Engine)         │ ──► 音频回包
            │   Tier A: Cascade(流式 STT+LLM+TTS+turn)★MVP │
            │   Tier B: 托管 Realtime(豆包/OpenAI/Gemini)  │
            │   Tier C: 自托管双流(Moshi/PersonaPlex,GPU)  │
            └───────────────────┬─────────────────────────┘
                                │ 稳定契约:转录(final/interim)+ turn 事件
                                │ (start/end/interrupt/false_interrupt)+ speaker
                                ▼
            ┌─────────────────────────────────────────────┐
            │        记忆内核(恒定,CQRS)                  │
            │  冷路径抽取 → 来源优先级仲裁 → Event Log(真相)│
            │  → 投影(Working Set / Vector)→ Context 注入   │
            │  interrupt-safe DRAFT/COMMIT(挂 turn 事件)    │
            └─────────────────────────────────────────────┘
```

**归一化契约事件(记忆内核消费的最小公共集,inline 核心)** — 完整三引擎映射见附录 C:

| 归一化事件 | 关键字段 | 语义 |
|---|---|---|
| `user.speech_started` | turn_id, ts | 用户开口(VAD 驱动) |
| `user.transcript.interim` | turn_id, text | 中间转录,仅维持 DRAFT,**不提交** |
| `user.transcript.final` | turn_id, item_id, text, speaker_id | 最终转录,可触发 COMMIT 候选 |
| `user.turn_committed` | turn_id, item_id, final_text | **语义 EOU = 唯一提交点** |
| `interruption` | turn_id, is_interruption, heard_ms | 真打断 → 冻结/丢弃 DRAFT |
| `false_interruption` | turn_id | 假打断 → **不动记忆** |
| `agent.speech_started/stopped` | turn_id | agent 开口/收口 |
| `agent.transcript.final` | turn_id, item_id, text | agent 输出转录 |

**为什么三个 Tier 都能喂记忆内核**:即便端到端/realtime 模型,也可旁挂一路 STT + turn detector 取文本与 turn 事件(LiveKit 文档明确 turn detector 可与 OpenAI Realtime 并用,只需另配 STT,**E3**)。**体验引擎可升级,记忆 IP 不重写。**

---

## 4. Tier A 媲美火山 RTC 的工程清单(达标项,均不需 GPU)

| 火山能力(证据 E3) | 你的实现 |
|---|---|
| RTC 传输,全球低延迟(WTN) | WebRTC + LiveKit SFU |
| 云端音频 3A(AEC/ANS/AGC)+ AI 降噪(火山:降噪提升打断准确性) | WebRTC APM + 降噪(LiveKit BVC / DeepFilterNet 类) |
| 帧级 VAD 智能打断 | Silero VAD + 编排 barge-in |
| 语义判停(语音+语义联合,不抢话) | LiveKit 音频版 turn detector(支持中文)+ dynamic 端点 |
| 流式 ASR + 流式 TTS | 中文 Paraformer-zh-streaming / 云;低延迟流式 TTS |
| 字幕实时下发 | transcription 事件下推 |
| 角色性格 / 音色定制 | 可定制/克隆音色的 TTS |
| 端到端 ~1s | 各段流式重叠 + 端点调优守住(延迟预算见附录 D) |

> **结论**:媲美火山 RTC 体验 = 把上述组件的工程质量做到位,**不是上一个大模型**。成败手是 AEC/降噪、VAD+语义判停、流式延迟,而非模型架构。
> **反直觉锚点(E2,附录 D)**:延迟不藏在 STT/TTS,藏在 **turn-taking 判停** 与 **LLM 首 token(TTFT)**。调优先打这两处。

---

## 5. 体验质量指标与验收门槛

火山/豆包公布的指标给了可量化对标靶。所有门槛为**起步值**,须在 `Voice-Eval`(附录 E)上复现校准。

| 指标 | 定义 | Tier A 门槛(媲美 RTC) | 采集 |
|---|---|---|---|
| 端到端延迟 | 用户停说→首音频回包,**TTS 用 TTFA** | P95 < 1.2s | 在线埋点分段(LiveKit `metrics_collected` 内置) |
| EOU 误打断率 | 真未说完处误判结束 / 真未结束数 | **< 5%(重点盯)** | 回放过 turn detector 比对 `turn_boundary` |
| 判停迟滞 | 真结束→判定结束 P50/P95 | P95 < 1.5s | 同上 |
| barge-in 假阳性率 | agent 说话时误打断 / agent 说话时长 | AEC on < 2% | 注入打断回放 |
| CER(安静/噪声) | (S+D+I)/N 对齐 `gold_text` | 安静 < 8% / 噪声 < 15% | 离线回放 STT |
| 中英混说 CER 退化 | 混说切片相对退化 | < 相对 30% | 混说切片回放 |
| 转写质量 | 空/截断/迟到率(与 CER 分开统计) | 各 < 2% | 离线统计 |

> 报 P50/P95/P99,带{模型版本, 配置快照, 数据集版本, 地理}标签(可审计)。

---

## 6. 失败模式与降级策略 ★新增(inline)

success-path 之外的硬化。每项给:触发条件 → 影响 → 检测 → 降级/对策。前 4 项是记忆内核必须实现的不变量,后 2 项是体验引擎层。

| 失败模式 | 触发条件 | 影响 | 检测 | 降级 / 对策 |
|---|---|---|---|---|
| **STT drift → 记忆污染** | 嘈杂/口音导致 final 转录系统性偏差 | 错误事实进 Event Log | Voice-Eval CER 门 + 在线置信度分布漂移告警 | 抽取前置置信度门;低置信进 `low-confidence state` 不进真值;冷路径仲裁覆盖 |
| **interruption storm** | 噪声/回声引发连续误打断 | DRAFT 反复冻结、体验抖动 | barge-in 假阳性率 + 单位时间打断计数 | AEC/降噪兜底;打断去抖窗口;连续假打断触发 `false_interruption`,**记忆不动** |
| **duplicate commit** | at-least-once 投递 / 重试 | 同一 turn 重复入库 | `idempotency_key = f(turn_id, content)` 命中重复 | **幂等键去重**:`log.append(c, idempotency_key=...)`,重复直接幂等丢弃 |
| **out-of-order / 迟到 final** | 网络/多 ASR 异步,final 迟于 committed | turn 归属错乱 | 按 `item_id`/`turn_id` 对账(采用 OpenAI 对账约定,E3) | 迟到 final 按 turn_id 归位;**若该 turn 已被打断丢弃,迟到 final 一并丢弃** |
| **backchannel 误触发 COMMIT** | "嗯/对"被当成完整 turn | 噪声事实污染 + 误打断 | `is_backchannel` 标注 + 三道闸(VAD / 语义 / 文本) | 空转写 `raise StopResponse` 发 DISCARD;backchannel 文本第三道闸拦截,不进抽取 |
| **Tier B/C 引擎判停糊** | s2s 模型 turn 边界不清 | `turn_committed` 不可靠 | 对比旁挂 STT 的 EOU | 旁挂一路 STT + LiveKit turn detector **合成** `user.turn_committed`(E3) |

**核心不变量**:记忆内核**只在 `user.turn_committed` + 抽取完成时 COMMIT**;interim 永远只是 DRAFT;打断 = 零成本回滚(丢弃未提交 DRAFT)。失败模式不破坏这条不变量。

---

## 7. 记忆内核(恒定,差异化护城河)

CQRS 事件溯源,跨体验引擎不变。一致性机制 inline:

- **Event Log = 单一真相源**(append-only);Working Set / Vector 为投影(可重建)。
- **唯一提交点 = `USER_TURN_COMMITTED`**;DRAFT/COMMIT 分离 → interrupt-safe。
- **冷路径抽取 + 来源优先级仲裁**(非 LLM confidence 仲裁,避免幻觉自证)。
- **事件流语义(inline)**:至少一次投递 + **幂等键去重**;按 `item_id`/`turn_id` **对账乱序**;迟到 final **归位或随 turn 丢弃**;详见 §6 表。
- **通用可选能力**(去 K12 化后通用):
  - 合规审计:event replay 提供完整**文字可审计记录** —— 端到端黑盒给不了,ToB 卖点。
  - 敏感度/访问控制:通用数据治理选项。
  - 情绪/韵律信号:通用可选,经目标域校准门后作 low-confidence `state` 事件,默认不开。

> 消费侧骨架(DRAFT 状态机挂契约)见附录 F.6。

---

## 8. MVP 切片与验收路线(acceptance-gated)★重写

把里程碑改成**带验收门的切片**:每个门绑 §5 / 附录 E 的可测指标,达标才进下一切片。**主线全程不重写记忆内核。**

### M0 — 最小可行切片(可立即开工)

> 目标:证明"会说话 + 能打断 + 事件契约打通"的最薄垂直切片。
- **交付**:LiveKit + 流式 STT/LLM/TTS + Silero VAD barge-in,跑通一个通用 Web agent(L1 打断式)。LiveKitAdapter 把引擎事件翻成归一化契约(附录 F.3),先打到日志,不接记忆。
- **验收门 G0**:① 端到端有声音、能被打断;② 每个契约事件(`speech_started`/`transcript.*`/`turn_committed`/`interruption`)在冒烟用例里被正确 emit(对每事件断言);③ 端到端延迟有了**第一个自测数(E0→E4 的第一滴)**。
- **退出标准**:契约事件 100% 覆盖 + 端到端可演示。

### M1 — Tier A 调优到火山 RTC 级 + 记忆接入

- **交付**:云端 3A/降噪 + 语义判停(LiveKit turn detector),逼近 ~1s;接入记忆内核(Event Log + Working Set + 冷路径抽取,会记跨会话)。
- **验收门 G1**:端到端 **P95 < 1.2s**;EOU **误打断率 < 5%**;判停迟滞 **P95 < 1.5s**;跨会话记忆可召回且 event replay 可审计。
- **退出标准**:在 Voice-Eval 上 G1 全部指标达门槛(E4)。

### M2 — L2 自然轮替 + interrupt-safe 护城河

- **交付**:误打断/抢话压到对标线;DRAFT/COMMIT 挂 turn 事件 + 当场纠错;§6 失败模式全部实现(幂等/对账/backchannel 三闸)。
- **验收门 G2**:barge-in 假阳性 **< 2%**;duplicate/out-of-order 注入测试零污染;backchannel 误提交率 ≈ 0。
- **退出标准**:失败模式注入回放全绿。

### M3 — (可选)体验引擎热插 Tier B,记忆零改

- **交付**:把引擎热插为豆包 Seeduplex/OpenAI Realtime(附录 F.5),旁挂 STT+turn 喂记忆,内核不变,体验趋近 ~700ms 边听边说。
- **验收门 G3**:Tier B 路径下记忆内核**零代码改动**即可消费;端到端趋近 ~700ms。
- **退出标准**:同一记忆内核在 Tier A/B 双引擎下行为一致。

### M4 — (可选)端侧 / Tier C 自托管

- **交付**:端侧 Working Set 镜像;有 GPU 后 Tier C 自托管双流(离线可用)。

> **关键**:Tier A 在 **M0–M1 就达成火山 RTC 级体验**;Seeduplex 级是 **M3 可选热插**,不阻塞主线、不重写记忆。

---

## 9. 差异化定位(vs 火山)

| 维度 | 火山 RTC / Seeduplex | 本产品 |
|---|---|---|
| 全双工体验 | 强(标杆) | Tier A 媲美 RTC;(可选)Tier B 趋近 Seeduplex |
| 长期记忆 | RAG/知识库(无跨会话一致性真值) | **CQRS 事件溯源长期记忆 + interrupt-safe** ★ |
| 可控/可拦截 | 端到端为黑盒 | **cascade 可中途拦截、可注入** ★ |
| 合规审计 | 端到端只有音频 | **完整文字 event replay 可审计** ★ |
| 自主可控 | 依赖火山 | 引擎可换、可自托管,不锁单一厂商 |

**一句话**:在**体验上对齐火山 RTC**,在**记忆、可控、合规上超过端到端黑盒**——后者才是护城河。

---

## 10. 证据账本与诚实清单

| 类别 | 证据级 | 说明 |
|---|---|---|
| 火山 ~1s / Seeduplex ~700ms 等对标靶 | **E3** | 火山/字节官方,理想条件,**不可直接套本系统** |
| 三引擎事件名/字段/契约映射 | **E3** | 官方 API/源码核对(附录 C/F) |
| 各段延迟区间 / TTFA 选型 | **E2** | 多家 2026 公开实测,非本系统 |
| 实时语音选型共识(端到端牺牲可控性) | **E1** | 行业共识 |
| **本系统自身:端到端延迟 / CER / 误打断 / 中文 TTFA** | **E0 → 待 E4** | **未实测,这是第一优先级** |

**真实最大风险(非技术,是测量)**:E4 为空——你的系统上还没有任何实测数字。**Voice-Eval(附录 E)是把全部 E0 断言推到 E4 的唯一载体,也是 M0 的第一动作。** 在它产出前,本文所有性能结论都是"设计 + 调研",不是"已验证"。

**架构天花板诚实声明**:Tier A(cascade)拿不到"真边听边说"与主动 backchannel,这是架构差异不是调优问题。要这一档必须 Tier B/C。

---

*配套文档:`ARCHITECTURE.md`(架构与时序)、附录 C(契约接口)、附录 D(延迟预算)、附录 E(Voice-Eval 评测集)、附录 F(三 Tier 适配器骨架)。本文为去 K12 化、以火山 RTC 体验为北极星、MVP-first 的总产品定义。*
