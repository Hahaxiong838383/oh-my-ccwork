# 音乐播放 × 全双工语音助手 · 共存架构设计

> 2026-07-04 起草。背景：MyJavis（火山 RTC）+ realtime-voice-agent（LiveKit）都接入了 music-orchestrator，但"边放音乐边跟助手对话"会互相打架。本文是这个共存问题的设计单一真源。
>
> 版本：**v2** = team 圆桌两轮共识（第一轮通用架构 + 第二轮 voice-agent 网页端深挖）+ cc 综合裁决 + 川哥拍板的唤醒词。

## 0. 问题陈述（三层，纠缠在一起）

1. **[已确认真因] MyJavis 当前零声音 = `<audio>` 鉴权 401**：浏览器 `<audio src=url>` 在 Web 标准上无法带自定义 header，但 stream 端点要求 `X-Music-Key` header → 裸请求 401 被拒。实测：无 header→401，有 header→200。voice-agent 不受影响（服务端 httpx 带 header 取流）。**这是"没播放"的最末端硬 bug，与共存设计无关，但必须先修才谈得上后面。**
2. **回声/串扰**：MyJavis 音乐走独立 `<audio>`，火山 AEC 参考信号只有 RTC 下行 TTS，覆盖不到音乐 → 音乐从扬声器出来被麦克风采到 → 火山 ASR 把歌词当用户话 → LLM 对歌词乱应答 → TTS 盖在音乐上。voice-agent 因音乐走 LiveKit track、被客户端 WebRTC echoCancellation 覆盖，回声天然好，但语义层误触发仍在。
3. **交互 + UI 缺失**：没有"播放中如何跟助手对话又不互相打断"的机制；App/网页端都没有音乐播放状态的可视反馈。

## 1. 两个产品的栈差异（关键，决定了不能一刀切）

| 维度 | MyJavis | realtime-voice-agent |
|---|---|---|
| 语音框架 | 火山引擎 RTC（云端 ASR/VAD/TTS/AEC） | LiveKit + 自建 cascade |
| 客户端 | macOS Tauri 桌面壳（WKWebView） | 浏览器网页（`web/voice-test.html`，现为 234 行测试页） |
| STT 位置 | 火山云端（远程 AIGC 任务） | **服务端 agent 进程**（本地可控） |
| 音乐播放 | 独立 `<audio>` 元素（AEC 盖不到） | 服务端发布房间 track（客户端 AEC 覆盖） |
| ASR 门控手段 | 火山 UpdateVoiceChat/StopVoiceChat 或客户端 mute 上行（待验证） | agent 直接控制自己的 STT 管线（简单） |
| **KWS 位置（v2 裁决）** | **客户端**（WKWebView 原生/WASM）→ 可 mute 火山上行 | **服务端 agent**（已有 mic 流 + sherpa Python）→ mic 保持上行、STT gate |
| 回声现状 | 差（音乐旁路，AEC 不覆盖） | 好（音乐进 WebRTC 渲染路径，AEC 覆盖） |
| 后台常驻唤醒 | 桌面壳可（原生进程） | **网页端做不到**（tab 后台/息屏冻结），不承诺 |

## 2. Team 第一轮共识（grok-4.3 + codex gpt-5.5 独立收敛，高置信度）

**核心主张（两家一致）**：音乐播放中默认关闭助手 ASR，只留唤醒词 KWS；喊唤醒词才进入一轮对话，期间音乐 duck 或暂停，对话完恢复。即**智能音箱模型**。

