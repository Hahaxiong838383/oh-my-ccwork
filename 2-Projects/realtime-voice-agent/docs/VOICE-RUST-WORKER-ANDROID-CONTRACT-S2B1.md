# VOICE_RUST_WORKER Android 接入合同 · S2-B1 切片

> 回应 `CLAUDE_VOICE_RUST_WORKER_ANDROID_CONTRACT_PROMPT.md`（2026-08-14）。
>
> **本文档只冻结 S2-B1 切片**（即你们自己推荐的首个最小真机切片），范围内每一条都标注到源码行号。
> 完整合同（21 事件全集、状态机、Snapshot、Arbiter 协议）随 S2-B2/B3 增量冻结——
> 那些能力**服务端当前不存在**，现在写成规格会让你们照着规格写出一个对端没有的客户端。
>
> 标注约定（沿用你们的四级）：
> **【源码确认】** 已在 worker 源码验证，附文件:行号 ·
> **【未实现】** 当前不存在 ·
> **【建议新增】** 我方计划实现，附排期 ·
> **【待双方确认】** 需产品或安卓端答复
>
> 日期：2026-08-14 · 撰写：cc（Claude）· 配套：`RUST-LINE-P003-ANDROID-INTERFACE.md`

---

## 0. 名词消歧（必读）

你们文档里「Director/Arbiter 放行后调用 **Rust Runtime**」指的是**设备上的 `RuntimeCoreService`**。

本文档的 **`voice-rust-worker`** 是**云端** LiveKit agent，跑在服务器上，与设备侧那个 Rust Runtime
**完全是两个东西**。

**约定**：云端一律称 `voice-rust-worker`，设备侧一律称 `RuntimeCoreService`，
不出现无限定的「Rust Runtime」。

---

## 1. 源码坐标

| 项 | 值 |
|---|---|
| 仓库 | `Hahaxiong838383/oh-my-ccwork` |
| 分支 | `feat/rust-worker` |
| Commit SHA | `8f6ece7a0017bfbc07d65f2f09a75c80649faf73` |
| 源码根 | `2-Projects/realtime-voice-agent/rust-worker/src/` |
| 部署 | 64.90.13.117 · unit `voice-worker-rust` · 二进制 `/root/rust-worker/voice-rust-worker` |
| 启动入口 | `main.rs` → `worker.rs`（LiveKit agent 注册）→ `job.rs`（每 job）→ `pipeline.rs`（cascade） |

**当前 Provider**【源码确认】：STT=火山 seedasr（`stt_volc.rs`）、TTS=火山（`tts_volc.rs`）、
VAD=Silero ONNX（`vad.rs`）、判停=EOT sidecar（`eot.rs`，Python UDS）、声纹=`speaker_id.rs`。

⚠️ **TTS 即将变更**，见 §6。

---

## 2. S2-B1 范围（= 你们提的最小切片）

```
连接 Worker → 发布麦克风 → 接收远端音轨 → VAD/场景事件旁路 → cancel → 关开关回滚旧 Runtime
```

**范围内**：连接鉴权、音频上下行、字幕、控制通道（cancel/vad/wake）、trace_id、旧 Runtime 互斥。
**范围外**（S2-B2 及以后）：Game Snapshot、propose_tool 结构化输出、Arbiter 协议、
session resume、完整 21 事件 envelope、会话状态机。

---

## 3. 连接与鉴权

### 3.1 参数【源码确认】

| 项 | 值 |
|---|---|
| LiveKit 信令 | `wss://voice-hk.hahaxiong.cc` |
| 派单机制 | token 内 `roomConfig.agents[].agentName = "rust-worker"`（**显式派单**） |
| Room 命名 | `sn-<SN>-<unix秒>`（S2-B1 联调期可用 `dev-<任意>-<unix秒>`） |
| participant identity | `dev-<SN>` ← **SN 的唯一数据源，埋点靠它归因** |
| Token 签发 | 我方后端，设备**不自己签** |
| 环境区分 | agentName 区分：生产 `rust-worker`；测试另起 agentName，**不共用房间** |

⚠️ **缺 `roomConfig` 这一段 = 设备能进房但永远等不到 AI，且无任何报错**——
这是本链路最难查的失败形态。签完必须核对 claims。

### 3.2 Token 接口【建议新增 · S2-B1 前交付】

