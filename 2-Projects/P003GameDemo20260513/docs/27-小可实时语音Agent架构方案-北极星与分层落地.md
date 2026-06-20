# docs/27 · 小可实时语音 Agent 架构方案 —— 北极星 + 分层落地

> 川哥给了一份工程级 real-time voice agent 架构（三流并发系统 + 统一调度器 + Shared Attention Scheduler + 三层控制系统），要 cc 综合 [docs/26](26-小可产品定义方案-对话生命周期状态机.md) 产品定义判断给方案。
> 日期：2026-06-20。**cc 综合判断，架构定稿建议过 team 对抗。**

## 0. 一句话判断
川哥这份架构是 **Gemini Live / Grok 级端到端 voice agent 的北极星**（理想态，工程本质抓得准），但 P003 小可是**分链路**（火山 ASR/TTS + 云 LLM，非端到端单模型）+ WebView + 儿童 demo——**不能照搬**。正解：按川哥自己的三层框架（4.1 Reactive/Cognitive/Meta）**分阶段落地 + 按 P003 现实裁剪**。

## 1. 川哥架构的价值（该作为长期设计语言）
- **三流并发**（Audio / Reasoning / Action）+ **event-driven** + **versioned state** + **latency budget** —— 这是 voice agent 的工程本质，方向 100% 对，是设计语言底座。
- **三层控制系统（4.1）= 最好的落地路线图**：Reactive（FSM+interrupt）/ Cognitive（LLM streaming+uncertainty）/ Meta（attention scheduler）。本方案直接用它做 Phase 划分。
- "语音 AI Agent = 时间维度上的多流控制系统，难点是状态一致性+注意力调度+可中断流式推理"——这个本质判断对，记住它。

## 2. 三个 P003 现阶段落不了 / 过度工程的点（诚实）
| 川哥设计 | P003 现实障碍 | 证据等级 |
|---|---|---|
| **ASR Uncertainty Engine**（hypothesis + n-best alternatives + confidence → LOW/MED/HIGH 决策） | 火山大模型流式 ASR **给不给 confidence/alternatives 待验证**——现 `volc-asr.ts` 只解析 text + definite，没见 n-best。**不给则此引擎无米之炊**；即便给，儿童单用户等 definite 够，n-best 过度 | ⚠️ 待验证（DEBUG_ASR 真机看 payload） |
| **Shared Attention Scheduler**（attention budget 动态分配 speech/reasoning/tools/context） | 这是 Gemini Live **端到端多模态模型内置**能力（一个模型同时 attend 多源）。分链路系统（独立 ASR/LLM/TTS 服务）**没有统一"模型注意力"可调度**，只能退化成"事件优先级+turn-taking"。对单用户/单屏/儿童学习场景，多源 attention 竞争远超需求 | 【推断·高置信】 |
| **Speculative LLM execution**（partial transcript → early reasoning + rebase/fork） | 云 LLM gateway 每次完整 prompt，speculative 要多次请求+rebase/fork，**成本+复杂度 vs demo 收益不划算**；儿童停顿长，等 final 够 | 【推断·高置信】 |

## 3. 方案：三层分阶段落地（川哥 4.1 框架 + P003 裁剪）

### Phase 1（现在 = 批3）：Reactive Layer —— FSM + 事件 + versioned state
- **docs/26 的 5 态状态机 + 有界续问窗**（川哥已批）—— 解问题3 频繁开关麦 / 告别不干净 / 判停。
- **采纳川哥 3 个原则**（P003 该上）：
  - **event-driven 统一事件总线**（AudioFrame/ASRPartial/ASRFinal/LLMToken/InterruptSignal）：voice-client 已部分 emit，批3 统一成显式 FSM 事件。
  - **versioned state（川哥原则3，P003 强需）**：barge-in/退出/ASR 异步 final 确实污染状态（现 `capturedTurnMeta` 快照、`playbackGeneration`、`activeTurn` 都是零散补丁）→ 批3 用**统一 turn-version**系统防 rollback 污染，把零散补丁收编。
  - **barge-in**：SPEAKING 中保持检测（已半做），批3 统一进 FSM。