- **交互模型 = 唤醒词门控**（非"一直听+ducking"——后者在有音乐+歌词+噪声时误触发率最高）。PTT 做兜底，不做主交互。
- **回声根治 = 绕开 AEC**：播放中冻结 ASR、麦克风只给 KWS，直接切断"歌词→ASR→LLM→TTS"灾难链。火山能否把外部音源纳入 AEC 参考 = **待验证，不编 API**。
- **两产品统一交互层、不统一音频栈**。都不建议为这事把 MyJavis 迁 LiveKit（换栈引入 STT/TTS/延迟/运维/客户端重做一堆新变量）。
- **codex 独有尖锐点（cc 认同）**：① 唤醒词太短易撞歌词→用更长短语；② TTS 自己会触发 KWS→助手说话期间暂停 KWS；③ 不能让 LLM 控制底层音频状态→由确定性状态机管（呼应 cc 记忆 `feedback_detector_mutual_exclusion_matrix`）；④ 音乐状态 × 助手状态两个正交维度，用一个 coordinator 统一决策。

## 3. Team 第二轮 · voice-agent 网页端深挖（含 cc 裁决）

**分歧点：KWS 跑哪里？** grok 主张浏览器 WASM，codex 主张服务端 agent。

**cc 裁决 = 服务端 agent（codex 对）**，理由：
1. voice-agent 现架构已是"浏览器只发 mic、服务端 agent 做一切"，STT 本就在服务端，加服务端 KWS 是**最小 delta**；sherpa-onnx Python 现成，不趟浏览器 WASM。
2. **grok 的论据自拆台**：它主张 WASM 的核心卖点是"本地常驻监听"，但同段又承认 tab 后台/息屏必须暂停 KWS——浏览器 WASM 根本给不了可靠常驻，那多趟一层 WASM 集成不值。
3. `WakeWordDetector` 做成接口，服务端实现不写死进状态机；将来要隐私增强/离线/移动端常驻再补客户端 WASM/原生，不用重设计。
4. ⚠️ **保留的对抗点（grok 有理的地方）**：服务端 KWS 吃的是经 WebRTC AEC/NS/AGC 处理后的音频，对 KWS 模型不一定最优 → 列为**头号实测项**，若唤醒率差再考虑客户端 raw 音频 KWS。

**ASR 门控（codex 升级，采纳）**：播放且未唤醒时 **mic 音频只喂 KWS，不喂 STT**（不是 STT 照跑再丢结果——那样白耗火山额度 + 隐私/日志/状态污染）。音频用 **fanout** 分发：
```
LiveKit mic track → AudioFrame fanout
                      ├─ KWS pipeline（ASLEEP 常开，TTS 时暂停）
                      └─ STT pipeline（仅 WAKE_DETECTED/LISTENING 才接入）
```
KWS 慢不能拖 STT，STT 关不能影响 KWS。⚠️ **唤醒后命令截断**（"hi 贾维斯 下一首"的"下一首"开头可能丢）→ 留 0.5-1.5s 环形音频缓冲，命中后把命中点后段补给 STT。sherpa KWS 能否给稳定边界 = 待验证。

**网页端最小 UI（采纳 codex）**：从测试页升级成"常驻控制台"——显式`开始`钮（用户手势解锁 mic/connect/autoplay）+ 顶部状态条（未连接/监听唤醒词/已唤醒正在听/助手回复中/音乐播放中/音乐已降音量）+ 音乐区（播放暂停/音量/duck 状态，即便音乐服务端发布也要给客户端可见反馈）+ 对话区（区分用户 ASR/助手文本/系统状态）+ 异常恢复钮（mic 拒绝/断线/autoplay 拦截）+ 停止监听钮。**明确不承诺 tab 后台/息屏常驻唤醒**（那是原生/PWA 的活，网页把"页面打开且连接中"作为监听前提）。

## 4. 统一抽象（codex 接口版，采纳）

统一"交互状态机语义 + 事件契约 + 策略规则 + 测试用例"，**不**统一音频采集/KWS runtime/模型加载/页面生命周期代码。

**共享状态机**：`ASLEEP`（音乐播放，KWS 开 STT 关）→ `WAKE_DETECTED`（命中，音乐 duck/pause，STT 开）→ `LISTENING`（收语音，KWS 可关防重复唤醒）→ `ASSISTANT_SPEAKING`（TTS 输出，KWS 关防自触发）→ `RECOVERING`（TTS 结束，恢复音乐音量，重开 KWS）。

