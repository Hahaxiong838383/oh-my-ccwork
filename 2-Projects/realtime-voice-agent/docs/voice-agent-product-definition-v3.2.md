# 通用型实时语音 Agent 产品定义(V3.2)

> **定位**:一个**通用型**实时语音对话 Agent 平台。北极星是**媲美火山引擎 RTC 的全双工双流式体验**;差异化护城河是**可控、可审计、带长期记忆的对话内核**。
>
> **V3.1 增量更新(2026-06,带证据)**:新增附录 C(体验引擎稳定契约接口定义,基于 LiveKit / Pipecat / OpenAI Realtime 三引擎真实事件 API)、附录 D(Tier A 延迟预算分解 + 调优手册,基于 2026 公开实测)。
>
> **V3.2 增量更新(2026-06,带执行方案与逻辑链)**:新增附录 E(`Voice-Eval` 评测集构建规范——把全部 E0 断言推到 E4 的实测载体)、附录 F(三 Tier 适配器可运行骨架代码——把附录 C 契约落成代码)。所有结论附证据等级(E0–E4)与可验证来源。
>
> **V3.0 相对前序(V2.x)的两处范围变更**:
> 1. **去 K12 化**:不再针对 K12 做专门设计。家长审计/敏感度等改为**通用可选的企业合规能力**;情绪改为**通用可选信号**。适用场景泛化为:AI 助手、客服、陪伴、口语教学、游戏 NPC、智能硬件等。
> 2. **北极星明确为"媲美火山 RTC 体验"**,并据此把"体验层"抽象为**可插拔引擎**(§3),记忆内核(V2.0)恒定不变。

---

## 1. 对标拆解:"火山 RTC 的全双工双流式体验"到底是什么(带证据)

调研发现火山有**两个不同层级**的"全双工",必须分开对标:

| 对标对象 | 本质 | 关键指标(证据) | 媲美所需 |
|----------|------|------------------|----------|
| **火山引擎 RTC 对话式 AI** | **cascade**(ASR→LLM→TTS)over RTC + 云端 3A/AI 降噪 + 帧级 VAD 智能打断 | 端到端响应**可低至 1s**;全双工随时打断(volcengine 官方文档,E3) | **Tier A:cascade,无需 GPU** |
| **豆包 Seeduplex** | **原生全双工端到端语音大模型**(Speech2Speech,边听边说) | 裸模型 ~**700ms**;相比半双工:误打断 **-50%**、抢话 **-40%**、判停延迟 **-~250ms**、满意度 **+8.34%**(字节 Seed,2026-04-09,E3) | **Tier B/C:端到端模型** |

**核心判断**:
- "火山 RTC 对话式 AI 体验" ≈ **优秀的 cascade(L1-L2)**,~1s 延迟,**你的 Tier A 即可媲美,不需要 GPU**。
- "豆包 Seeduplex 体验" = **真双流(L3)**,~700ms 边听边说,**需端到端模型**(托管 API 或自托管 GPU)。
- 端到端是黑盒,牺牲**可控性 / 合规可审计 / 中途可拦截 / 记忆可注入**(实时语音选型共识,E1)——而这正是本产品记忆内核的主场。**因此 Tier A 不是"先用着",对一个记忆型可控 Agent 往往是更对的生产选择。**

---

## 2. 产品两大支柱

1. **体验支柱**:媲美火山 RTC 的全双工对话体验(打断自然、判停准、低延迟、抗噪)。
2. **内核支柱(差异化)**:可控、可审计、带长期记忆的对话内核(V2.0 的 CQRS 事件溯源 + interrupt-safe 一致性)。火山给你 RAG/知识库,但不给你**跨会话长期记忆 + 打断安全的一致性真值**——这是你拉开差距的地方。

---

## 3. 关键架构决策:可插拔"体验引擎",记忆内核恒定 ★

把"语音体验层"抽象为可替换引擎,放在一个稳定接口之后;**记忆内核消费同一份「转录 + turn 事件」契约,跨引擎不变。**

```
            ┌─────────────────────────────────────────────┐
            │            可插拔 体验引擎 (Experience Engine) │
用户音频 ──►│  Tier A: Cascade(流式STT+LLM+TTS+turn检测)    │──► 音频回包
            │  Tier B: 托管 Realtime(豆包Seeduplex/OpenAI/Gemini) │
            │  Tier C: 自托管双流(Moshi/PersonaPlex,需GPU)  │
            └───────────────────┬─────────────────────────┘
                                │ 稳定契约:转录(final/interim)+ turn事件(start/end/interrupt)+ speaker
                                ▼
            ┌─────────────────────────────────────────────┐
            │        记忆内核(恒定,V2.0)                   │
            │  冷路径抽取 → 来源优先级仲裁 → Event Log(真相) │
            │  → 投影(Working Set / Vector)→ Context 注入   │
            │  interrupt-safe DRAFT/COMMIT(挂 turn 事件)     │
            └─────────────────────────────────────────────┘
```

**为什么三个 Tier 都能喂记忆内核**(证据):即便是端到端/realtime 模型,也可旁挂一路 STT + turn detector 取文本与 turn 事件 —— LiveKit 文档明确"turn detector 可与 speech-to-speech 模型(如 OpenAI Realtime)并用,只需另配 STT 提供文本";volcengine RealtimeModel 亦有 RAG 函数钩子(E3/E2)。**所以体验引擎可升级,记忆 IP 不重写。**

### 三 Tier 对照

