# P003 读写台 × 自研语音线（Rust worker）对接文档

> 回应 `ANDROID_VAD_CLAUDE_HANDOFF.md`（2026-08-14，状态 `WAITING_CLAUDE_CONTRACT`）。
> 本文档解锁该状态：给出**能立即冻结的合同**、**必须先答的 5 个问题**、**对安卓端的 7 条要求**。
> 标注约定：**【已验证】**=本方代码/日志/线上实读确认 / **【设计】**=待实现 / **【待确认】**=需安卓端回答。
> 相关：`RUST-LINE-DEVICE-ONBOARDING.md`（设备接入手册）、`RUST-LINE-INTEGRATION-PLAN-v2.md`（三端方案）、
> `RUST-LINE-TELEMETRY-PLAN.md`（埋点数据模型）。
>
> 日期：2026-08-14 · 撰写：cc（Claude）

---

## 0. 先拆一个致命歧义：两个「Rust Runtime」

交接文档写「由 Director/Arbiter 放行后调用 **Rust Runtime**」——那是**设备上的 `RuntimeCoreService`**。

本文档里的 **`voice-rust-worker`** 是**云端**的语音 worker（LiveKit agent，跑在服务器上），
和设备侧那个 Rust Runtime **完全是两个东西**。

**约定：本文档及后续沟通中，云端一律称 `voice-rust-worker` 或「云端 worker」，
设备侧一律称 `RuntimeCoreService`。不要出现无限定的「Rust Runtime」。**

---

## 1. 接入点：换 `AiVoiceRuntime`，上下游不动

`AiVoiceRuntimeRegistry` 是可插拔的，因此新引擎实现一个 `AiVoiceRuntime`：

```
VAD 芯片 UART → McuUartService → VadVoiceFrameCodec → VadVoiceControlProcessor
                                                              ↓
                                              【新】LiveKitVoiceRuntime
                                              ├─ 上游:继续吃 Processor 事件(唤醒/命令词/VAD 起止)
                                              ├─ 中间:LiveKit SDK ⇄ 云端 voice-rust-worker
                                              └─ 下游:继续吐 voice.* 事件给 GodotBridge
                                                              ↓
                                                   Director L0/L1/L2 → Godot 只演
```

与交接文档「新语音引擎应接在 Launcher/MyJavis Adapter 边界，并继续向 Godot 输出兼容事件」一致。
**Godot 侧零改动是目标**（能否达成取决于 §6 的事件供给缺口）。

### 连接参数【已验证】

| 项 | 值 |
|---|---|
| LiveKit 信令 | `wss://voice-hk.hahaxiong.cc` |
| agent 派单 | token 内 `roomConfig.agents[].agentName = rust-worker`（显式派单，不走自动派单） |
| token 签发 | 由**我方后端**签，`identity = dev-<SN>`，房间名 `sn-<SN>-<时间戳>` |
| 上行音频 | 16 kHz / 16 bit / 单声道 PCM |
| 下行音频 | 24 kHz，**作为 RTC 音频轨发布**（不是下发 PCM 到侧通道） |
| 字幕通道 | legacy Transcription（`publish_transcription` 数据包） |
| 房间回收 | `empty_timeout=20s` + 主动 `DeleteRoom` |
| 并发上限 | `WORKER_MAX_JOBS=6`（CPU 为瓶颈，~0.3 核/路） |

---

## 2. 🔴 必须先答的 5 个问题

**这 5 个问题不答，合同 1/4/5/6 无法冻结**（音频格式、TTS 播放、打断、会话）。
其中 Q1–Q4 是同一件事的四个面：**音频通路**。

### Q1. VAD 芯片是只发事件，还是也传音频？

交接文档给的命令表里 `0x0101` payload 是 semantic label、`0x0106/0x0108` 是 VAD 起止，
**没有一条是音频帧**。那对话音频从哪来？