```
POST /v1/device/session
  Headers: Authorization: Bearer <设备密钥>       # SN 本身不是凭据
  Request:  {"device_sn": "BJP003_EXAMPLE", "app_ver": "1.2.1", "fw_ver": "1.1.6"}
  Response: {"session_id": "session_example",
             "room": "sn-BJP003_EXAMPLE-1786728842",
             "token": "<redacted>",
             "livekit_url": "wss://voice-hk.hahaxiong.cc",
             "expires_at": 1786815242}
  错误码:  403 设备未注册 / 429 并发已满 / 401 设备密钥无效
          ——三者必须明确区分，不得都返 500
```

```
POST /v1/device/session/prefetch     # 同上结构，room 用未来时间戳
```

- **token 绑定 room + identity + TTL**，不可跨房复用
- TTL 建议 1h；**过期不刷新，直接重新换一张**（token 刷新会打断音频，禁止在通话中做）
- `session_id` **必须由后端生成并同时下发给设备**——端侧与服务端两套埋点靠它 join，
  没有共同主键两边数据永远拼不起来，这是最容易漏、补起来最贵的一环
- **token 禁止日志、禁止落盘**

### 3.3 重连与 session 恢复【源码确认：不支持】

`worker.rs:253` 声明 **`supports_resume: false`**。
`job.rs:153-157` job 结束即 `room.close()` + twirp `DeleteRoom`。

**没有跨会话的 session 恢复。** 重连 = 换新 token + 进新房 + 全新 job（新的开场白、空的对话历史）。
若需要跨会话记忆，属于 S2-B2 的 user_memory 范畴，当前【未实现】。

---

## 4. 会话生命周期：**唤醒即建连，不做常驻 warm 连接**

你们文档 §二.1 要求「连接保持 warm，不允许每次唤醒重新建立冷连接」——
**这一条与架构冲突，且实测证明不划算。已决策改为唤醒即建连。**

### 4.1 实测依据（2026-08-14，64.90 静默参与者挂机 5.5 分钟）

| 项 | 空闲挂机（连着不说话） | 对照：通话中 |
|---|---|---|
| CPU | **0.125 核**（单核 12.5%） | 0.3 核 |
| 内存边际 | +14.4 MB | 12–18 MB |
| 火山 ASR 连接 | **全程开着，持续上送静音** | 开着 |

CPU 四个干净区间 12.4/12.2/13.3/11.9%，断开后回落 0.56%（= 零 job 基线 0.58%），
证明该开销确属该 job。**静默不便宜——Silero VAD 对每一帧都跑推理，不管里面有没有声音。**

`WORKER_MAX_JOBS=6` 是硬上限。常驻方案会把这 6 个槽位从「并发对话数」降级成「设备总数」，
第 7 台设备**静默接不上**，且 6 条火山 ASR 连接 24×7 上送静音。

### 4.2 换来的收益是 0，因为端侧可以并行掉

服务端就绪耗时【源码确认+实测】：进房后 LLM 预热 200–400ms + TTS 池约 1s，**约 1–1.5 秒**。

**这 1–1.5 秒可以被端侧「唤醒即建连」完全并行掉**：
芯片 `0x0102` 唤醒帧一到 → 立刻用预取 token 进房 → 云端预热与用户开口并行进行。

### 4.3 端侧要求

1. **唤醒即建连**：不等用户说完第一句，不等 ASR
2. **token 预取**：上一次会话结束时预取下一张，用掉立刻再取
3. **深度休眠前主动 `room.disconnect()`**，别靠超时断（超时会留房间残留窗口）
4. **息屏保持会话**：取决于音频通路归属，见 §5.4

---

## 5. 全双工音频合同

### 5.1 上行【源码确认】

| 项 | 值 |
|---|---|
| 编码 | PCM16 |
| 采样率 | **16000 Hz** |
| 位深 | 16 bit |
| 声道 | 1（单声道） |
| 帧长 | **20 ms**（= 320 samples = 640 bytes） |
| 采集方式 | **交给 LiveKit SDK 的 audio device module**，不要自己操作 `AudioRecord` |
| 何时发送 | **进房后常开**，见 §5.3 |

⚠️ **不要自行攒包**。帧长直接进判停延迟——端侧攒 100ms 一包，判停就晚 100ms。
LiveKit SDK 默认 10–20ms，不要加缓冲层。

Worker 侧接收：直接消费 16k 单声道 PCM，**无重采样**。背压：内部 channel 容量 128 帧
（`pipeline.rs:209`），满则丢最旧——正常帧率下不会触发。

