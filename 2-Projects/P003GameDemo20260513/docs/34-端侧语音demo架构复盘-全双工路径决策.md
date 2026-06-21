# docs/34 · 小可语音 demo 架构复盘 + 全双工路径决策

> **缘起**:川哥 2026-06-21 指出当前端侧 ASR demo「整体不太理想」,并给出实时语音 AI Agent 系统级 spec(full-duplex / anytime barge-in / 全链路 streaming / 端到端 <1s),要求**跳出「沿用 kidshub web 栈」的思路**重新规划。
> **性质**:复盘当前 demo 的架构债 + 对照 spec + 列候选路径 + 决策史脉络。cc 整合,数据以**代码 / git 为准**(已验证标注)。
> **关联**:选型史 docs/31 / 端侧实施 docs/32 / 宏观总纲 docs/30。日期:2026-06-21。

---

## 0. 一句话结论

当前「小可自己说话 / 喊她打不断 / 两套声音」**不是一堆孤立 bug,是一笔架构债**:

> **录音在原生、放音在 web,两者不在同一个音频会话里 → 原生 AEC(回声消除)物理上够不到 WebView 的 STREAM_MUSIC 输出 → 小可自己的 TTS 被麦克风录回去(自激)→ 只能物理 gate 掉麦克风 → 一 gate 就没法「说话时听你打断」。**

spec 要的 full-duplex barge-in,在「放音在 web」这个地基上**做不出来**。而且——**这正是 docs/31 §9.4 gemini-flash 早就预警的「AEC 自循环致命坑」(on-device 独有),我们硬上 on-device 撞上了。**

---

## 1. 核实地基(已验证 · 2026-06-21)

| 环节 | 实际位置 | 证据 |
|---|---|---|
| 录音 / ASR / KWS | **原生** AudioEngine 单一 AudioRecord(VOICE_RECOGNITION) | `apps/android-shell/.../AudioEngine.kt` |
| 放音(TTS) | **web** Web Audio(WebView STREAM_MUSIC) | 后端 `apps/server/src/pipeline.ts:317` 把 mp3 base64 经 WS 推前端解码播放 |
| 后端 LLM | 流式(token delta) | `pipeline.ts` `llm.streamChat` + `llm.delta` |
| 后端 TTS | 句级流式 | `pipeline.ts` `tts.audio` chunk + `tts.sentence_break`(豆包句边界) |

**结论**:后端**已经是 streaming**(spec 第 4/6 层基本满足);病根集中在客户端**音频 I/O 分裂**(录音原生 / 放音 web)。

---

## 2. spec 定性:两种架构,不是改进是换地基

- 川哥 spec = **full-duplex 实时 agent**(GPT-4o voice / 豆包实时语音那一档):说话时同时听、anytime barge-in、全链路 streaming。
- 当前小可 = **web 半双工回合制薄壳**(kidshub 体验台改):唤醒 → 听 → 想 → 说,一轮一轮;打断靠「点按钮」兜底,语音打断因 AEC 自激被 gate 掉。

---

## 3. 病根诊断:AEC 物理断裂

```
当前(放音在 web)—— AEC 断裂:
  ┌─[原生 AudioRecord]──录音──►[原生 ASR/KWS]    原生 AEC 只能消除
  │      ▲                                        "原生录的 + 原生放的",
  │      │ 麦克风把小可的声音录回去(自激)         但放音不在原生层!
  └──────┴───◄──扬声器◄──放音──[WebView Web Audio]
              声音绕一圈回到麦克风,原生 AEC 够不到这条 STREAM_MUSIC 输出

全双工正解(放音也回原生)—— AEC 能工作:
  [原生 AudioRecord]──┐
                      ├─►同一音频会话 + AEC(3A)─►消除自声─►可 anytime barge-in
  [原生 AudioTrack ]──┘
```

只要放音不在原生音频会话里,AEC 就永远消不掉自声 → 自激不可避免 → 只能 gate 麦克风 → 牺牲语音 barge-in。**这是地基问题,不是参数调优能解决的。**

---

## 4. spec 6 层 × 小可现状对照

| Spec 层 | 小可现状 | 缺口 / 动作 |
|---|---|---|
| ① Voice I/O | 录音原生 ✓ · **放音在 web ✗** | **放音下沉原生**(全双工地基) |
| ② ASR + VAD | 端侧 Zipformer + endpoint ✓ · 童声 CER 风险 | 全双工时需 AEC |
| ③ Dialogue / Interrupt | 回合制 FSM · 退出词 ✓ · **真 barge-in ✗** | barge-in 控制器 |
| ④ LLM + Planner | LLM 流式 ✓ · 无 planner / tool | demo 不急 |
| ⑤ Tool 执行 | 无 | demo 不急 |
| ⑥ TTS streaming | 句级流式 ✓(豆包) · 放音在 web→打不断 | 随①下沉 |