| | **Tier A:Cascade** ★默认 | Tier B:托管 Realtime | Tier C:自托管双流 |
|--|--------------------------|----------------------|-------------------|
| 对标 | 火山 RTC 对话式 AI(~1s) | 豆包 Seeduplex(~700ms 边听边说) | 同 Tier B,自有 |
| 资源 | 轻(可纯 CPU+云STT) | 零部署,按分钟计费 | **需 GPU(L4 级)** |
| 体验 | L1-L2,~1s | L3,~700ms,真边听边说 | L3 |
| 可控/合规 | **高(可拦截、有文字可审计)** | 低(黑盒) | 中 |
| 记忆集成 | **最顺(原生转录+turn)** | 需旁挂 STT+turn | 需旁挂 STT+turn |
| 中文 | 选中文 STT/TTS | 豆包原生强 | Moshi 中文弱 |

**推荐路径**:**Tier A 先达成火山 RTC 级体验并承载记忆内核;** 需要 Seeduplex 级"边听边说"时,把引擎热插为 Tier B(可直接用豆包 Seeduplex API,等于"用火山的模型媲美火山");有 GPU 后再 Tier C 自托管。

---

## 4. Tier A 媲美火山 RTC 的工程清单(达标项)

火山 RTC 体验由这几块工程堆出来,逐项对位(都不需要 GPU 双流模型):

| 火山能力(证据) | 你的实现 |
|------------------|----------|
| RTC 传输,全球低延迟(WTN) | WebRTC + LiveKit SFU |
| 云端音频 3A(AEC/ANS/AGC)+ AI 降噪(火山强调:降噪提升打断准确性) | WebRTC APM + 降噪(LiveKit BVC / DeepFilterNet 类) |
| 帧级 VAD 智能打断 | Silero VAD + 编排 barge-in |
| 语义判停(语音+语义联合,不抢话) | LiveKit 音频版 turn detector(支持中文)+ dynamic 端点 |
| 流式 ASR + 流式 TTS | 中文 Paraformer-zh-streaming / 云;低延迟流式 TTS |
| 字幕实时下发 | transcription 事件下推 |
| 角色性格 / 音色定制 | 可定制/克隆音色的 TTS |
| 端到端 ~1s | 各段流式 + 端点调优守住 |

> 结论:**媲美火山 RTC 对话式 AI 体验 = 把上述组件的工程质量做到位,不是上一个大模型。** 决定成败的是 AEC/降噪、VAD+语义判停、流式延迟,而非模型架构。

---

## 5. 体验质量指标(以 Seeduplex 公布数据为标杆,通用域)

火山/豆包公布的指标正好给了**可量化的对标靶**(替代之前缺测量设计的指标命名):

| 指标 | 定义 | Tier A 目标(媲美火山 RTC) | Tier B 目标(媲美 Seeduplex) |
|------|------|----------------------------|------------------------------|
| 端到端延迟 | 用户停说→首音频回包,P50/P95 | ~1s(P95<1.2s) | ~700ms |
| 误打断率 | agent 被噪声/无关声错误打断 / agent 说话时长 | 低(对标半双工再降一档) | 对标 Seeduplex(半双工 -50%) |
| 抢话率 | agent 在用户未说完时抢话 / 用户回合数 | 低 | 对标 Seeduplex(-40%) |
| 判停延迟 | 用户真说完→判定结束 P50/P95 | P95<1.5s | ~缩短 250ms 级 |
| 判停/流畅度 MOS | 主观评分 | 接近真人节奏 | 对标 Seeduplex(判停MOS+8%/流畅+12%) |

**测量协议**:在目标域评测集(`Voice-Eval`,按你的实际场景构建,非 K12 专属)上离线回归 + 灰度埋点;报 P50/P95/P99,带模型/配置/数据集版本(可审计)。具体公式、数据集、baseline、管线见 V2.3.2 §3(去 K12 化后通用适用)。

---

## 6. 记忆内核(恒定,差异化护城河)

不变沿用 V2.0 + V2.3.2 硬化:
- **Event Log = 单一真相源(CQRS)**;Working Set / Vector 为投影。
- **冷路径抽取 + 来源优先级仲裁**(非 LLM confidence)。
- **interrupt-safe DRAFT/COMMIT**,挂到体验引擎的 turn 生命周期事件上(LiveKit 事件 / Pipecat 帧,见 V2.3.1 附录 A)。
- **事件流语义**(顺序/幂等/去重/乱序/重试)按 V2.3.2 §2。
- **通用可选能力**(原 K12 特化降级为通用):
  - 合规审计:event replay 提供完整文字可审计记录 —— **这恰是端到端黑盒给不了的,作为对 ToB 的卖点**。
  - 敏感度/访问控制:通用数据治理选项。
  - 情绪/韵律信号:通用可选,经目标域校准门后作 low-confidence `state` 事件(V2.3.2 §6),默认不开。

---

## 7. 实施路线(以体验引擎 + 记忆为主线)

| 里程碑 | 体验 | 记忆 | 交付 |
|--------|------|------|------|
| **M0** | Tier A 跑通:LiveKit + 流式 STT/LLM/TTS + barge-in,**L1 打断式** | 无 | 会说话、能打断的通用 Web agent |
| **M1** | Tier A 调优:云端 3A/降噪 + 语义判停,**逼近火山 RTC ~1s** | Event Log + Working Set + 冷路径抽取(会记) | 媲美火山 RTC 的对话 + 跨会话记忆 |
| **M2** | **L2 自然轮替**(误打断/抢话压到对标线) | interrupt-safe 挂 turn 事件 + 纠错 | 护城河:打断安全 + 当场纠错 |
| **M3** | 体验引擎**热插 Tier B**(豆包 Seeduplex/OpenAI),媲美 ~700ms 边听边说 | 旁挂 STT+turn 喂记忆,内核不变 | Seeduplex 级体验 + 记忆 |
| **M4** | 端侧版(V2.1)/ 有 GPU 后 Tier C 自托管 | 端侧 Working Set 镜像 | 自有、可离线 |