### 5.2 下行 TTS【源码确认】

**方式：LiveKit remote audio track。** 不是 DataChannel PCM，不是 HTTP。
Worker 作为 participant 发布一条音频轨，设备订阅并播放。

| 项 | 值 |
|---|---|
| 采样率 | **24000 Hz** PCM16 单声道 |
| 首包定义 | worker 收到 TTS 引擎第一个音频帧（日志 `say synthesized ttfb_ms=`） |
| 播放完成 | agent 字幕该句 `final=true`（见 §7） |
| 停止方式 | worker 侧停止推帧；**设备侧同时本地停播，不等确认** |
| 音量 / AudioFocus | **端侧自行处理**，云端不介入 |

**cancel 后未播数据如何清空**：worker 停止推帧后，设备侧 LiveKit 播放缓冲内可能仍有
数百 ms 音频。**端侧必须主动清空播放缓冲**，否则会听到"停"之后还响一下。

### 5.3 🔴 红线：上行常开，不用芯片 VAD 门控

**进房后麦克风轨常开**；芯片 `0x0108`/`0x0106`（VAD START/END）**只作为旁路信号
走控制通道上报，不用来开关音频流**。

理由（硬约束）：
1. 云端自带 VAD + 预测式判停，**判停 401ms**【实测】是调出来的核心资产。
   上行若被芯片 VAD 门控，这套完全失效，退化成「等设备告诉我用户说完了」，
   而芯片的判停策略我方既控制不了也调不了。
2. **打断彻底失效**：TTS 播放期间上行若关闭，worker 听不到用户插话，
   你们矩阵里「连续打断三次」根本不成立。

**MCU VAD 与 Worker VAD 冲突时：Worker VAD 优先**（它持有完整音频流）。
芯片 VAD 事件仅作旁路 metadata 记录，不改变 worker 的 turn 判定。

### 5.4 🔴 红线：硬件 AEC 必须开，且要拿可验证的证据

红线 5.3 要求全双工常开，常开就必然吃到自己外放的回声。
没有 AEC → worker 把自己的 TTS 当成用户说话 → **自打断** → 体验当场崩。

**责任划分【待双方确认】**：
- 若使用**官方 LiveKit Android SDK 的 audio device module** 播放下行音轨，
  WebRTC APM 自带 AEC，参考信号取自其播放路径 → **可用**。
- ⚠️ **但若你们用 `AndroidVadVoiceReplyPlayer` 自行播放**，
  WebRTC **拿不到参考信号，AEC 直接失效**。这是最容易踩且最难查的一条。
- ⚠️ **若 VAD 芯片有独立麦克风通路**，WebRTC 的 AEC 对它完全无效，
  芯片会在 TTS 播放时被自己的声音唤醒。**这条需要你们答复芯片麦克风与
  Android 麦克风是否同一路。**

**云端不做任何 AEC 或降噪**【源码确认】：worker 侧的 "AEC warmup" 只是
**0.5 秒的打断抑制窗**，不是回声消除，指望不上。服务端零降噪也是既有事实。

**验收物**：设备外放我方 TTS 时的**上行原始录音**一段，我方据此看残余回声电平。
不接受口头保证——这是可计算的判据。

### 5.5 息屏保活【待双方确认，取决于 §5.4 的答复】

- **若 VAD 芯片持麦** → 只需保证 `McuUartService` 存活能收 UART。比原设想简单得多。
- **若 Android 持麦** → 以下全部必需（按 targetSdk 35 核实）：
  前台服务 + `foregroundServiceType="microphone"` / `FOREGROUND_SERVICE_MICROPHONE`（14+）/
  `PARTIAL_WAKE_LOCK` / 电池优化白名单 / WiFi 高性能模式。

**失败长什么样**：云端日志 `audio in (10s) room=... frames=0` ——
房间连着、信令正常、一切看着都对，就是没有声音上来。对上这个症状直接查端侧息屏策略。

---

## 6. 🔴 TTS 音色变更：切讯飞超拟人「聆小璇」

**决策已定**（2026-08-14）：Rust 线 TTS 由火山切换为讯飞超拟人，与你们 P003 现有 demo 音色统一。
**STT 保持火山不变**——判停 401ms 靠的是火山 ASR 的 B5 伪 final 机制，讯飞没有，不能动。