**一眼看出**:①⑥「放音在 web」是总病根;③ 真 barge-in 是直接缺口;④⑤ 的 tool/planner 是 demo 不急的未来。延迟其实可控,真正卡体验的是「打不断」这个**交互断裂**,不是慢。

---

## 5. 候选路径

| 路径 | 做法 | 取舍 |
|---|---|---|
| **A** 维持 web 半双工 | 继续打补丁,回合制 + 点按钮打断 | demo 能交付,但自激阴魂不散,spec 体验永远摸不到 |
| **B** 端侧音频下沉原生 | TTS 放音收回原生 AudioTrack,与 AudioRecord 同会话 + AEC + barge-in 仲裁;web 退纯 UI | 后端零改、ASR 复用;⚠️**风险=Android 全双工 AEC 难**(硬件 AEC 机型不保证,生产要 WebRTC AEC3 兜底) |
| **C** 完全原生重写 6 层 | 按 spec 从头搭 | 最彻底但浪费——后端 streaming + 端侧 ASR 都是好资产 |
| **D** 回归云端火山 RTC + 语义判停 | 火山 RTC 智能体方案(StartVoiceChat):3A 回声消除 + VAD + **语义判停** + barge-in 全在 SDK/云端;ASR/TTS 走火山云 | **直接消除 B 的 Android AEC 风险**(复用 proven);代价=放弃 on-device 隐私/壁垒动机(demo 阶段非硬约束)+ 成本按量 + **需确认能否接自定义 LLM**(保留记忆系统 + 双层启蒙 prompt)<br>← **川哥 2026-06-21 提出,另见任务 2 评估** |

**cc 认知更新(诚实修正)**:我 6-21 第一轮推荐 B。读 docs/31 后修正——**B 虽技术可行,但仍在「on-device」这条 docs/31 四家一致反对的路上加码**(童声 + AEC 两道坎都没消);**D(回归云端 RTC)才契合四家共识「别硬上 on-device」+ routing-kernel「先复用再造」**,用火山 proven 全双工绕开 Android AEC 深坑。**最终 B/D 取决于任务 2 对火山 RTC 可行性的评估(尤其能否接自定义 LLM)。**

---

## 6. 决策史脉络(为什么走到今天)

```
云端基线(火山 ASR definite + 云 TTS,已实测有效)
   ↓ 川哥坚持 on-device(动机:隐私不出端 + 手机端壁垒)
on-device 选型(docs/31 四家一致反对,警告童声 CER 40-60% + AEC 自循环坑)
   ↓ 务实混合:本地 ASR + 云 TTS(端侧音色复刻过不去,TTS 退回云)
第二轮四发:定 Zipformer-zh 弃 SenseVoice
   ↓ 端侧实施(docs/32)+ 真机测
实测撞坑:童声识别 + AEC 自激「打不断」+ 自己说话(=四家 §9.4 早预警)
   ↓ 川哥 2026-06-21:回归全云端 + 火山 RTC 语义判停(候选 D)
```

**教训**:权威观点(四家一致反对 on-device)当时被当「待验证假设」搁置、川哥按壁垒动机坚持上 → 实测验证了四家的预警。on-device 的隐私/壁垒价值是真的,但**代价(童声 + AEC)在 demo 阶段过重**。

---

## 7. 待决 / 下一步

1. **B vs D 取舍** —— D 看起来更省更稳更快,但有 1 个阻断级未决:**火山 RTC 智能体方案能否接入自定义 LLM**(我们的双层启蒙 prompt + 记忆系统是核心资产,不能丢)。→ 任务 2 评估。
2. **隐私/壁垒动机是否放弃** —— 回云端 = 放弃 on-device 的隐私不出端 + 手机端壁垒。demo 阶段(docs/30 定位:纯测试 / 免儿童合规 / 不录音)非硬约束;但若产品长期要打「隐私壁垒」,需川哥拍板。
3. **建议**:任务 2 先 cc 查火山 RTC 官方文档确认「自定义 LLM 接入 + 计费 + 集成形态」三件事 → 若成立,team 三发对抗「B vs D + 火山 RTC 全双工可行性」→ 收敛后定稿 docs/35 开干。

---

> 署名:cc(Claude）| 2026-06-21