> Tier A 在 M0-M1 就达成火山 RTC 级体验;Seeduplex 级是 M3 的可选热插,**不阻塞主线、不重写记忆**。

---

## 8. 差异化定位(vs 火山)

| 维度 | 火山 RTC / Seeduplex | 本产品 |
|------|----------------------|--------|
| 全双工体验 | 强(标杆) | Tier A 媲美 RTC;Tier B 媲美 Seeduplex |
| 长期记忆 | RAG/知识库(无跨会话一致性真值) | **CQRS 事件溯源长期记忆 + interrupt-safe** ★ |
| 可控/可拦截 | 端到端为黑盒 | **cascade 可中途拦截、可注入** ★ |
| 合规审计 | 端到端只有音频 | **完整文字 event replay 可审计** ★ |
| 自主可控 | 依赖火山 | 引擎可换、可自托管,不锁定单一厂商 |

**一句话**:在**体验上对齐火山**,在**记忆、可控、合规上超过端到端黑盒**——后者才是护城河。

---

## 9. 风险与诚实清单

1. **Tier A 与 Seeduplex 的真实差距**:cascade 拿不到"真边听边说"(架构天花板),~1s vs ~700ms,且无主动 backchannel。要这一档必须 Tier B/C。**对内外说清:Tier A 媲美火山 RTC,不是媲美 Seeduplex。**
2. **达标取决于工程质量,不是模型**:AEC/降噪、VAD+语义判停、流式延迟是成败手,需逐项打磨到火山级(§4)。
3. **中文 STT/判停在目标域的实测**:能力层已具备(Paraformer-zh-streaming、LiveKit 中文 turn detector,E3),性能层需在 `Voice-Eval` 上测(误打断率重点盯)。
4. **Tier B 的取舍**:用托管 realtime 拿低延迟,但牺牲可控/合规,且记忆需旁挂 STT;按场景权衡(高合规场景留 Tier A)。
5. **证据等级**:体验对标指标多为 E3(火山/字节官方);本系统自身性能为 E0,待 `Voice-Eval` 实测(E4)。详见 V2.3.2 证据 register。

---

*配套文档:V2.0(记忆架构)、V2.1(端侧)、V2.3.1(全双工 hook + 中文 STT 调研)、V2.3.2(工程硬化:证据/事件语义/指标/失败模式)。本文为去 K12 化、以火山 RTC 体验为北极星的总产品定义,统领上述各件。*

---
---

# 附录 C — 体验引擎稳定契约接口定义(基于三引擎真实 API)

> 目标:定义一份**归一化契约**,让 Tier A(cascade)/ Tier B(托管 realtime)/ Tier C(自托管双流)三种体验引擎都映射到同一组事件,**记忆内核消费它,跨引擎不重写**。下表的每个引擎事件名均来自官方 API/源码(2026-06 核对,E3)。

## C.1 三引擎的真实事件词汇(证据)

**LiveKit AgentSession**(E3:docs.livekit.io/reference/agents/events/):`user_input_transcribed`(transcript / is_final / language / speaker_id)、`conversation_item_added`(role=user/assistant)、`user_state_changed`、`agent_state_changed`、`overlapping_speech`(is_interruption)、`agent_false_interruption`、`speech_created`。

**Pipecat 帧**(E3:reference-server.pipecat.ai):`UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame`、`VADUserStarted/Stopped`、`InterimTranscriptionFrame` / `TranscriptionFrame`、`StartInterruptionFrame` / `BotInterruptionFrame`、`BotStarted/StoppedSpeakingFrame`、`UserMuteStarted/Stopped`。

**OpenAI Realtime**(E3:platform.openai.com/docs/api-reference/realtime,github transitive-bullshit/openai-realtime-api/events.ts):`input_audio_buffer.speech_started` / `speech_stopped` / `committed`、`conversation.item.input_audio_transcription.delta` / `.completed` / `.failed`、`conversation.item.created`、`response.created` / `response.done`、`response.audio_transcript.delta` / `.done`、`conversation.item.truncate` / `.truncated`(打断时截断未播音频)。关键事实(E3):Realtime 的输入转写由**独立 ASR**(如 gpt-realtime-whisper)产出,官方称"是粗略指引、可能与模型理解有偏差",且建议**用 `item_id` 排序与对账最终转录**。豆包/火山 RealtimeModel 经 `livekit-plugins-volcengine` 暴露,带 RAG 函数钩子(E2,pypi)。

## C.2 归一化契约(记忆内核消费的事件)

| 归一化事件 | 字段 | LiveKit 来源 | Pipecat 来源 | OpenAI Realtime 来源 |
|------------|------|--------------|--------------|----------------------|
| `user.speech_started` | turn_id, ts | user_state_changed(speaking) | UserStartedSpeakingFrame | input_audio_buffer.speech_started |
| `user.transcript.interim` | turn_id, text, lang | user_input_transcribed(is_final=false) | InterimTranscriptionFrame | …transcription.delta |
| `user.transcript.final` | turn_id, item_id, text, lang, speaker_id, conf? | user_input_transcribed(is_final=true) | TranscriptionFrame | …transcription.completed |
| `user.turn_committed`(语义EOU) | turn_id, item_id, final_text | on_user_turn_completed / conversation_item_added(user) | UserStoppedSpeakingFrame(Smart Turn) | input_audio_buffer.committed + transcription.completed |
| `interruption` | turn_id, is_interruption, heard_ms | overlapping_speech(is_interruption=true) / interrupt() | StartInterruptionFrame | speech_started → response.cancelled + item.truncate |
| `false_interruption` | turn_id | agent_false_interruption | (resume 逻辑) | (n/a,由 VAD 兜) |
| `agent.speech_started/stopped` | turn_id | agent_state_changed(speaking) | BotStarted/StoppedSpeakingFrame | response.created / response.done |
| `agent.transcript.final` | turn_id, item_id, text | conversation_item_added(assistant) | transcription_node | response.audio_transcript.done |