### 6.1 实测对照（同批交替跑，各 12 次，2026-08-14）

| | 讯飞·聆小璇 | 火山·冷酷哥哥 | 差 |
|---|---|---|---|
| 首包中位 | **445 ms** | 424 ms | +21 ms |
| 首包均值 | 464 ms | 425 ms | +39 ms |
| 首包范围 | 421–651 ms | 373–468 ms | 讯飞抖动略大 |
| **采样率** | **24 kHz PCM16** | 24 kHz PCM16 | **相同，无需重采样** |

**结论：换音色对首包延迟影响 +21ms，可忽略。**

### 6.2 但有一条要写进你们的验收

**讯飞吐完整句的耗时是火山的 2–4 倍**，且随句长放大：

| 句型 | 字数 | 讯飞 | 火山 | 倍数 |
|---|---|---|---|---|
| 短句 | 6 | 1015 ms | 500 ms | 2.0× |
| 开场白 | 14 | 1673 ms | 735 ms | 2.3× |
| 中句 | 18 | 1960 ms | 742 ms | 2.6× |
| **长句** | **39** | **3918 ms** | **1054 ms** | **3.7×** |

两家产出音频量相当（长句 178800 vs 163389 采样），**不是多合成，是吐得慢**。

换算：长句 178800 采样 @24kHz = **7.45 秒音频**，讯飞 3.92 秒吐完 = **1.9 倍实时**；
火山 6.81 秒音频 1.05 秒吐完 = **6.5 倍实时**。

**1.9 倍仍快于播放速度，不会卡顿**——但裕度从 6.5 倍掉到 1.9 倍。
**网络抖动大时长句可能追不上。请在联调时监控播放缓冲有无 underrun，并作为验收项。**

### 6.3 音色参数

`vcn = x6_lingxiaoxuan_pro`（聆小璇 pro）· 24 kHz · PCM16 · 单声道 · 与你们 demo 同一音色。

### 6.4 会话模型【实测 + 官方文档双向确认；本节首版结论有误，以此版为准】

> 🔴 **更正**：本文档 8-14 首版写的「严格一句一会话，连接不可复用，不存在调高的余地」
> **是错的**。当时只试了 `payload.text.status=2` 一种用法，就下了协议层的能力否定结论，
> 判据作用域过宽。以下为复测 + 读官方文档后的准确表述。

**准确表述：一条 WS = 一次合成任务；但一次任务内可以流式喂入多段文本。**

| 实测项 | 结果 |
|---|---|
| 任务结束（收到 `audio.status==2`）后同连接再开新任务 | ❌ `26016 intput channel is closed` |
| **分段流式 `text.status` `0→2`** | ✅ **成功** |
| **分段流式 `0→1→2`** | ✅ **成功** |
| 段间隔 3 s / 8 s / 11 s | ✅ 成功 |
| 段间隔 15 s | ❌ `26005 No active up data within **14000 ms**` |
| 喂字速率 25 / 10 / 4 / **2 字每秒** | ✅ **全部成功** |

**硬约束只有一条：14 秒无上行数据。** 官方文档写的「10 秒超时」与
「前 20 字需 25 字/秒、之后 15 字/秒」**均非硬约束**——2 字/秒实测照样跑通。
`26016` 之所以出现，是因为 `status=2` 本身就是在告诉服务端「文本到此为止」，
输入通道随即关闭——**错误消息字面就是这个意思**。

**⚠️ 无取消/中止指令**（官方文档确认）：整句一次性发出后服务端一定吐完，
打断时 worker 只能丢弃已收音频，**停不了上游**。

**对当前实现的影响**：`tts_xfyun.rs` 当前是**每句一条 WS**（每句付约 267 ms 建连），
不做连接池、无 prewarm。改为「一个 turn 一条 WS + 分段流式喂入」是已规划的优化
（省掉第 2 句起的建连、且打断时能停发后续文本），**尚未实现，不影响本合同的接口面**。

### 6.5 首包实测修正：裸协议 260 ms，比 §6.1 的 445 ms 快

§6.1 的 445 ms 是通过 Python LiveKit 插件层（`ChunkedStream` + `AudioEmitter`）测的，
含框架开销。本次**裸协议直连**同长度短句实测 **260–266 ms**，框架税约 180 ms。

| 路径 | 首包 |
|---|---|
| 讯飞·裸协议 | **260 ms** |
| 讯飞·Python 框架 | 445 ms |
| 火山·Python 框架 | 424 ms |
| 火山·Rust 线生产日志 | 400–550 ms |