- **ROI 最高，P003 完全能落，一次解决当前所有交互痛点。**

### Phase 2（中期）：Cognitive Layer —— streaming control + 裁剪版 uncertainty
- LLM **abort**（已有 bargeIn）；resume/rebase/fork **不做**（gateway 不支持 + demo 不值）。
- **裁剪版 uncertainty**（不做 full n-best）：火山 **definite**（高置信句尾，批2 已铺路）+ 低置信兜底（partial 不稳 → 延长等待）。前置：DEBUG_ASR 验火山给不给 confidence。
- **latency budget 落成 SLO 监控**（川哥 1.3 该量化）：ASR partial 100-200ms / LLM 首字 200-400ms / TTS 首音 <300ms / 总感知 <800ms。超标告警。

### Phase 3（远期 / 愿景）：Meta Layer —— Attention Scheduler（退化版）
- 分链路做不了真 attention budget → **退化成"输出决策策略"**：speak / wait / yield（turn-taking）+ proactive inject（docs/26 决策4 场景化主动：默认被动，仅世界观锚点）+ interrupt 决策。
- 真 Shared Attention Scheduler 等**产品验证 + 可能换端到端模型**（未来若上 Gemini Live 类多模态模型）再引入。当前儿童单用户过度工程。

## 4. 取舍表（一眼看清照搬/裁剪/缓）
| 川哥架构要素 | P003 决策 | 阶段 | 理由 |
|---|---|---|---|
| 三层控制框架 | ✅ 照搬(北极星路线) | — | voice agent 工程本质 |
| event-driven 事件总线 | ✅ 采纳 | P1 | 已部分有,统一即可 |
| versioned state | ✅ 采纳(强需) | P1 | barge-in/退出污染状态的真解,收编零散补丁 |
| FSM + 有界续问窗 | ✅ =批3 | P1 | 已批,解当前痛点 |
| latency budget | ✅ 落 SLO 监控 | P2 | 该量化 |
| LLM abort | ✅ 已有 | P2 | bargeIn |
| ASR Uncertainty(n-best) | 🔶 裁剪版(只 definite+兜底) | P2 | 火山能力待验证+儿童过度 |
| Speculative LLM exec | ❌ 不做 | — | gateway 不支持+成本不值 |
| LLM rebase/fork | ❌ 不做 | — | gateway 不支持 |
| Shared Attention Scheduler | 🔶 退化版(输出决策策略) | P3 | 分链路做不了真 budget,儿童单用户过度 |

## 5. 关键待验证 + 下一步
- **待验证（no-guessing）**：火山大模型 ASR 给不给 confidence/alternatives（DEBUG_ASR 真机看 payload）→ 决定 Phase2 uncertainty 怎么做。attention scheduler 是否值得，等产品验证。
- **下一步 = 批3**：Phase 1 Reactive Layer（5 态 FSM + 有界续问窗 + versioned state + 事件统一）。川哥已批"有界续问窗"。
- Phase 2/3 渐进，按产品验证 + 火山能力 + 是否换端到端模型决定。

## 6. 一句话方案
> 川哥架构是北极星（Gemini Live 级理想态），P003 按它的三层框架**分阶段落地**：**现在批3 落 Reactive**（FSM + 续问窗 + versioned state + 事件统一，解当前痛点）→ **中期 Cognitive**（火山 definite 判停 + 裁剪 uncertainty + latency SLO）→ **远期 Meta**（attention 退化成输出决策策略）。**不照搬端到端假设**（n-best uncertainty / speculative execution / 真 attention budget），因为分链路 + 儿童 + demo 要么落不了要么过度工程。北极星指方向，分层落地保交付。