**共享事件契约**：`wake_detected` / `user_speech_start` / `user_speech_final` / `assistant_tts_start` / `assistant_tts_end` / `music_started` / `music_duck` / `music_restore`。

**各产品分别实现的接口**（共享语义、不共享音频代码）：
```
WakeWordDetector   → emits wake_detected      （MyJavis=客户端 / voice-agent=服务端）
SpeechInputGate    → enable_stt() / disable_stt()
MusicController    → duck() / pause() / restore()
AssistantTurnController → start_listening() / stop_listening() / start_tts() / stop_tts()
```

## 5. 唤醒词（川哥 2026-07-04 拍板）

三条并存，任一命中即唤醒：**「hi 贾维斯」「你好 贾维斯」「贾维斯 贾维斯」**。均较长、含"贾维斯"核心、歌词/日常几乎不出现。

sherpa-onnx keywords.txt 用**声韵母带声调**格式（参照 P003 `feedback_sherpa_onnx_android_kws_offline_wakeword` 的 `x iǎo k ě ... @小可小可`），三条 keyword 并列。⚠️ "贾维斯/hi/你好"的准确音素拆分**实施时对着官方模型 tokens.txt 现推现验**（每个 token 须在 tokens.txt 存在，`grep` 验），**不手搓**——这是小可踩过的幻觉坑。

## 6. 落地顺序（务实版，个人自用）

| 阶段 | 做什么 | 目标 |
|---|---|---|
| **0 止血** | 修 401（服务端播放时签短时 HMAC token 放进 stream_url，`<audio>` 用它）+ 验证 WKWebView 真能播这个流格式 | **先让 MyJavis App 真的出声** |
| **1 不打架（服务端门控）** | 大脑侧唤醒词门控：播放中转录文本不含唤醒词就不响应 + duck-on-wake。几乎纯服务端，先止住"歌词乱触发" | 能听歌 + 助手不被歌词乱触发 |
| **2 状态机 + UI** | coordinator 统一音乐×助手状态（§4）+ 网页端控制台 UI + MyJavis 播放状态 UI + 追问窗口 + cooldown | 体验成型 |
| **3 真 KWS** | sherpa-onnx：MyJavis 客户端（可 mute 火山上行）/ voice-agent 服务端 agent（fanout + 环形缓冲）。三唤醒词落地 | 省 ASR 额度、离线唤醒、体验对齐音箱 |
| **4 验火山 AEC** | 查证火山能否覆盖外部音源，能则迁音乐进 RTC 渲染路径；不能则维持 KWS 门控 | 终极方案或证伪 |

## 7. 待验证 / 实测清单（codex 给，采纳）

- **头号**：服务端 KWS 吃 WebRTC AEC/NS/AGC 后音频，三唤醒词命中率（外放正常音量）。
- 外放大音量下误唤醒率 + 漏唤醒率。
- TTS 里含"贾维斯"是否自触发（验"TTS 期间暂停 KWS"）。
- LiveKit mic 发布是否确启 `echoCancellation/noiseSuppression/autoGainControl`（按 SDK 实测，别假设默认）。
- tab 后台 10min 后 LiveKit mic track 是否仍上行 / 断线重连后 KWS 是否恢复。
- 火山：能否运行时切 ASR 开关 / mute 上行（UpdateVoiceChat/StopVoiceChat 运行时能力待验证）。
- MyJavis：火山 RTC 占麦 + 客户端本地 KWS 能否并存于同一 WKWebView（待验证）。
- WKWebView 对 fragmented-mp4(m4a) 流式 `<audio>` + 无 Range 首播的支持（阶段 0 一并验）。

## 附：team 两轮原文
第一轮 grok/codex、第二轮 grok/codex 的完整 finding 已提炼入 §2/§3/§4/§7；原始文件在 `/tmp/r-grok.md`、`/tmp/r-gpt.md`（会被后续 team 复用覆盖）。