**Rust 侧直接实现裸协议，首包有望落在 260 ms 档——快于当前火山实现。**
此为推断，`tts_xfyun.rs` 完成后以 Rust 线自身 `ttfb_ms` 日志实测为准，届时更新本节。

§6.1 的对照结论（讯飞 vs 火山同框架 +21 ms）仍然成立，
但**不要把 445 ms 当作 Rust 线切换后的预期值**——那是悲观值。

### 6.6 排期

`tts_xfyun.rs` 实现中【建议新增】。切换前 Rust 线仍为火山男声
（`zh_male_lengkugege_emo_v2_mars_bigtts`）——**S2-B1 联调若在切换前开始，
听到的是男声，属预期，不是 bug。**

---

## 7. 字幕（ASR partial/final + agent 文本）

**通道**：LiveKit legacy Transcription（`publish_transcription` 数据包），
不是 `lk.transcription` text streams。数据包的 participant = 被转写方。

### 7.1 用户侧【源码确认 `transcript_pub.rs:8`】

| 语义 | 规则 |
|---|---|
| 段 id | 前缀 `SG_` |
| interim | 同段 id，`final=false`，**后发全文覆盖前发全文**（不是增量拼接） |
| final | 同段 id，`final=true`，随后轮换新段 id |

→ 映射到 `voice.asr_text_changed`。**final 只提交一次意图**——按段 id 去重。

### 7.2 Agent 侧【源码确认 `transcript_pub.rs:12-13`】

**按播出位置逐句发布**：interim = 句进入播出，final = 句播完 **或被打断截断**。
句 id 由 (turn, 句序) 稳定生成。

→ 映射到 `voice.llm_delta_changed`。

⚠️ **粒度是「句」，不是 token delta。** 若 Godot 按 token delta 渲染需知悉。

✅ **对你们有利的性质**：**打断那一轮的 agent final 文本 = 截断后真实播出的部分**。
这正好满足你们矩阵第 4 条「不重播半句」——**以此为准，不要用 LLM 原始输出。**

---

## 8. 控制通道：**当前不存在，S2-B1 必须新增**

### 8.1 现状【源码确认】

worker 订阅的 `RoomEvent` 共 7 个（`job.rs:72-120`）：
`ParticipantConnected` / `LocalTrackSubscribed` / `TrackSubscribed` / `TrackMuted` /
`TrackUnmuted` / `ParticipantDisconnected` / `Disconnected`。

**没有 `DataReceived`。** 代码中两处 `DataPacket` 全是 publish
（`pipeline.rs:418` topic=`state`、`pipeline.rs:837` topic=`metrics`），**只出不进**。

**结论：设备当前没有任何办法主动通知云端「停」。** 本地喊停，设备可自行不放声音，
但云端会继续合成、继续计费，且恢复时会从半句接上。

唯一现成的 1 bit 通道是 mute/unmute 麦克风轨（worker 订阅了 TrackMuted/TrackUnmuted），
可作应急停止信号，**但语义太窄，扛不住 cancel 幂等与 trace_id 关联，不作为方案**。

### 8.2 【建议新增】设备 → Worker（DataChannel，reliable + ordered）

Envelope 沿用你们提的形状，`src` 固定 `android`：

```jsonc
{
  "trace_id": "trace_example",     // string, 必填, 由设备生成, 见 §8.4
  "ts_ms": 0,                      // int64, 必填, 设备单调时钟毫秒
  "src": "android",                // 必填
  "type": "cancel",                // 必填, 见下表
  "lane": "L2",                    // 可选, L0|L1|L2
  "seq": 1,                        // int, 必填, 设备侧单调递增, 用于去重
  "payload": {}                    // 按 type 定义
}
```

| type | payload | 语义 |
|---|---|---|
| `cancel` | `{"reason": "local_stop\|user_barge\|scene_exit"}` | 停止本轮生成与播放 |
| `wake` | `{}` | 芯片唤醒，会话开始（旁路记录） |
| `vad` | `{"state": "start"\|"end"}` | 芯片 VAD 旁路信号，**不门控音频** |
| `command_word` | `{"label": "<semantic label>"}` | 芯片命令词（`0x0101`） |
| `text_input` | `{"text": "..."}` | 对应 `voice.llm.text.send`，绕过 ASR |