- **若安卓自己持麦** → §5 的息屏保活要求全部生效。
- **若芯片走 UART 送 PCM** → 请给出帧格式、采样率、时间戳定义。
  并注意带宽：16 k×16 bit 单声道 = 256 kbps ≈ 32 KB/s，921600 baud 约 92 KB/s，够但不宽裕。

### Q2. 播放 TTS 期间，上行麦克风还开着吗？

**这条直接决定「打断」能不能做。** 云端 worker 是全双工设计，打断靠持续听。
若设备只在芯片 VAD START→END 之间开麦，worker 永远听不到用户插话，
交接文档联调矩阵里的「连续打断三次」**根本不成立**。

### Q3. 有没有硬件 AEC？实测过吗？

设备外放我们的 TTS，麦克风/VAD 芯片会听见自己的声音 → worker 误判成用户说话 → **自打断**。
800×480 一体机大概率外放，这个风险是实的。

⚠️ **不要指望云端**：我方的 AEC warmup 只是 **0.5 秒的打断抑制窗，不是回声消除**【已验证】。

### Q4. 芯片 VAD 的起止判定，能否只作为旁路信号、不门控音频流？

见 §5 红线 1。

### Q5. 恢复出厂设置后 SN 是否变化？

真机 SN `D160X65140100098`【交接文档提供】。Launcher 跑在 `android.uid.system`/UID 1000，
`Build.getSerial()` 的普通应用限制不适用——**读取方式的风险已解除**。

但**稳定性未知**：SN 若在恢复出厂后变化，整套埋点归因的地基就是松的。
若不稳定，改用「首次激活时后端下发的 device_id + SN 作属性」。

---

## 3. 🔴 对安卓端的 7 条要求（按延迟杠杆排序）

> 目标口径：**语音丝滑、低延时**。以下按对该目标的杠杆大小排，红线项不可协商。

### 🔴 红线 1：上行音频常开、全双工，绝不用芯片 VAD 门控

进房后麦克风轨**常开**；芯片 `0x0108`/`0x0106` START/END **只作为旁路信号走控制通道上报，
不用来开关音频流**。

**理由**：云端 worker 自带 VAD + 预测式判停，**判停 401ms**【已验证】是调出来的核心资产。
上行若被芯片 VAD 门控，这套完全失效，退化成「等设备告诉我用户说完了」——
而芯片的判停策略我方既控制不了也调不了。更严重的是打断彻底失效（见 Q2）。

### 🔴 红线 2：硬件 AEC 必须开，且要拿可验证的证据

红线 1 要求全双工常开，常开就必然吃到自己外放的回声。没有 AEC → 自打断 → 体验当场崩。

**验收物不是口头保证，是一段录音**：设备外放我方 TTS 时的**上行原始录音**，
我方据此看残余回声电平。这是可计算的判据。

### 🟡 3. 唤醒即建连，别等用户说完第一句

芯片 `0x0102` 唤醒 → **立刻**用预取 token 进房 → 让云端 prewarm 与用户开口并行。

**这是单条最大的延迟杠杆**：省掉整个进房 + 预热的 **1–1.5 秒**【已验证：LLM 预热 200–400ms + TTS 池 ~1s】，
且完全在端侧，不依赖云端任何改动。

配套：上一次会话结束时就预取下一张 token（房间名用未来时间戳），用掉立刻再取一张。

### 🟡 4. 上行帧长 20ms，不要攒包

帧长直接进判停延迟——端侧攒 100ms 一包，判停就晚 100ms。
LiveKit SDK 默认即 10–20ms，**不要自行加缓冲层**。

### 🟡 5. 本地「停/小可」双路执行

本地**立刻**停播；**同时**异步发 cancel 给云端，**不等云端确认**。
云端那条是为了停止合成、并防止恢复时从半句接上。

控制通道协议见 §5.1（我方待实现）。

### ⚪ 6. 音频格式 16 kHz / 16 bit / 单声道 PCM，只重采样一次

芯片出 8k 或 48k 都可接受，端侧转一道即可，**不要在安卓层再转第二道**。

### ⚪ 7. 提供两个实测数

