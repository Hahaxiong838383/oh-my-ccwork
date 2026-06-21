# docs/30 · 小可 demo 宏观总纲 —— 交互 × 记忆 全景图

> **缘起**:川哥指出 docs/29 偏记忆,「实时语音交互的具体定义有没有涉及」。核查后属实:交互定义散在 docs/25/26/27/28,docs/29 只接了「合一枢纽」。
> **性质**:本文**不新增设计**,是把 docs/25-29 抽取串联成一张全景图 + 一份「实施现状 + 未定参数/缺口」总账。cc 整合,不外派。
> **数据源以代码/git 为准**(发现 docs/25 进度段滞后,见 §6)。日期:2026-06-20。

---

## 0. 一张图:小可 demo 全景架构

```
┌─────────────────────────────────────────────────────────────────────┐
│ 客户端:Android Compose 薄壳 + WebView                                │
│   React Voice FSM(fsmEpoch)  ── 6 态 ── SLEEPING/LISTENING/THINKING/  │
│                                          SPEAKING/AWAITING_FOLLOWUP/CLOSING│
│   voice-client(playbackGeneration) ── 音频播放/丢弃/barge-in           │
│   Native 壳 ── 唤醒词(Porcupine/sherpa) + 麦克风仲裁(JS Bridge) + AEC  │
└───────────────────────────────┬─────────────────────────────────────┘
            WS 消息带 envelope:{session_id, turn_id, response_id, playback_generation}
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Server:单进程 Node + node:sqlite + WebSocket                          │
│  pipeline(activeTurn 轮次守卫)                                         │
│  ├─ 交互链路:火山 ASR(definite 判停) → 云 LLM(流式) → 火山 TTS(流式)   │
│  │     延迟预算:ASR partial<200 / LLM首字<400 / TTS首音<300 / 总<800ms │
│  ├─ 记忆热路径(只读<50ms,严禁LLM抽取):profile-store + curriculum-kg   │
│  └─ 记忆冷路径(turn后异步):memory-extractor→双轴仲裁→commit gate      │
│           commit 前校验 turn_id==activeTurn,不匹配丢弃(=打断不脏写)   │
└───────────────────────────────┬─────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ SQLite:memory_events(append-only,真相+溯源+纠错链) ─同事务→ profile-store │
└─────────────────────────────────────────────────────────────────────┘

         ▲ 交互线(丝滑流畅)          ▲ 记忆线(记忆极好)
         └──── turn_id / envelope ────┘  合一枢纽:同一守卫治丝滑打断 + 记忆不脏写
```

---

## 1. 三块定位 + 对应文档

| 块 | 是什么 | 文档 | 状态 |
|---|---|---|---|
| **交互线** | 丝滑流畅:对话生命周期 + 判停 + 打断 + 退出 + 唤醒 + 延迟 | 产品=docs/26 / 工程优化=docs/25 / 架构=docs/27 / FSM=docs/28 | 产品定义完整;工程批1+2已落码,批3(FSM重构)设计定稿待实施 |
| **记忆线** | 记忆极好:CQRS-lite + 双轴仲裁 + 保守提交 | docs/29 | 设计定稿,未实施 |
| **合一枢纽** | turn envelope(turn_id 串联三层 version) | docs/29 §2 + docs/28 ③ | 设计定稿 |

---

## 2. 交互线全景(抽取 docs/25/26/27/28,以代码为准)