**传输**：reliable、ordered、单包 ≤ 15 KB。
**重复处理**：worker 按 `(trace_id, type, seq)` 去重，重复包静默丢弃。

### 8.3 【建议新增】Worker → 设备（DataChannel，topic 分流）

现有 topic **保持不变**，新增一个：

| topic | 现状 | 内容 |
|---|---|---|
| `state` | 【源码确认】已有 | `{"k":"speaking","speaking":true\|false}` |
| `metrics` | 【源码确认】已有 | 延迟指标 |
| `control` | 【建议新增】 | `cancel.ack` 等，envelope 同 §8.2，`src="worker"` |

```jsonc
// cancel.ack
{"trace_id":"trace_example","ts_ms":0,"src":"worker","type":"cancel.ack",
 "payload":{"cancelled":true,"stopped_at_char":12,"reason":"ok|already_done|unknown_trace"}}
```

### 8.4 trace_id 贯穿

- **创建方：设备**（唤醒时生成，一轮对话一个）
- 设备在 `wake` 事件中首次上报 → worker 记入当前 turn
- worker 在 `control` topic 的所有回包、以及日志中回带
- ⚠️ **字幕通道（legacy Transcription）无 trace_id 字段位**——
  端侧靠「同一时刻只有一个活跃 turn」关联，或用段 id 前缀关联。
  这是 legacy 通道的固有限制，**S2-B1 接受此限制**，S2-B2 若需强关联再换 text streams。

---

## 9. 打断与 cancel 时序

```
用户说「停」
 ├─[端侧, 0ms]   芯片命令词 0x0101 本地识别（零网络延迟）
 ├─[端侧, <150ms] 立即停止本地播放 + 清空播放缓冲   ← 不等 cancel.ack
 ├─[端侧]         同时发 {"type":"cancel","trace_id":X}
 ├─[云端]         停止 LLM 流 / 丢弃在途 TTS / 停止推帧
 ├─[云端]         该句 agent 字幕发 final=<截断后真实播出部分>
 ├─[云端]         回 {"type":"cancel.ack","trace_id":X}
 └─[端侧]         Godot 停在安全节点；下一轮可开始
```

**规则**：

| 项 | 约定 |
|---|---|
| 本地停播是否等 ack | **不等。** 本地先停，网络的事异步 |
| cancel 幂等 | 同 `trace_id` 重复 cancel → 返回 `cancelled:true, reason:"already_done"`，**不报错** |
| 已结束 trace 再 cancel | 返回 `cancelled:false, reason:"unknown_trace"` |
| worker 停止生成时限 | 【建议新增】目标 <100ms（本地状态机切换，无网络往返） |
| worker 停止推帧时限 | 【建议新增】目标 <100ms |
| 旧 trace 的迟到 ASR/TTS | worker 侧按 turn tag 丢弃；端侧亦应按 trace_id 过滤 |
| 连续三次打断 | 无特殊处理，每次独立 cancel；worker 有假打断状态机（0.7s 窗口内无新 turn 则续播） |
| turn ownership | **worker 持有权威**（它有完整音频流）；端侧不自行判定 turn 归属 |

### 9.1 ⚠️ 与你们「Director 做策略闸门」的冲突及解法

你们 §二.2 要求 TTS 期间默认只放行「停/小可」。但上行常开时 **worker 自己就会做打断判定，
Director 拦不住它没截获的东西**。

**解法（不需要新代码）**：
- worker 侧 `MIN_INTERRUPTION_WORDS` 调高 → 普通语句不触发打断（半双工产品策略）
- 本地「停/小可」走芯片命令词零延迟识别 → 发 cancel → worker 取消（快路径）
- **全双工产品开关 = 调低该参数**，一行 env

⚠️ **缺口**：worker 只有**词数**门控，没有**关键词白名单**门控。
若产品语义必须是「只有'停'和'小可'能打断，其他一律不行」，
靠端侧命令词 + cancel 实现即可（更快），**不需要云端做**。

---

## 10. 延迟账本（🔴 含一处更正）

| 段 | 实测 | 可压缩性 |
|---|---|---|
| 判停（预测式 + B5 伪 final） | **401 ms** | 已调到位 |
| **LLM 首字** | **~800 ms** | 🔴 **最大单项，99% 在模型本身** |
| **TTS 首包** | **~450 ms**（400–550） | 见下方更正 |
| 进房 + 预热 | 1–1.5 s | 端侧「唤醒即建连」可完全并行掉 |