- 设备 → `voice-hk.hahaxiong.cc` 的 **RTT**
- **UART 唤醒帧 → `AiVoiceRuntime` 收到**的链路耗时

这两段云端看不见，但会进总延迟账本。

### 附：息屏保活（取决于 Q1 的答案）

- **若芯片持麦** → 只需保证 `McuUartService` 存活能收 UART。**这比原设想简单得多。**
- **若安卓持麦** → 以下全部必需（请按 targetSdk 35 核实）：

| 项 | 作用 | 不做的后果 |
|---|---|---|
| 前台服务 + `foregroundServiceType="microphone"` | Android 10+ 后台采麦前提 | 麦克风静默 |
| `FOREGROUND_SERVICE_MICROPHONE` 权限（Android 14+） | 同上 | 服务起不来 |
| `PARTIAL_WAKE_LOCK` | Doze 下保住 CPU | 音频卡顿/断流 |
| 电池优化白名单 | Doze 掐网络 | RTC 断流 |
| WiFi 高性能模式 | 保住上行 | 上行断 |

**失败长什么样**：云端日志出现 `audio in (10s) frames=0` ——
房间连着、信令正常、一切看着都对，就是没有声音上来。对上这个症状直接查端侧息屏策略。

**深度休眠**：进休眠前**主动 `room.disconnect()`**，别靠超时断（超时会留房间残留窗口）。

---

## 4. 9 条合同：4 条现在冻结

### ✅ 合同 2 · warmup【已验证】

进房后约 **1–1.5 秒就绪**（LLM 预热 200–400ms、TTS 池约 1s）。连接可复用范围：单 job 内。
失败退避：预热失败只 warning，首句现场建连，不影响可用性。

⚠️ **本条冻结前有一个我方待办**：当前 TTS 池 prewarm 与开场白并发，实测 prewarm 晚到 300–800ms，
开场白的「零建连」实际靠上一个 job 的遗留连接。对本设备的**息屏唤醒场景正是最痛的路径**，
我方将把 prewarm 前置到开场白之前，届时本条数字会改善。

### ✅ 合同 3 · ASR partial/final【已验证】

| 侧 | 语义 |
|---|---|
| 用户 | interim = 同段 id + `final=false`；final = 同段 id + `final=true`，随后轮换新段 id |
| 段 id | 前缀 `SG_` |

重复片段处理：同段 id 内后发全文覆盖前发全文（不是增量拼接）。
`trace_id`：**待补**，依赖 §5.1 入站通道（设备传入 → 云端在契约事件与字幕中回带）。

### ✅ 合同 7 · 鉴权【设计，接口已定】

```
POST /v1/device/session      ← {sn, app_ver, fw_ver}
                             → {session_id, room, token, livekit_url, expires_at}
                             → 403 设备未注册 / 429 并发已满（明确区分，不要都返 500）
POST /v1/device/session/prefetch    # 预取下一张
```

- token 由后端签，`identity=dev-<SN>`；**SN 写在签名 token 里，设备自报不作数**（防埋点污染）
- 设备鉴权用设备密钥/证书。**SN 本身不是凭据**
- token **禁止日志、禁止落盘**（与交接文档要求一致）
- 并发满时必须返回**明确的 429**，端侧给用户可理解提示，不得静默失败

### ✅ 合同 9 · 工具调用【配置级，零代码】

云端 worker 侧**关闭工具执行**，L2 只 `say` / `propose_tool`，工具由 Director/Arbiter 放行后
在**设备侧** `RuntimeCoreService` 执行。

机制现成：租户线已有「工具端点置空」的先例，环境变量级别，不需改代码。

### ⏸ 合同 1 / 5 / 6 · 上行音频格式 / 打断 / 会话

**卡在 §2 的 Q1–Q4。** 拿到答案后 24h 内出冻结版。

### ⏸ 合同 4 · TTS 由谁播

**我方是既定的**：worker 把 TTS **作为 RTC 音频轨发布**，不下发 PCM【已验证】。
首包 ~334ms【已验证】。