**字段规范**:`turn_id` 必填(贯穿一个回合);`item_id` 用于排序/对账(直接采用 OpenAI 的对账约定,E3);`speaker_id` 用于归属;`is_final` 决定是否可触发 COMMIT;`heard_ms` 即"用户已听到的时长"(LiveKit/OpenAI 打断截断的共同语义)。

## C.3 适配层职责(每 Tier)

- **Tier A(cascade)**:事件原生齐全(STT 出 interim/final,turn detector 出 EOU,编排出打断)→ 直接映射。**最顺**。
- **Tier B(托管 realtime)/ Tier C(自托管双流)**:引擎以语音为中心,turn 边界较糊。两条路:
  1. **用引擎自带的转写事件**(OpenAI 的 transcription.delta/completed;豆包经插件)→ 映射 `user.transcript.*`。注意输入转写是"粗略指引"(E3),用于记忆抽取可接受。
  2. **旁挂一路 STT + turn detector**(证据:LiveKit 文档明确 turn detector 可与 OpenAI Realtime 这类 speech-to-speech 模型并用,只需另配 STT 提供文本,E3)→ 合成 `user.turn_committed`。
- 三者都把"打断截断到已听部分"的引擎行为,映射为 `interruption(heard_ms)`;**但记忆内核不依赖它回滚**——只在 `user.turn_committed` + 抽取完成时 COMMIT(V2.0 §9 / V2.3.1 附录 A 的 DRAFT 机制)。

## C.4 对账与乱序规则(证据驱动)
- OpenAI 官方建议(E3):用 `item_id` 排序对账最终转录;并"决定 UI 如何在后续 delta 修正早前文本时刷新"。→ 记忆侧:interim 仅维持 DRAFT,**只有 `user.transcript.final` / `user.turn_committed` 可触发 COMMIT**;迟到 final 按 `turn_id`/`item_id` 归位,若该 turn 已被打断丢弃则迟到 final 也丢弃(V2.3.2 §2.4 一致)。
- 输入转写质量监控:OpenAI 建议(E3)"把空、截断、迟到的转写与 WER 分开统计" → 纳入 `Voice-Eval`(V2.3.2 §3)。

> 结论:契约不是凭空设计,而是三引擎真实事件的**最小公共归一化**。Tier 升级 = 写一个把引擎事件翻成上表的适配器,记忆内核零改动。

---
---

# 附录 D — Tier A 媲美火山 RTC 的延迟预算分解 + 调优手册(基于 2026 实测)

> 目标:把"端到端 ~1s(火山 RTC 级)"拆成各段 ms 预算,给出证据与调优杠杆。**核心反直觉结论(多源印证,E2):延迟不藏在 STT/TTS,藏在 turn-taking 判停与 LLM 首 token。**

## D.1 各段延迟预算(用户停说 → 首音频回包)

| 阶段 | 实测区间(证据) | 证据级 | 来源 |
|------|------------------|--------|------|
| 网络往返(RTT) | 30–80ms | E2 | retellai.com 语音管线拆解(2026) |
| **判停 / turn-taking 决策** | **150–300ms(最大变量)** | E2 | retellai.com:"坏的判停模型不进 benchmark 却吃 500ms+ 感知延迟" |
| └ turn detector 推理 | ~25ms | E3 | huggingface.co/livekit/turn-detector |
| └ VAD 静音判定 | OpenAI server_vad 默认静音 500ms / 前缀 300ms | E3 | platform.openai.com realtime client-events |
| STT 部分结果 | 每 ~50ms 出 partial | E2 | retellai.com |
| └ STT 最终化 | < 300ms(Universal-3 / Deepgram 级) | E2 | assemblyai.com;gladia.io(前轮) |
| **LLM 首 token(TTFT)** | **300–600ms(第二大变量)** | E2 | retellai.com;channel.tel(前轮:600ms 等 LLM 起步) |
| **TTS 首音频(TTFA)** | 40–300ms(按引擎) | E2/E3 | 见 D.2 |
| 客户端音频缓冲 | 默认 ~500ms,可调小 | E3 | elevenlabs.io/docs latency |
| WebSocket 每回合连接 | ~50ms(多路复用可省) | E2 | gradium.ai |

**关键:各段是流式重叠的,不是相加。** STT 出 partial → LLM 边收边吐 token → TTS 从首 token 就开始合成音频(每 200–400ms 一块);"每一级在上一级结束前就开始输出"(retellai.com,E2)。所以各段名义和看似 >1.5s,**实际感知端到端可压到 ~600ms–1s**。

## D.2 TTS TTFA 选型(证据,注意 TTFA≠TTFB)

测量必须用 **TTFA(首个可播放音频)**,不是 TTFB——TTFB 含 WAV/MP3 容器头,无声音(gradium.ai,E3)。2026 公开数:

| TTS | TTFA(实测/官方) | 证据级 | 来源 |
|-----|------------------|--------|------|
| Cartesia Sonic 4 / Turbo | ~40ms | E2 | futureagi.com(2026-05) |
| Cartesia Sonic-3 | ~90ms;188ms P50(IQR 100ms,尾部跨 300ms) | E2 | gradium.ai / Coval |
| ElevenLabs Flash v2.5 | ~75ms 推理;Turbo v2.5 264ms P50(IQR 28ms,稳) | E2 | gradium.ai |
| Deepgram Aura-2 | sub-200ms,可调 ~90ms | E2 | futureagi.com |
| 标准云(Google/AWS/Azure/OpenAI) | 150–300ms(理想条件) | E2 | futureagi.com |

> **中文缺口(诚实标注,E0)**:上述多为英文/欧语,且测自巴黎/印度等地。**中文低延迟 TTS 的 TTFA 须自测**(候选:火山 TTS、MiniMax、Qwen-TTS 等);目标对齐 sub-300ms TTFA。这是 `Voice-Eval` 必测项(E0→E4)。

## D.3 端到端目标

| 目标 | 数值 | 证据 |
|------|------|------|
| 火山 RTC 对话式 AI(Tier A 对标) | ~1s | E3:volcengine.com docs(前轮) |
| 自然感临界 | < 700ms 才"像人";Retell 栈 ~600ms | E2:retellai.com |
| 良好优化的 cascade | sub-1.5s 可达 | E2:camb.ai |
| Seeduplex(Tier B 对标) | ~700ms 裸模型 | E3:seed.bytedance.com(前轮) |

**Tier A 现实目标**:端到端 P95 < 1.2s(媲美火山 RTC);冲刺 ~700ms 需逼到各段极限或上 Tier B。

## D.4 调优手册(按收益排序,均有证据)

1. **先打 turn-taking 与 LLM TTFT**——延迟真正藏身处(retellai.com,E2)。其余是"达标即可"。
2. **语义判停替代纯 VAD 静音**:避免傻等 500ms 静音;用 LiveKit 音频 turn detector / OpenAI semantic_vad(对"嗯…"动态延长),调 `min/max_endpointing_delay`(E3)。
3. **预测性生成(preemptive_generation)**:EOU 确认前投机起 LLM/TTS,压低感知 TTFT(LiveKit,E3);代价是打断时白做——正好挂到记忆 DRAFT(V2.3.1 附录 A)。
4. **全链路流式、严禁阻塞**:STT partial → LLM token → TTS chunk 逐级重叠(retellai.com / gradium.ai,E2)。
5. **选低 TTFA 的 TTS**:英文 Cartesia(SSM,~40ms);中文须自测(D.2)。用 **TTFA 不用 TTFB** 衡量(gradium.ai,E3)。
6. **地理同址**:STT/LLM/TTS/编排/用户尽量同区,跨数据中心可加数百 ms(gradium.ai / elevenlabs,E2/E3)。
7. **WebSocket 多路复用**:复用单连接省 ~50ms/回合(gradium.ai,E2)。
8. **调小客户端音频缓冲**:默认 ~500ms 偏大,降低换取轻微 stutter 风险(elevenlabs,E3)。
9. **云端 3A + AI 降噪**:火山强调降噪提升打断准确性(E3);用 WebRTC APM + 降噪模型,减少误打断带来的感知卡顿。

## D.5 测量协议(可复现)
- 指标:端到端(用户停说→首音频)P50/P95/P99;各段分别埋点。**TTS 用 TTFA**。
- 条件:在**目标地理 + 中文栈**上测(D.2 的英文/他地数字不可直接套用,E2 警告:vendor 数字是理想条件)。
- 纳入 `Voice-Eval`(V2.3.2 §3),带模型/配置/地理/版本标签,可审计。

## D.6 证据级与缺口(诚实)
- 各段延迟区间:E2(多家 2026 公开实测/拆解,非本系统)。
- turn detector / OpenAI VAD / TTFA≠TTFB / 客户端缓冲:E3(官方)。
- 火山 ~1s、Seeduplex ~700ms:E3(官方)。
- **本系统自身端到端、中文 TTS TTFA:E0(未测)** → 待 `Voice-Eval` 实测(E4)。这是动手第一优先级。


---
---

# 附录 E — `Voice-Eval` 评测集构建规范(执行方案)

## E.0 逻辑链(为什么必须有这一件)

```
前面所有性能结论(延迟≈1s、CER、判停误打断率、TTFA、情绪)目前是 E0–E2
        │  ← 这些数来自他人/他域/理想条件,不能直接套用本系统
        ▼
工程评审(本对话中的审计)的根本指控:E4(本系统目标域实测)为空
        ▼
Voice-Eval = 把每个 E0 断言推到 E4 的唯一实测载体
        ▼
没有它 → 产品停在"设计+调研";有它 → 可进研发、可验收、可审计
```

**证据驱动的方法论锚点**(决定怎么测):
- 用真实生产音频测,而非干净样本;逐语种测;eval 集须含数字/日期/货币/邮箱/产品名/领域术语(OpenAI Realtime 转写文档,E3:platform.openai.com/docs/guides/realtime-transcription)。
- 把**空转写 / 截断转写 / 迟到转写**与 WER 分开统计(同上,E3)。
- vendor 数字是理想条件,**必须在自己的地理 + 真实并发 + 生产长度文本上复现**;盯 P95 不盯均值(futureagi.com,E2)。
- TTS 用 **TTFA 不用 TTFB**(gradium.ai,E3)。
- **死盯误打断率**——用户对"被打断"的抱怨多于一切(Hamming,4M+ 通话分析,E2,前轮)。

## E.1 数据集构成(通用域,非 K12)

**三维笛卡尔覆盖**:场景 × 声学条件 × 对话行为。

