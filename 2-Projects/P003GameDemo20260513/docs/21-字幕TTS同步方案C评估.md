# 21 · 小可字幕 ↔ TTS 语音同步「方案 C（rAF 进度驱动）」评估报告

> 状态：**评估完成，待川哥定路线**（本报告只评估，未动代码）
> 方法：cc 源码级读码形成判断 → team 四发对抗评审（grok-4.3 / codex gpt-5.5 / antigravity gemini-3.5；gemini-flash lane 404 失败）
> 日期：2026-06-19

---

## 0. 一句话结论

**推荐两阶段、呈现优先：先做「字幕呈现改造」（纯前端、0.5–1 天、零风险）治视觉跳动这个"不自然"主凶，大概率单独就能验收通过；不够再走 C2b 根治（火山原生字级时间戳 + 前端 rAF，需先验证外部事实）。明确不做纯前端 rAF 当根治、不做 C2a（server 自行打文本标记）。**

四家高度共识，分歧仅在"阶段1要不要同时叠加受限 rAF"。

---

## 1. 背景与现状（已验证）

字幕当前 = **固定 charMs=150ms/字 + 逐分句整句替换**：
- LLM 文本流 → 打字机 `parseSentences` 切分句（标点都切）
- 外部 `tts.segment_start` 事件驱动 `advanceSentence()` 切句，再固定 150ms/字打字
- 渲染是**整句替换语义**：每个分句完整替换上一个分句（`onText`→`setSubtitle`，单层 div）

已迭代 5 轮（动态校准否定→回退固定 charMs→3 项音频修复→切句对齐 server→首字立即），川哥验收后仍觉「滞后感、不自然」。

**音频侧关键事实（方案 C 的基础设施）**：`voice-client.decodeAndSchedule` 在 `src.start()` **之前** decode 完成 → 分句开播那一刻已知该段**真实音频时长 `effDur` + 开播时刻 `startAt`**（AudioContext 时钟）。boundary 段（sentence_break 触发的 flush）≈ 一个分句。

**server 侧关键事实**：server 把 LLM delta **碎片**（非分句对齐）喂 Doubao，Doubao **内部自己重新分段**发 event 351；server 转发的 `tts.sentence_break` **只带 turn、不带该段文本**。volc-tts 当前**完全没解析任何时间戳字段**。

**已知最脆点**：server sentence_break 段数 ≠ 前端 parseSentences 分句数（短句并段/长句拆段），是**常态**，现状靠 autoAdvance 兜底。

---

## 2. cc 预判的验证结果（team 对抗后）

| 假设 | 我的预判 | team 裁决 |
|---|---|---|
| H1 纯前端 rAF 比记忆乐观 | 成立（decode 先于 start 知 effDur） | **部分推翻**：decode 先于 start 只解决"时长未知"，**不解决"段↔分句文本绑定"**。三家一致。我低估了 H2。 |
| H2 真血点是段↔分句映射 | 成立 | **四家强确认**。错位时 rAF 会"用音频速度持续显示错的字"（字数缩放失控/暴闪/极慢），**比现状"整句跳一下"更糟**。 |
| H3 必须 server 分两层 | C2a 小改 / C2b 根治 | 确认。**C2a 被淘汰**（3家：server 强行序号绑定无法解决 Doubao 动态并段/拆段，改造不值）。C2b 因下方外部事实**可能成立**。 |
| H4 视觉跳动是真凶 | 成立 | **四家强确认，且都建议先做**。视听对 100–200ms 微小不同步有强容忍，但对"整行文本瞬变"极敏感（闪烁感/阅读中断）。 |

---

## 3. 火山时间戳能力核查结果（已查官方文档，2026-06-19 cc 调研 agent）

> gemini-3.5 原说法"`request.tts.enable_timestamp=true` 返 `time_start/time_end`"——核查后：**字段名对、层级错、且对我们的音色很可能不支持**。

**已验证（BytePlus 官方文档 + 开源 client 源码交叉确认）：**
- 参数**真名 = `enable_timestamp`**（bool，默认 false），**真实层级 = `req_params.audio_params.enable_timestamp`**（gemini 说的 `request.tts.xxx` 路径错）。
- 返回**字/词级 + 音素级**时间戳（"word and phoneme timestamps"），经 message type `FrontEndResultServer`(`0b1100`) + event `TTSSentenceStart(350)`/`TTSSentenceEnd(351)` 下发。
- 具体返回字段名（`words`/`start_time`…）与单位（ms？）**官方文档折叠未给完整示例，未逐字证实**——gemini 说的 `time_start/time_end` 不要直接采信。