**首音合计约 1.65 秒**（*分项算术和，非端到端实测*），云端靠 filler 与投机遮掉部分感知延迟。

### 🔴 更正：TTS 首包不是 334 ms

前一版文档（`RUST-LINE-P003-ANDROID-INTERFACE.md` §7）写的 **334 ms 是错的**。
今日两路交叉推翻：

- 同批 Python 火山对照：**424 ms** 中位
- **Rust 线自己的生产日志**（21 条 `ttfb_ms` 字段）：400 / 401 / 502 / 524 / 549 ms

→ 真值 **400–550 ms**。账本从 `401+800+334≈1535ms` 更正为 **`401+800+450≈1650ms`**。

### 对你们目标的影响

| 你们的目标 | 现状 | 判定 |
|---|---|---|
| Worker 预热后首 token <500ms | LLM ttft ~800ms | 🔴 **达不到，唯一杠杆是换模型** |
| L2 首包 <1.5s | ~1.65s | 🔴 **超标 ~150ms** |
| VAD→UI 150ms | 纯端侧 | ✅ 与云端无关 |
| 打断本地停播 <150ms | 纯端侧 | ✅ |
| L0 开口 ≤400ms | 纯端侧本地音频 | ✅ |

**LLM 首字这段我方已查穿**：我方网络 RTT 3.4ms、对方网关处理 5.1ms，两段合计 <10ms，
其余全在模型推理。**请按此账本拆解，不要整段归因到链路。**
要压只有换模型，那是独立决策。

**需要端侧提供两个我方看不见的数**：设备→`voice-hk.hahaxiong.cc` 的 RTT、
UART 唤醒帧 → `AiVoiceRuntime` 收到的链路耗时。

---

## 11. 当前未实现清单（明确"没有"，不编造）

| 能力 | 状态 | 说明 |
|---|---|---|
| 入站控制通道 / cancel / cancel_ack | 【未实现】 | §8，S2-B1 交付 |
| trace_id | 【未实现】 | §8.4，随控制通道一起 |
| session resume | 【未实现】 | `worker.rs:253` `supports_resume: false` |
| Game Snapshot 接收 | 【未实现】 | S2-B2 |
| `propose_tool` 结构化输出 | 【未实现】 | 当前 LLM 工具调用为直接执行，S2-B1 先**关闭**（配置级） |
| Arbiter allow/rewrite/cut/cancel | 【未实现】 | S2-B2 |
| `voice.server_command_received` | 【未实现】 | 无服务端下发命令机制 |
| `voice.session_summary_changed` | 【未实现】 | 无会话摘要 |
| `voice.statistics_changed` | 【未实现】 | 有内部 metrics，无面向客户端推送 |
| `voice.user_memory_changed` | 【未实现】 | **无用户记忆——产品能力，非接口适配** |
| 服务端 AEC / 降噪 | 【未实现】 | 且不计划实现，见 §5.4 |
| Android / Web 客户端示例 | 【部分】 | 有浏览器测试页（47.239 `/var/www/voice/`），无 Android 示例 |

⚠️ 后四个 Godot 事件：要么端侧保留旧 MyJavis 通道并行供给，要么进 backlog 单独排期。
**别默认"换个引擎这些就跟着来了"。**

---

## 12. LiveKit Android SDK 打包与注入

**我方不对此出结论。**

Maven 坐标、传递依赖闭包、`.so` 清单、ProGuard consumer rules、包体增量、初始化 PSS/RSS、
以及 `classes3.dex + apktool` 路线能否注入——**我方没有任何已验证依据**。
在 2 GB RAM 的 RK3562 上判断错，代价由你们承担，而给出未验证结论正好违反本文档第一条纪律。

**建议自行实测**：拉一个空壳 Gradle 工程集成官方 SDK → 量 APK 增量与初始化内存 →
再判注入可行性。我方可配合提供 worker 侧的协议兼容性确认（SDK 版本只要支持
legacy Transcription 与 DataChannel 即可，这两项自 LiveKit Android SDK 早期版本即有）。

---

## 13. 旧 Runtime 麦克风互斥

**这一块在设备侧，我方无源码可读，只能给约束**【待双方确认】：

1. **任何时刻只能有一个 `AudioRecord` 持有者。** LiveKit SDK 的 audio device module
   在 `room.connect()` + `publishTrack` 时占麦，在 `disconnect()` 时释放。