| 维度 | 取值 |
|------|------|
| 场景 | AI 助手 / 客服 / 陪伴 / 口语教学 / 游戏 NPC / 智能硬件(火山公布的通用场景) |
| 声学条件 | 安静 / 家居噪声 / 多人背景 / 弱网 |
| 对话行为 | 陈述 / 停顿犹豫("嗯…") / 当场纠错 / 打断(barge-in) / **中英混说**(国内刚需,E1:实时语音选型文) |

**规模起点**:≥ 10h 真实音频,≥ 50 说话人,覆盖以上组合;每组合 ≥ 30 条。逐句标注。(规模为 E0 起步建议,按统计功效调整。)

## E.2 标注规范(每 utterance)

| 字段 | 说明 | 服务于哪个指标 |
|------|------|----------------|
| `gold_text` | 人工黄金转写(含数字/日期/术语) | CER |
| `speaker_id` | 说话人 | 归属、重叠 |
| `turn_boundary` | 真实"说完"时间点 | EOU 误打断率/迟滞 |
| `is_backchannel` | 是否纯附和("嗯/对") | backchannel 过滤、误打断 |
| `is_interruption` | 是否真打断 | barge-in 假阳性 |
| `emotion`(可选) | 情绪标签 | 情绪准确率(门控用) |
| `ts_start/ts_end` | 时间戳 | 延迟对齐 |
| `lang_segments` | 中英混说分段 | 混说鲁棒性 |

## E.3 指标 × 测量协议(逐项可复现)

> 复用 V2.3.2 §3 + 附录 D,去 K12 化、通用化。每指标:定义/公式 · baseline · 采集 · 门槛。

| 指标 | 定义/公式 | baseline | 采集 | 门槛(起步) |
|------|-----------|----------|------|------------|
| CER | (S+D+I)/N,与 `gold_text` 对齐 | Paraformer-Large 5.80% / FireRedASR 3.05%(公开,E3) | 离线回放 STT | 安静<8% / 噪声<15%(待校准) |
| 中英混说 CER | 同上,混说切片 | — | 混说切片回放 | 退化 < 相对 30% |
| EOU 误打断率 | 真未说完处误判结束数 / 真未结束数 | VAD-only | 回放过 turn detector 比对 `turn_boundary` | <5%(**重点盯**) |
| EOU 迟滞 | 真结束→判定结束 P50/P95 | — | 同上 | P95<1.5s |
| barge-in 假阳性率 | agent 说话时误打断 / agent 说话时长 | AEC off | 注入打断回放 | AEC on <2% |
| 端到端延迟 | 用户停说→首音频,P50/P95/P99;**TTS 用 TTFA** | 火山 ~1s(E3) | 在线埋点分段 | P95<1.2s |
| 转写质量 | 空/截断/迟到率(**与 CER 分开**,OpenAI 建议) | — | 离线统计 | 各 <2% |
| 情绪准确率 | UA/WA/F1 | SenseVoice 公开基准(E3) | 旁路 vs 标注 | 见 V2.3.2 §6 门控,达标前不入记忆 |

## E.4 采集与仪表(可直接复用框架内置)

**证据:LiveKit `metrics_collected` 事件已内置 STT/LLM/TTS/VAD/EOU 指标,自适应打断开启时还含 `InterruptionMetrics`(打断检测延迟与请求量);`ChatMessage.metrics` 给每回合延迟**(E3:docs.livekit.io/reference/agents/events/)。
→ 延迟/判停/打断的在线采集**不必从零造**,挂 `metrics_collected` + `ChatMessage.metrics` 即可;离线指标(CER/情绪/转写质量)走固定回放管线。

## E.5 baseline 与门槛来源(对标靶,带证据)

- 端到端 ~1s:火山 RTC 对话式 AI(E3)。
- 误打断 -50% / 抢话 -40% / 判停延迟 -250ms / 满意度 +8.34% / 判停MOS+8% / 流畅MOS+12%:Seeduplex 相对半双工公布值(字节 Seed,E3)→ 作为"接近真人"的量化靶。
- CER 参照:FireRedASR 3.05% / Paraformer-Large 5.80%(公开基准,E3)。
- **告诫**:以上均为他域/理想条件;门槛起步值须在 Voice-Eval 上复现校准(futureagi,E2)。

## E.6 版本化与可审计
数据集版本号 + 标注规范版本;每次模型/阈值/地理变更重跑并归档;结果带{模型版本, 配置快照, 数据集版本, 地理}标签。→ 满足审计评审的"可审计/可复现"要求。

## E.7 证据级
- 方法论锚点:E3(OpenAI/Gradium 官方)+ E2(futureagi/Hamming 实测分析)。
- 对标靶:E3(火山/字节官方)。
- **本系统结果:E0 → 执行 Voice-Eval 后升 E4。** 这是第一优先级。

---
---

# 附录 F — 三 Tier 适配器可运行骨架代码(把附录 C 契约落成代码)

## F.0 逻辑链与诚实声明

```
附录 C 定义归一化契约 → 适配器把各引擎"真实事件"翻成契约 → 记忆内核(V2.0/V2.3.1 DRAFT 状态机)消费契约,跨引擎零改动
```

**诚实声明(证据级)**:下列代码的**事件名/字段/回调签名均来自官方 API 核对(E3)**;但**端到端运行未实测(E0)**——需安装对应 SDK(`livekit-agents`、`pipecat-ai`、`websockets`)并做冒烟测试。可运行示例参考 LiveKit 官方 `github.com/livekit-examples/python-agents-examples`(E3)。这是结构正确的骨架,非已验证的生产代码。

## F.1 归一化契约(数据类,对齐 C.2)

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
import time