**待确认**：`AndroidVadVoiceReplyPlayer` 能否直接吃 RTC 轨？若只能吃裸 PCM，需要端侧做一层。
「播放完成」事件当前由云端 agent 字幕的 final 表达（见 §6）。

### ⏸ 合同 8 · 离线兜底

L0 本地音频、预合成合盖句**全在端侧**，云端不介入。
云端只需定义「云不可用」的状态码——**待端侧给出期望的状态码取值集合**，我方对齐实现。

---

## 5. 我方待补：入站控制通道（S1 必做）

### 5.1 现状【已验证】

云端 worker 订阅的 `RoomEvent` 共 7 个：
`ParticipantConnected` / `LocalTrackSubscribed` / `TrackSubscribed` / `TrackMuted` /
`TrackUnmuted` / `ParticipantDisconnected` / `Disconnected`。

**没有 `DataReceived`。** 代码中两处 `DataPacket` 全是 publish
（`pipeline.rs:418`、`pipeline.rs:837`），**只出不进**。

**结论：设备当前没有任何办法主动通知云端「停」。** 本地喊停，设备可以自己不放声音，
但云端会继续合成、继续计费，且恢复时会从半句接上。

唯一现成的 1 bit 通道是 **mute/unmute 麦克风轨**（worker 订阅了 `TrackMuted`/`TrackUnmuted`），
可作应急停止信号，但语义太窄，扛不住 cancel 幂等与 `trace_id` 关联。

### 5.2 要做的【设计】

worker 增加 `RoomEvent::DataReceived` 处理 + 最小控制协议：

```jsonc
{ "type": "cancel",     "trace_id": "...", "idem_key": "..." }   // 打断/停
{ "type": "wake",       "trace_id": "..." }                       // 唤醒会话开始
{ "type": "vad",        "state": "start|end", "ts": 0 }           // 芯片 VAD 旁路信号
{ "type": "text_input", "text": "...", "trace_id": "..." }        // 对应 voice.llm.text.send
```

**打断机制本身是现成的**（假打断状态机、`MIN_INTERRUPTION_WORDS`、`FALSE_INTERRUPTION_TIMEOUT`、
恢复渐起、字幕截断均已实现并在灰度线运行），本次只是**给它加一个新的触发入口**，改动量小。

⚠️ 交接文档联调矩阵里的「连续打断三次」与「停/小可本地优先级」两条，
**在此通道落地前跑不了**。此项不依赖 §2 任何答案，我方可立即并行开工。

---

## 6. Godot 10 个事件：云端能供给几个

### 现成可对上（3 个）【已验证】

| Godot 事件 | 云端来源 | 备注 |
|---|---|---|
| `voice.asr_text_changed` | 用户字幕 interim/final | 见合同 3 |
| `voice.llm_delta_changed` | agent 字幕，**按播出位置逐句发布** | interim=句进入播出，final=句播完或被打断截断 |
| `voice.state_changed` | 连接状态 + 契约事件（`AgentSpeechStarted` 等） | 需端侧做一层映射表 |

⚠️ **`llm_delta` 的粒度是「句」，不是 token delta。** 若 Godot 按 token delta 渲染，需知悉此差异。

✅ **一个对你们有利的性质**：**打断那一轮的 agent final 文本 = 截断后真实播出的部分**【已验证】，
正好满足联调矩阵「不重播半句」那条。

### 端侧自产、与云端无关（3 个）

`voice.wake_state_changed`（芯片 `0x0102`/`0x0109`）、`voice.monitoring_changed`、`voice.prompt_changed`。

### 🔴 云端当前**没有**的（4 个）——真实增量工作，不是配置能解决

| 事件 | 缺口性质 |
|---|---|
| `voice.server_command_received` | 无服务端下发命令机制 |
| `voice.session_summary_changed` | 无会话摘要能力 |
| `voice.statistics_changed` | worker 有内部 metrics，但无面向客户端的统计推送 |
| `voice.user_memory_changed` | **无用户记忆。这条最重——是产品能力，不是接口适配** |