2. **切换顺序**：feature flag 开 → 停旧 Runtime 采集（`stop`/`pause`）→
   确认释放 → 新 Runtime `connect` → `publishTrack`。**反序会 `ERROR_INVALID_OPERATION`。**
3. **回滚顺序**：新 Runtime `disconnect()` → 确认释放 → 旧 Runtime 恢复采集 → flag 关。
4. **失败回滚**：新链路 `connect` 超时或 `publishTrack` 失败 → 立即执行回滚顺序，
   不要停在中间态（中间态 = 两边都没麦，用户完全失声）。
5. **不建议一次性删除旧 Runtime**——flag 是回滚路径，删了就没有回滚。

---

## 14. S2-B1 联调用例（你们 12 条里本切片能跑的）

| # | 用例 | 前置 | 预期 | 失败判定 |
|---|---|---|---|---|
| 1 | 全双工 Room 建立 | token 含 roomConfig | 云端日志 `both directions ready`；`audio in (10s) frames>0 mean_amp>0` | `frames=0` → 端侧息屏/权限；无 `both directions` → 派单没生效 |
| 2 | 「停」本地 <150ms 停播 | 命令词已识别 | 端侧计时 <150ms | 超时 → 端侧走了网络往返 |
| 3 | cancel 后旧 TTS 不恢复 | 用例 2 后 | 收到 `cancel.ack`；无后续音频帧 | 有音频 → worker cancel 未生效 |
| 4 | 连续打断三次 | — | 三次各自 ack；无重复半句；worker 不崩 | 重复半句 → 用了 LLM 原文而非截断 final |
| 5 | 小可说话不被 ASR 当输入 | **AEC 已开** | TTS 播放期间用户静默 → 无用户字幕产生 | 有字幕 → **AEC 失效，见 §5.4** |
| 6 | 重复 cancel 幂等 | 同 trace_id 发两次 | 第二次 `already_done`，不报错 | 报错 → 幂等未实现 |
| 7 | 同一时刻单一麦克风持有者 | flag 开关各一次 | 无 `ERROR_INVALID_OPERATION` | 报错 → 切换顺序错，见 §13 |
| 8 | Worker 重连不影响 MCU/VAD/Godot | 云端重启 unit | 设备侧 MCU/Godot 无异常；设备自行重连 | 连锁失败 → 端侧耦合过深 |
| 9 | 断网 L0 本地播报 | 拔网 | 本地音频立即播，不等网络 | 等待 → L0 走了云端 |
| 10 | **长句播放缓冲不 underrun** | 切讯飞后，39 字以上句 | 播放连续无卡顿 | 卡顿 → §6.2 的 1.9 倍裕度不够 |

**用例 4/5/10 是本切片最关键的三条**——分别验打断闭环、AEC、讯飞吐流裕度。

---

## 15. 分工与阻塞

| # | 事项 | 归属 | 阻塞 |
|---|---|---|---|
| 1 | 回答 §5.4：芯片麦克风与 Android 麦克风是否同一路 | 安卓 | — |
| 2 | 回答 §5.5：谁持麦（决定息屏方案） | 安卓 | — |
| 3 | 提供上行录音（AEC 验收物） | 安卓 | — |
| 4 | 提供 RTT + UART 链路耗时 | 安卓 | — |
| 5 | SN 恢复出厂后是否稳定 | 安卓 | — |
| 6 | LiveKit SDK 注入可行性实测 | 安卓 | §12 |
| 7 | **实现入站控制通道**（§8） | 云端 cc | **无阻塞，进行中** |
| 8 | **实现 `tts_xfyun.rs`**（§6） | 云端 cc | **无阻塞，进行中** |
| 9 | `/v1/device/session` 后端 | 后端 | — |
| 10 | 冻结 S2-B2 合同 | 云端 cc | 依赖 #1、#2 |

**结论：Android 端可以开始 S2-B1。** 用例 1/7/8/9 现在就能做（不依赖控制通道）；
用例 2/3/4/6 等 #7 交付；用例 5 等 #1 答复；用例 10 等 #8 交付。

---

*本文档为 2026-08-14 状态。标【源码确认】者附文件:行号，可在
`feat/rust-worker @ 8f6ece7a0` 复核；标【建议新增】者未实现；*
*标【待双方确认】者需安卓端答复后方可定稿。*

*署名：cc（Claude）| 2026-08-14*