class CType(str, Enum):
    USER_SPEECH_STARTED     = "user.speech_started"
    USER_TRANSCRIPT_INTERIM = "user.transcript.interim"
    USER_TRANSCRIPT_FINAL   = "user.transcript.final"
    USER_TURN_COMMITTED     = "user.turn_committed"    # 语义 EOU,唯一可触发 COMMIT
    INTERRUPTION            = "interruption"
    FALSE_INTERRUPTION      = "false_interruption"
    AGENT_SPEECH_STARTED    = "agent.speech_started"
    AGENT_SPEECH_STOPPED    = "agent.speech_stopped"
    AGENT_TRANSCRIPT_FINAL  = "agent.transcript.final"

@dataclass
class ContractEvent:
    type: CType
    turn_id: str
    item_id: Optional[str] = None       # 排序/对账(采用 OpenAI item_id 约定)
    text: Optional[str] = None
    is_final: bool = False
    language: Optional[str] = None
    speaker_id: Optional[str] = None
    confidence: Optional[float] = None
    is_interruption: Optional[bool] = None
    heard_ms: Optional[int] = None      # 用户已听到时长(打断截断语义)
    ts: float = field(default_factory=time.time)
```

## F.2 基类

```python
from typing import Callable

class ExperienceEngineAdapter:
    """把具体引擎事件翻成 ContractEvent,推给记忆内核。"""
    def __init__(self, on_event: Callable[[ContractEvent], None]):
        self._emit = on_event
    def start(self):
        raise NotImplementedError

def _next_turn(t: str) -> str:
    return f"t{int(t[1:]) + 1}"
```

## F.3 Tier A — LiveKit 适配器(事件名/属性均核对 E3)

```python
# 证据:@session.on("user_input_transcribed") 用法见 docs.livekit.io/recipes/repeater
# 事件属性 transcript/is_final/language/speaker_id 见 docs.livekit.io/reference/agents/events/
from livekit.agents import AgentSession, StopResponse  # 导入路径随版本;事件字符串名已核对

class LiveKitAdapter(ExperienceEngineAdapter):
    def __init__(self, session: AgentSession, on_event):
        super().__init__(on_event)
        self.session = session
        self._turn = "t0"

    def start(self):
        s = self.session

        @s.on("user_state_changed")           # listening/speaking/away(VAD 驱动)
        def _(ev):
            if getattr(ev, "new_state", None) == "speaking":
                self._emit(ContractEvent(CType.USER_SPEECH_STARTED, self._turn))

        @s.on("user_input_transcribed")       # transcript / is_final / language / speaker_id
        def _(ev):
            t = CType.USER_TRANSCRIPT_FINAL if ev.is_final else CType.USER_TRANSCRIPT_INTERIM
            self._emit(ContractEvent(t, self._turn, text=ev.transcript,
                                     is_final=ev.is_final, language=ev.language,
                                     speaker_id=getattr(ev, "speaker_id", None)))

        @s.on("conversation_item_added")      # role=user/assistant;content 可能是 list(#1792)
        def _(ev):
            role = ev.item.role
            text = _extract_text(ev.item.content)
            if role == "user":
                self._emit(ContractEvent(CType.USER_TURN_COMMITTED, self._turn,
                                         item_id=getattr(ev.item, "id", None),
                                         text=text, is_final=True))
                self._turn = _next_turn(self._turn)
            elif role == "assistant":
                self._emit(ContractEvent(CType.AGENT_TRANSCRIPT_FINAL, self._turn, text=text))

        @s.on("overlapping_speech")           # is_interruption 区分真打断 / backchannel
        def _(ev):
            if getattr(ev, "is_interruption", False):
                self._emit(ContractEvent(CType.INTERRUPTION, self._turn, is_interruption=True))

        @s.on("agent_false_interruption")     # 假打断:不动记忆
        def _(ev):
            self._emit(ContractEvent(CType.FALSE_INTERRUPTION, self._turn))

        @s.on("agent_state_changed")          # speaking → agent 开口
        def _(ev):
            if getattr(ev, "new_state", None) == "speaking":
                self._emit(ContractEvent(CType.AGENT_SPEECH_STARTED, self._turn))


def _extract_text(content):
    # 证据 #1792:content 可能是 [{'type':'text','text':'...'}] 而非字符串
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(c.get("text", "") if isinstance(c, dict) else str(c) for c in content)
    return getattr(content, "text", str(content))
```

> 语义 EOU 与 backchannel 过滤:可在 `Agent` 子类重写 `on_user_turn_completed`,空转写时 `raise StopResponse`(API 文档 E3),并对该 turn 发 DISCARD,不进记忆。

## F.4 Tier A 备选 — Pipecat 适配器(帧名核对 E3)

```python
# 证据:帧定义 reference-server.pipecat.ai;FrameProcessor.process_frame 见 issue #1323
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.frames.frames import (
    UserStartedSpeakingFrame, UserStoppedSpeakingFrame,
    InterimTranscriptionFrame, TranscriptionFrame,
    StartInterruptionFrame, BotStartedSpeakingFrame,
)