**⚠️ 关键风险（决定 C2b 成不成立）：** 官方对该参数加硬限制（逐字）——
> "This parameter **only works on TTS1.0 and ICL1.0 voices**."

而本项目音色 `zh_female_tianmeixiaoyuan_moon_bigtts` 的 **`_bigtts` 后缀 = 豆包 TTS 2.0 音色**（本轮观察）。**推断**：按此限制，2.0 音色上设 `enable_timestamp=true` **很可能不返回时间戳**。

**证据张力（必须知道）：** 国内 volcengine.com 摘要有"V3 接口已支持字级时间戳"的表述，与 BytePlus"仅 1.0/ICL"矛盾（国内/国际版文档可能不同步）。文档层面无法判定哪个对生产为准。

**→ 唯一可靠 Gate（实施 C2b 前必做）：** 拿真实 token + `_bigtts` 音色，发一次带 `req_params.audio_params.enable_timestamp=true` 的双向流式请求，看是否收到 `FrontEndResultServer(0b1100)` 帧。**一次真机 E2E 定性，比任何文档准。**
- 若收到 → C2b 根治路成立。
- 若收不到 → C2b 在当前音色上不成立，要么换支持时间戳的音色（牺牲音色）、要么 server 自做分句给段级时间戳（精度降一档）。

来源：BytePlus 双向流式 `streaming_tts` / 单向 `unidirectional_tts_http` 文档、音色清单 `voicelist`、开源 client `Hypnus-Yuan/doubao-speech`。

---

## 4. 各路线裁决

| 路线 | team 共识 | 裁决 |
|---|---|---|
| ① 纯前端 rAF 当根治 | grok 4/10、gemini 极低、codex 7/10，**无人押注根治** | ❌ 不做。映射错位反噬，可能比现状差 |
| ② / C2b server 返字级时间戳 + 前端 rAF | 真根治路，依赖 §3 外部事实 | ✅ 阶段2候选（先过 §3 Gate） |
| C2a server 自行 track 文本打标记 | 3家：错位风险大、改造不值 | ❌ 淘汰 |
| ③ 混合 | codex 首选 | 实质 = 阶段1+阶段2 分期，采纳为分期而非"同时叠加受限 rAF" |
| ④ 改呈现（治 H4） | **四家一致首选第一步** | ✅ 阶段1，先做 |

---

## 5. 推荐路线（两阶段）

### 阶段 1 · 字幕呈现改造（先做｜纯前端｜0.5–1 天｜风险极低）
治"视觉跳动"主凶，**与时序正交，无论后续做不做 rAF 都是净收益**：
- 整句**累积显示**：已说完的分句保留（变灰/上移/淡化），不再整行瞬替；当前分句逐步显现/高亮。
- 保留最近 N 字 / 2 行滚动，老内容淡出。
- 时序仍用现有固定 charMs（呈现改造能掩盖小幅时序误差）。
- **预期**：大概率单独让川哥验收通过——"不自然"主要来自整行突变而非毫秒级时序漂移。

### 阶段 2 · C2b 根治（阶段1不够才做｜需先过 §3 Gate｜2–4 天｜风险中）
1. **先过 §3 真机 Gate**：用真实 token + `_bigtts` 音色发一次带 `req_params.audio_params.enable_timestamp=true` 的双向流式请求，看是否收到 `FrontEndResultServer(0b1100)` 帧。**收不到则停**（换音色 or 段级时间戳降档，回头评）；
2. 收到则：server 开 `enable_timestamp` → 解析 FrontEndResult 字级时间戳 → 与 audio 一并下发；
3. 前端按 `AudioContext.currentTime` 到真实字偏移精准亮字（rAF 此时才名正言顺，有真字级时间轴，不靠线性插值猜）。

### 明确不做
- ① 纯前端 rAF 当根治（无可靠段↔文本绑定，错位反噬）。
- C2a（server 序号绑定，无法解决 Doubao 动态分段）。

---

## 6. 风险备忘（codex 提示）
阶段2 真正最大风险**不是 rAF 数学**，而是状态机复杂化后的边界：turn/generation 作废、bargeIn 取消播放、倍速 playbackRate、600ms timer 半句续段 flush、尾段结束、断线重连后 server turn 归零。任何新时间轴渲染都要覆盖这些既有边界（上轮已踩过多次）。

---

## 7. team 四家原文
`/tmp/r-grok.md`、`/tmp/r-gpt.md`、`/tmp/r-gem35.md`（gemini-flash lane 本轮 404，B3 antigravity gemini-3.5 补位成功）。

署名：cc（Claude）| 2026-06-19