| 维度 | 定义在哪 | 状态 | 关键参数/缺口 |
|---|---|---|---|
| 对话生命周期(6 态状态机) | docs/26 产品 + docs/28 工程 FSM | 产品✅ / FSM 设计定稿待实施(批3) | 转移参数待 review |
| 一问一答 + 有界续问窗 | docs/26 | 产品✅ | **续问窗 6-8s 待真机调参** |
| 判停(火山语义 definite) | docs/25 块5 + volc-asr.ts | **代码已落**(server VAD 参数+definite日志) | ⚠️ **火山参数名/默认值/判停延迟待 `DEBUG_ASR=1` 真机实测**(两候选名都发了) |
| 打断 barge-in | docs/26 + docs/28 + voice-client | 有实现 | **端到端时序 / Native 优先拦截 / AEC 未系统定义** |
| 退出意图 L1/L2/L3 | docs/25 块3 + exit-intent.ts(前后端各一份) | **代码已落**(L1白名单106行/server228行) | 退出词全集待真机补;L2 intent / L3 idle 真机迭代 |
| 填充音语境化(3 桶) | docs/25 块4 + voice-client | **批1已部署** | 错配风险,需克制;首字快(<1.5s)不放(CUI'25铁律) |
| 唤醒词「小可小可」 | docs/26 + android-shell(Porcupine/sherpa) | 产品✅ / 原生工程 | **真机编译 + Porcupine key / sherpa 阈值待验**(童声<50%风险) |
| **延迟预算 / SLO** | docs/27 §1.3 | 🔴 **只提数值,从没真机量过/没做监控** | ASR<200/LLM首字<400/TTS首音<300/总<800ms(目标值,未验) |
| 人设边界 / 对话原则(Grice) | docs/26 §4 | 产品✅ | 待写入 system prompt |
| **弱网降级 / 容错** | 散 | 🔴 **几乎空白** | WS 断线/重连/弱网时序乱序(docs/29 风险提过)未定义 |

---

## 3. 记忆线全景(docs/29 摘要)

- **P0 五项**:① SQLite `memory_events` append-only 表 ② extractor 改「先 append event → 同事务重建 profile 投影」 ③ commit gate(definite final + turn_id==activeTurn 才写,被 tts.turn_discard 的轮次不写) ④ 双轴仲裁(authority × observation,修正 PRD「ASR 一概低优」) ⑤ correction 抢占 supersede + LLM 推断默认 pending(复现≥2 升 stable)。
- **关键修正**:assistant 文本默认禁写长期记忆 / curriculum-kg 当抽取护栏 / 冲突变「主动反问」体验亮点 / 伪纠错防护 / sqlite 别卡首 token。
- **不上**:Redis / Qdrant / 独立 EventStore / Graphiti / bitemporal 区间查询(全 P1/P2)。
- 详见 [docs/29](29-记忆×交互合一宏观架构-team四发定稿.md)。

---

## 4. 合一枢纽:turn envelope

`turn_id` 是交互轮次与记忆 provenance 的唯一纽带。三层 version 各管各、不合并:React `fsmEpoch`(UI) / 前端 `playbackGeneration`(音频代次,与轮次正交) / server `activeTurn`(回调守卫)。跨层消息带完整 envelope。**打断时 activeTurn++,冷路径 extractor 写库前校验不匹配即丢 → 同一守卫既治丝滑打断、又治记忆不脏写。** 详见 docs/29 §2 / docs/28 ③(已修正)。

---

## 5. 贯穿两条线的「实时性」非功能定义 —— 当前最薄的一块

> 「丝滑流畅」的真正决定因素在这里,但目前**散、未量化、未定稿**。这是 demo 体验的真实风险点。

| 项 | 现状 | 缺口 |
|---|---|---|
| **延迟 SLO** | docs/27 给了目标数值 | 🔴 从没真机量过端到端;没做成监控/告警;童声场景未校准 |
| **barge-in 端到端时序** | voice-client playbackGeneration + server activeTurn + Native 拦截 各自有 | 🔴 没有一条「孩子开口→静音→丢音频→切轮→新轮首音」的端到端时延定义与预算 |
| **AEC 回声抑制** | getUserMedia ducking + PTT 互斥 + Native 静音(散在 memory) | 🔴 防小可录到自己 TTS 的 AEC 没系统方案(WebView 限制下尤甚) |
| **弱网降级** | 无 | 🔴 WS 断线重连、消息乱序、TTS 卡顿时的降级策略空白 |

---

## 6. 实施现状汇总(以 git/代码为准)

| 批次 | 内容 | 真实状态 |
|---|---|---|
| 批1 | 记忆静态注入(WORLD_CORE+精选L2+锚点) + game_progress + 填充音语境化 | ✅ 已部署生产(commit 20e3147d3 + d3877f9c6) |
| 批2 | 退出意图 L1/L2/L3 + VAD 火山语义判停 + PWA 缓存根治 | ✅ **代码已落**(commit 36e4991a2 + 8928162db);⏳ **VAD/退出真机调参验证待完成** |
| 批3 | useMobileVoice 重构为 6 态 FSM + 有界续问窗 + turn envelope | 📐 设计定稿(docs/28,③已修),**未实施** |
| 记忆 P0 | memory_events + 双轴仲裁 + commit gate | 📐 设计定稿(docs/29),**未实施** |

> ⚠️ **文档滞后修正**:[docs/25](25-手机端v3优化-填充音语境化+VAD稳定+退出意图+记忆系统.md) 的「实施进度」段仍写「⏳ 批2 待实施」,实际批2 已落码(见上)。docs/25 进度段需回填(建议另起小任务,本总纲不擅改 docs/25)。

---

## 7. 未定参数 · 缺口总账(谁来拍 / 怎么定)

| 项 | 现状 | 谁定 | 优先级 |
|---|---|---|---|
| 火山 VAD 参数名/默认/判停延迟 | 代码两候选名都发了 | `DEBUG_ASR=1` 真机实测 | P0(VAD 生效前提) |
| 续问窗阈值 6-8s | 暂定 | 真机调参 | P0 |
| 退出词全集 | L1 白名单初版 | 川哥 + 真机儿童语料 | P1 |
| 延迟 SLO 端到端 | 目标值未验 | 真机量 + 建监控 | **真空白** |
| barge-in 端到端时序 | 散 | 工程定义 + 真机量 | **真空白** |
| AEC 回声抑制 | 散 | team/工程深化 | **真空白** |
| 弱网降级 | 无 | team/工程深化 | **真空白** |
| 主动注入频次上限 | 暂定 | 川哥 | P1 |
| 唤醒真机(童声命中率) | 未编译验 | 工程真机 | P1 |
| 记忆 P0 全部 | 设计定稿 | 实施 | P0 |

---

## 8. 看清全局后的下一步建议

- **记忆线**:深(docs/29 已定稿,可直接实施)。
- **交互线产品层**:深(docs/26 完整)。
- **交互线工程层**:批1+2 已落码,批3 待实施;**真正空白 = 第 5 节的「实时性」硬指标**(延迟 SLO / barge-in 端到端时序 / AEC / 弱网降级)——这是「丝滑流畅」的命门,目前没人系统定义过。

> **建议**:① 批3 FSM + 记忆 P0 合并一个迭代实施(共享 turn envelope);② 第 5 节的「实时性」硬指标若要补齐,值得一轮专项 team 深化(对标 Gemini Live / 豆包实时语音 / character.ai),产出 docs/31「实时语音交互工程定义定稿」。是否启动 ②,川哥定。