class PipecatAdapter(FrameProcessor):
    def __init__(self, on_event, **kw):
        super().__init__(**kw)
        self._emit = on_event
        self._turn = "t0"

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, UserStartedSpeakingFrame):
            self._emit(ContractEvent(CType.USER_SPEECH_STARTED, self._turn))
        elif isinstance(frame, InterimTranscriptionFrame):
            self._emit(ContractEvent(CType.USER_TRANSCRIPT_INTERIM, self._turn, text=frame.text))
        elif isinstance(frame, TranscriptionFrame):            # 最终转录
            self._emit(ContractEvent(CType.USER_TRANSCRIPT_FINAL, self._turn,
                                     text=frame.text, is_final=True,
                                     language=getattr(frame, "language", None)))
        elif isinstance(frame, UserStoppedSpeakingFrame):      # Smart Turn 判停 = turn_committed
            self._emit(ContractEvent(CType.USER_TURN_COMMITTED, self._turn, is_final=True))
            self._turn = _next_turn(self._turn)
        elif isinstance(frame, StartInterruptionFrame):
            self._emit(ContractEvent(CType.INTERRUPTION, self._turn, is_interruption=True))
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._emit(ContractEvent(CType.AGENT_SPEECH_STARTED, self._turn))
        await self.push_frame(frame, direction)                # 不吞帧,继续下游
```

## F.5 Tier B/C — OpenAI Realtime 适配器(事件名核对 E3)

```python
# 证据:事件名/字段见 platform.openai.com/docs/api-reference/realtime + events.ts
import json

class OpenAIRealtimeAdapter(ExperienceEngineAdapter):
    def __init__(self, ws, on_event):
        super().__init__(on_event)
        self.ws = ws
        self._turn = "t0"

    async def start(self):
        async for raw in self.ws:
            ev = json.loads(raw)
            t = ev["type"]
            if t == "input_audio_buffer.speech_started":
                self._emit(ContractEvent(CType.USER_SPEECH_STARTED, self._turn))
                # 打断语义:agent 在说时 speech_started 会触发引擎 response.cancelled
            elif t == "conversation.item.input_audio_transcription.delta":
                self._emit(ContractEvent(CType.USER_TRANSCRIPT_INTERIM, self._turn,
                                         text=ev.get("delta", "")))
            elif t == "conversation.item.input_audio_transcription.completed":
                # 注意:输入转写是独立 ASR,官方称"粗略指引";用于记忆抽取可接受
                self._emit(ContractEvent(CType.USER_TRANSCRIPT_FINAL, self._turn,
                                         item_id=ev.get("item_id"),
                                         text=ev.get("transcript", ""), is_final=True))
            elif t == "input_audio_buffer.committed":          # turn 提交
                self._emit(ContractEvent(CType.USER_TURN_COMMITTED, self._turn,
                                         item_id=ev.get("item_id"), is_final=True))
                self._turn = _next_turn(self._turn)
            elif t == "response.audio_transcript.done":        # agent 输出转写
                self._emit(ContractEvent(CType.AGENT_TRANSCRIPT_FINAL, self._turn,
                                         text=ev.get("transcript", "")))
            elif t == "response.created":
                self._emit(ContractEvent(CType.AGENT_SPEECH_STARTED, self._turn))
            elif t == "response.done":
                self._emit(ContractEvent(CType.AGENT_SPEECH_STOPPED, self._turn))
```

> Tier B/C 若引擎判停糊:旁挂一路 STT + LiveKit turn detector 合成 `user.turn_committed`(证据 E3:LiveKit 文档明确 turn detector 可与 OpenAI Realtime 并用,只需另配 STT)。豆包 Seeduplex 经 `livekit-plugins-volcengine` 接入后,复用 LiveKitAdapter 路径(E2)。

## F.6 记忆内核消费骨架(DRAFT 状态机挂契约,V2.0 / V2.3.1)

```python
class MemoryKernel:
    """只在 turn_committed 提交;打断冻结 DRAFT,不提交即零成本回滚。"""
    def __init__(self, event_log, extractor, working_set):
        self.log = event_log          # V2.0 已定义:append-only 真相
        self.extract = extractor      # V2.0 已定义:LLM+规则抽取
        self.ws = working_set         # V2.0 已定义:Working Set 投影
        self.drafts = {}              # turn_id -> 暂定文本

    def on_event(self, e: ContractEvent):
        if e.type in (CType.USER_TRANSCRIPT_INTERIM, CType.USER_TRANSCRIPT_FINAL):
            self.drafts[e.turn_id] = e.text                 # 维持 DRAFT,不提交
        elif e.type == CType.INTERRUPTION:
            self.drafts.pop(e.turn_id, None)                # 冻结/丢弃 → 零成本回滚
        elif e.type == CType.FALSE_INTERRUPTION:
            pass                                            # 不动记忆
        elif e.type == CType.USER_TURN_COMMITTED:           # 唯一提交点
            text = e.text or self.drafts.pop(e.turn_id, None)
            if not text or _is_backchannel(text):           # backchannel 第三道闸
                return
            for c in _dedupe(self.extract(text, speaker=e.speaker_id, turn_id=e.turn_id)):
                ev = self.log.append(c, idempotency_key=_idem(e.turn_id, c))  # at-least-once+幂等
                self.ws.project(ev)                         # 更新投影
```

## F.7 证据级与待办
- 事件名/字段/回调签名:**E3**(三引擎官方核对)。
- 端到端运行:**E0**(未实测)→ 待办:装 SDK + 三 Tier 各跑冒烟(参照 LiveKit 官方 examples 仓库,E3),用 Voice-Eval(附录 E)验收。
- `extractor` / `event_log` / `working_set` / `_is_backchannel` / `_dedupe` / `_idem` 为 V2.0 + V2.3.2 已定义的内核接口,此处为消费侧骨架。

---

*下一步可输出:① Voice-Eval 的标注工具与回放管线脚本;② 三 Tier 适配器的冒烟测试用例(对每个契约事件断言);③ 中文低延迟 TTS 的 TTFA 实测脚本与候选对比(火山/MiniMax/Qwen-TTS);④ Tier B 豆包 Seeduplex 经 volcengine 插件的端到端接入示例。*