**处置建议**：这 4 条不进 S1。要么端侧保留旧 MyJavis 通道并行供给，要么进 backlog 单独排期。

⚠️ **别默认「换个引擎这些就跟着来了」。**

---

## 7. 延迟账本（先对齐预期，免得联调时归错因）

| 段 | 实测 | 可压缩性 |
|---|---|---|
| 判停（预测式 + B5 伪 final） | **401ms**【已验证】 | 已调到位 |
| **LLM 首字** | **~800ms**【已验证】 | 🔴 **最大单项，且 99% 在模型本身** |
| TTS 首包 | **334ms**【已验证】 | 已调到位 |
| 进房 + 预热 | 1–1.5s【已验证】 | 靠端侧「唤醒即建连」可完全并行掉 |

首音合计约 **1.5 秒**（*此为上述分项的算术和，非端到端实测*），
云端靠 filler 与投机遮掉一部分感知延迟。

🔴 **关于 LLM 首字**：我方已把这段查穿——**我方网络 RTT 3.4ms、对方网关处理 5.1ms，
两段加起来不到 10ms，其余全在模型推理**。联调时若总延迟不满意，请先按本账本拆解，
不要整段归因到链路。真要再压只有换模型，那是另一个决策。

**本设备新增、云端看不见的段**：UART 链路耗时、设备→HK 的 RTT、端侧音频缓冲、唤醒重连。
→ 见 §3 要求 7。

---

## 8. 联调矩阵可行性预判

| 场景 | 预判 | 阻塞项 |
|---|---|---|
| VAD 唤醒（同 trace_id 贯穿，Godot 150ms 内 listening） | ⚠️ 部分 | 需 §5.1 通道传 trace_id |
| ASR partial/final | ✅ 可跑 | 无 |
| 打开宝箱（L1 不经 LLM） | ✅ 可跑 | 纯端侧，云端不介入 |
| **连续打断三次** | 🔴 **跑不了** | Q2（上行是否常开）+ §5.1 通道 + 红线 2（AEC） |
| 断网合盖（L0 本地音频） | ✅ 可跑 | 纯端侧；云端只需给「不可用」状态码（合同 8） |
| 在线闲聊（L2 只 say/propose_tool） | ✅ 可跑 | 合同 9，配置级 |

---

## 9. 关于 `mini_program_bound=false` 的处置建议

当前 `device_login` 返回 `200004/unbound`，卡在小程序绑定。**这是你们那套链路。**

**建议：联调不等绑定。** 自研线的 token 由我方后端签发（合同 7），身份靠 SN，
**不依赖 `device_login`**，S1 打通现在就能开始。

但话现在说清楚：绑定关系（SN → 哪个小程序账号/哪个孩子）**最终必须接上**，
否则 `user_memory` 与个性化没有落脚点。

**建议路径**：S1 用 SN 匿名会话跑通链路 → S2 把绑定接进来当身份源。
**身份的单一真源仍归你们的绑定系统，我方只签 LiveKit token，不建第二套身份。**

---

## 10. 下一步与分工

| # | 事项 | 归属 | 阻塞 |
|---|---|---|---|
| 1 | 回答 §2 的 Q1–Q5 | 安卓（codex） | — |
| 2 | 提供设备外放 TTS 时的上行录音（红线 2 验收物） | 安卓 | — |
| 3 | 提供 §3 要求 7 的两个实测数 | 安卓 | — |
| 4 | 实现入站控制通道 §5.1 | 云端（cc） | **无阻塞，即刻开工** |
| 5 | prewarm 前置（合同 2 的改善项） | 云端（cc） | 待川哥拍板（动 job 启动时序） |
| 6 | 冻结合同 1/4/5/6 | 云端（cc） | 依赖 #1 |
| 7 | 实现 `LiveKitVoiceRuntime` | 安卓 | 依赖 #6 |

---

*本文档为 2026-08-14 状态。标【已验证】者为本方代码/线上日志实读确认；*
*标【设计】者未实现；标【待确认】者需安卓端回答后方可定稿。*

*署名：cc（Claude）| 2026-08-14*
