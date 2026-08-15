# S2-B1 联调交接（Claude → Codex）

> 供 Codex 直接开工。全文无 secret：只有变量名、commit、unit 名、日志关键词。
> 前置文档：`VOICE-RUST-WORKER-ANDROID-CONTRACT-S2B1.md`（接口合同）、
> `S2B1-RESOURCE-DELIVERY-REPLY.md`（资源交付回复）。**本文档是可执行版，冲突以本文档为准。**
>
> 日期：2026-08-15 · 撰写：cc（Claude）

---

## 0. 状态速览

| 项 | 状态 |
|---|---|
| Token | ✅ **已签发 5 张，有效到 2026-09-14**（30 天），川哥手上，找他要 |
| `tts_xfyun.rs`（聆小璇） | ✅ 已部署运行 |
| **`cancel` / `cancel.ack`** | ✅ **本轮已实现并部署** |
| TTS 脱敏指标 | ⚠️ **7 项做了 5 项**，见 §4 |
| Token API（`/v1/device/session`） | ❌ **不存在**，后续走 `kidshub-ai.hahaxiong.cc/admin/` 签发管理 |
| 仓库权限 | ✅ 你有组织仓读写；worker 源码在**个人仓**，见 §1，碰到权限找川哥 |

---

## 1. 源码与环境真值

| 项 | 值 |
|---|---|
| 仓库 | `github.com/Hahaxiong838383/oh-my-ccwork`（**个人仓**，非 FUTURUS 组织） |
| 分支 | `feat/rust-worker` |
| 源码根 | `2-Projects/realtime-voice-agent/rust-worker/src/` |
| 主机 | `64.90.13.117` |
| systemd unit | `voice-worker-rust`（⚠️ 另外三个 `voice-worker` / `voice-worker-colleague` / `voice-console` 是 **Python 生产线，禁止触碰**） |
| LiveKit 信令 | `wss://voice-hk.hahaxiong.cc` |
| agentName | `rust-worker` |
| 并发上限 | `WORKER_MAX_JOBS=6` |

**日志查询**（无需 SSH 也可让川哥或我代跑）：

```bash
journalctl -u voice-worker-rust -f
```

按会话过滤用 `room=`；`trace_id` 目前只出现在 `control cancel` 那一行（字幕通道无 trace_id 字段位，见 §3 末）。

---

## 2. Token：现在就能用

川哥手上有 **5 张**，`livekit_url = wss://voice-hk.hahaxiong.cc`：

- **3 张**：`identity = dev-D160X65140100098`（你的真机 SN），三个独立 room，可并行三会话
- **2 张**：`identity = dev-BENCH1` / `dev-BENCH2`，压测或第二台设备

每张已做 claims 自校验，你 §二 那 8 项检查可直接跑：`sub` = identity、`video.room` 锁死、
`roomConfig.agents[].agentName = ["rust-worker"]` 齐备。

🔴 **缺 `roomConfig` 那段 = 设备能进房但永远等不到 AI，且零报错**——这是本链路最难查的失败形态。
你那 8 项校验里的第 7 条正好挡住它，保留。

⚠️ token 等同房间钥匙：不进 git、不写固件明文、不贴聊天工具。

**Token API 后续归属**：走 `https://kidshub-ai.hahaxiong.cc/admin/`（P003 gamedemo 后台）做创建与管理。
接口契约见合同 §3.2，worker 侧不需要改动——**worker 只认 token 里的 claims，不关心谁签的**。

---

## 3. cancel / cancel.ack：本轮已交付

**通道**：DataChannel，topic 固定 `control`，reliable + ordered。

### 你发（Android → Worker）

```jsonc
{ "trace_id": "trace_example", "ts_ms": 0, "src": "android",
  "type": "cancel", "lane": "L2", "seq": 1,
  "payload": { "reason": "user_barge" } }
```

### 我回（Worker → Android，同一 topic）

```jsonc
{ "trace_id": "trace_example", "ts_ms": 0, "src": "worker",
  "type": "cancel.ack", "lane": "L2", "seq": 1,
  "payload": { "cancelled": true, "already_done": false } }
```

### 语义（逐条对齐你的要求）

| 规则 | 实现 |
|---|---|
| 只接收 `src=android` | ✅ **这条对你也重要**：我的 ack 走同一 topic，你解析时也要按 `src` 过滤，否则会把我的 ack 当成指令 |
| `trace_id + seq` 幂等 | ✅ |
| 重复 cancel | ✅ 回 `already_done=true`，**不报错** |
| cancel 后停止 | ✅ 停 LLM 流 / 停 TTS 合成 / 停推音频 / 清 RTC 缓冲 / 字幕按**已播样本**截断收尾 |
| 无在说的 turn 时 cancel | 回 `cancelled=false, already_done=false`，**不报错** |
| 旧 trace | 幂等表按 trace 隔离 |

**cancel 走硬 abort**（川哥 2026-08-15 拍板）：不进 pause + 假打断窗口，
不等 1.5s 定时器判断是不是说错话。你本地静音不必等我的 ack。

### 旁路事件：发了不会有反应，这是设计

`wake` / `vad` / `command_word` 三类我**只记日志，绝不改变 turn 判定**。

🔴 **MCU VAD 与 Worker VAD 冲突时，Worker 优先**——它持有完整音频流。
请务必让**上行麦克风轨常开**，不要用芯片 VAD 门控音频流：门控会让我的判停（401ms）
和打断全部失效，你矩阵里的「连续打断三次」将无法成立。

### ⚠️ trace_id 的已知限制

字幕走 **legacy Transcription 数据包**，**没有 trace_id 字段位**。
S2-B1 请靠「同一时刻只有一个活跃 turn」关联，或用段 id 前缀（`SG_`）。
需要强关联要换 text streams，那是 S2-B2 的事。

---

## 4. 指标：7 项已全部就位（本节 2026-08-15 更新，此前写的「缺 2 项」已失效）

> 🔴 **更正**：本文档首版写「`buffered_audio_ms` 与 `underrun_count` 没有，
> 请以端侧观测为准」。**这两项已在 2026-08-15 补齐并上线**，用例 10 现在有服务端判据了。
> 若你已按旧版做了端侧兜底，不必撤，两边对账更好。

分两行出，**不在同一行里找**：

**① `tts metrics`** —— 每**句**一行（TTS 侧）

```
tts_connect_ms  warm  warm_connect_ms  tts_ttft_ms  audio_frames  audio_duration_ms  cancelled
```

**② `playout metrics`** —— 每**轮**一行（播放侧，turn 结束时出，含被打断的轮）

```
room  turn_id  underrun_count  underrun_ms  buffered_audio_ms  played_frames
```

字段口径：

| 字段 | 含义 | 判读 |
|---|---|---|
| `underrun_count` | 播放中途真的出现**可听静音缺口**的次数 | 用例 10 的判据，>0 即不通过 |
| `underrun_ms` | 缺口总时长 | 区分「10 次 5ms 抖动」与「1 次 500ms 大坑」 |
| `buffered_audio_ms` | 本轮缓冲**低水位**（最危险时刻还剩多少毫秒） | 正常 ≈200（RTC 队列背压上限）。**`-1` = 没采到，不是 0** |
| `played_frames` | 已喂 RTC 的 10ms 帧数 | ×10ms 应 ≈ 本轮各句 `audio_duration_ms` 之和，可交叉对账 |

**判据不是「channel 空了」**——讯飞吐流 1.9 倍实时，正常长句本来就会短暂空。
判据是「空的时长超过此刻还剩的缓冲」。**暂停/打断造成的静音不计**（那是用户按的，不是生产端跟不上）。

**我这边的实测结果**（2026-08-15，8 句长回复、64 秒音频，句长 39–49 字，符合用例 10 条件）：

```
playout metrics turn_id=2 underrun_count=0 underrun_ms=0 buffered_audio_ms=199 played_frames=6404
```

→ **用例 10 服务端侧通过**。低水位 199ms 说明缓冲全程压在背压天花板上，没掉下来过。

⚠️ 一处诚实边界：`underrun_count` 的计数分支**在生产上还没被观测到真的触发过**（因为没发生欠载）。
算术本身有单测 + 四处故障注入验证。同一次调用里算出的 `buffered_audio_ms=199` 是它的非零锚——
若这段代码没跑，该字段会是 `-1` 而不是 199。

另注意字段名：是 **`tts_ttft_ms`**，不是 ttfb。老日志行 `say synthesized ttfb_ms=` 仍在，两者同源。

### ⚠️ `warm` 字段：TTFT 有两种口径，别混着比

`warm=true` 表示这句用了**预建连**（握手在上一句合成期间就完成了，不在关键路径上）。
此时 `tts_connect_ms=0`、`tts_ttft_ms` **从发文本起算**；`warm=false` 时 `tts_ttft_ms` 含建连。
两者差约 220ms，**不是性能波动**。`warm_connect_ms` 记的是那次预建连自己花的时间，供对账预热是否真生效。

2026-08-15 起 `warm=true` 是默认态。同一二进制翻 `XFYUN_TTS_PRECONNECT` 开关的 A/B：

| | 开场白 TTFB（无承接音遮挡） | 每句 `tts_ttft_ms` |
|---|---|---|
| 预建连开（默认） | **292ms**（296/295/286） | 272–338 |
| 预建连关（对照） | 544ms（515/549/567） | 499–588 |

**这个提升在带承接音的轮里你看不到**——端到端首声只从 782ms 变到 765ms，因为首声是
预生成的承接音 wav，把 TTS 首包挡住了。收益落在①无承接音的轮（如开场白）
②承接音播完到正文接上的那个衔接点。你验收时按 `tts_ttft_ms` 对账，别只看首声。

---

## 4b. 🔴 打断后 AI 不出声 —— 已定位并修复（2026-08-15 当天，务必用修复后的版本联调）

**如果你在此之前连过我的 worker，遇到「打断之后 AI 彻底不说话、只剩承接音」——那是这个 bug，不是你的问题。**

- **症状**：打断后新一轮 `played_frames=0`，该轮 TTS 全 `cancelled=true`，不重连恢复不了。
- **根因**：打断瞬间新旧两个 playout 短暂共存于同一个 `NativeAudioSource`，
  `capture_frame` 返回 `RtcError InvalidState`，老代码在那里**静默 return 整轮**，
  下游 TTS 随即全撞 `consumer gone`。
- **修复**：capture 失败在 300ms 窗口内重试（实测 6/6 一次 20ms 重试即恢复），
  并给播放循环每条退出路径加了 `exit=` 标注。
- **线上版本**：`voice-rust-worker` md5 `55eb8a5d77314d630a3eee214bd83699`。
  联调前用 `grep -c "consumer gone"` 自查，**期望 0**；非 0 说明你连的不是修复版。

⚠️ 我一度把它判成「只有合成音探针触发、真人不会」并写进本文档上一版 —— **那个判断是错的**，
真人正常打断就会触发。此处更正。

### 顺带：`playout metrics` 多了 `exit=` 字段

`Aborted`（正常打断）/ `SourceDrained`（本轮播完）/ `ControlGone`、`CaptureFailed`（异常）。
出现 `CaptureFailed` 或 `unmarked` 都要报我。

---

## 5. 三个数的口径必须对齐，否则会查一个不存在的性能问题

你的裸 WS 探针 **TTFT 192ms**、我的裸协议探针 **248–275ms**、Rust 线生产 **500–555ms**——
三个都对，**测的不是同一段**：

| 口径 | 值 | `t0` 起点 |
|---|---|---|
| 你的 / 我的裸探针 | 192 / 248–275ms | WS **已连上之后**发请求那一刻 |
| Rust 线 `tts_ttft_ms` | 500–555ms | 签名 URL + TLS + WS 握手**之前** |

差值 ≈ **267ms = 每句建连成本**（当前「一句一条 WS」的固有代价）。
新增的 `tts_connect_ms` 就是让你把这段单独拆出来看的。

**这也是「一个 turn 一条 WS + `status=0→1→2`」优化的全部收益来源**（第 2 句起省掉 267ms）。
该优化**未实现**，与你「后续优化才考虑」一致。

补两条我实测的协议真值：

- 硬约束只有 **14 秒无上行数据**（实测段间隔 3/8/11s 成功，15s 报 `26005 No active up data within 14000 ms`）。
  官方文档写的 10s 与「前 20 字需 25 字/秒」**均非硬约束**，2 字/秒实测通过。
- **确认无 cancel/中止指令**：整句一次性发出后服务端一定吐完，只能在收流侧丢弃。

---

## 6. 讯飞凭据：只给名称，不要粘值

```
XFYUN_TTS_APP_ID   XFYUN_TTS_API_KEY   XFYUN_TTS_API_SECRET
XFYUN_TTS_VCN      # = x6_lingxiaoxuan_pro（音色名不是凭据）
TTS_PROVIDER       # = xfyun
```

**写入 `/root/rust-worker/rust-worker.env`（600）** —— 它是该 unit 的**最后一个 EnvironmentFile**，覆盖前面同名键。

🔴 **绝不要写进 `/root/realtime-voice-agent/.env`** —— 那是与 **Python 生产线共享**的文件，
写进去会穿透到正在服务真实用户的 worker。

**当前该机凭据已配好并在运行**，你不需要注入。换机或排障时按上面来，重启用：

```bash
systemctl stop voice-worker-rust && sleep 3
ps -eo pid,ppid,args ww | grep "[e]ot_sidecar" | wc -l    # 必须为 0 再继续
systemctl start voice-worker-rust
```

⚠️ **不要用 `systemctl restart`** —— 它会让 EOT sidecar 新旧实例在一个窗口内互相看见，
新 worker 连上将死的旧实例后不再 spawn 自己的，结果是判停静默降级、无红灯。

---

## 7. 你现在就能跑的顺序

### Mode 1 — connect-only

1. 找川哥要一张 token（3 张真机 SN 的任选）
2. 跑你那 8 项 claims 校验
3. 进房。服务端应出现：`received job request` → `both directions ready` → `tts provider 生效值`

### Mode 2 — 全双工音频

上行 **16kHz / PCM16 / mono / 20ms 帧**，交给 LiveKit ADM，**不要自己攒包**（帧长直接进判停延迟）。
下行 24kHz 由 worker 作为 remote audio track 发布。

**三分诊断**（看 `audio in (10s) room=... frames=N mean_amp=X`）：

| 现象 | 结论 |
|---|---|
| `frames=0` | 上行断流 / 未持麦 / 息屏 → **端侧** |
| `frames>0` 但 `mean_amp≈0` | 送的是静音 → 权限或采集链路 |
| 两者正常但 AI 不回 | 服务端下游，抓 `asr:` / `llm` / `tts` 行 |

### AEC —— 🔴 请先答一个问题

我方**不做任何 AEC 或降噪**。worker 里的 "AEC warmup" 只是 **0.5 秒打断抑制窗**，不是回声消除。

- 若你用**官方 LiveKit Android SDK 的 audio device module** 播放下行轨 → WebRTC APM 自带 AEC，参考信号取自其播放路径，**可用**
- ⚠️ 若你用 `AndroidVadVoiceReplyPlayer` **自行播放** → WebRTC **拿不到参考信号，AEC 直接失效**
- ⚠️ **若 VAD 芯片有独立麦克风通路** → WebRTC 的 AEC 对它无效，芯片会在 TTS 播放时被自己的声音唤醒

**请答复：芯片麦克风与 Android 麦克风是否同一路？** 这决定 AEC 方案和息屏保活方案，我等这个答复。

### Mode 3 — cancel / 打断

按 §3 发包。服务端可见：

```
control cancel  trace_id=... seq=... cancelled=true  already_done=false  had_turn=true
```

**连续三次打断**：每次独立发 cancel（`seq` 递增），三次都应各自回 ack。

---

## 8. 必须告诉你的两条"未验证"

### ① 打断修复：已部署，**未验证**

`tts_xfyun::send_or_abort()` 修的是「打断时 worker 卡在 `send().await` 上、
整个 turn 收尾被拖住」。判据日志是 `xfyun tts 中止本句,丢弃剩余音频`。

**截至上一轮，该行在生产里出现 0 次**——分支从未被真实触发过。
触发条件是**在合成进行中**打断；落在句子**播放**期间的打断走不到这条路径。

川哥实测反馈「基本 ok」，但那**不构成验收证据**：「没触发到」与「修好了」表现相同。
**请在 Mode 3 当待验项。**

### ② 本轮 cancel/ack：编译测试全绿，真机验证进行中

`cargo test` 65 passed、`clippy -D warnings` 全绿，其中 6 条覆盖 control 模块
（含"worker 自己的 ack 不能被当指令"这条）。但**单测证明不了真机能跑**——
我已写了会发控制包的探针在部署链里跑，结果出来会同步给你。

**你看到本文档时若尚未收到探针结果，请先按 Mode 1/2 推进，Mode 3 等确认。**

---

## 9. 仍需川哥的

1. **token 分发**（已签好，找他要）
2. **Token API 归属**：走 `kidshub-ai.hahaxiong.cc/admin/`，需要那边的人对接合同 §3.2
3. **worker 源码在个人仓**，你若要直接改 worker 需要他开权限；否则走"你提需求 / 我实现部署"
4. **联调环境隔离**：当前 Rust 线与 Python 生产线同机不同 unit，房间不共用
   （Rust 线显式派单，实测 30 天内 Python 线 0 次误接）。要物理隔离需他决定加机器

---

## 10. 红线

- **禁止触碰** `voice-worker` / `voice-worker-colleague` / `voice-console` 三个 unit
- 差异配置只写 `rust-worker.env`，**绝不写共享 `.env`**
- 重启用 `stop` → 确认 sidecar 残留 0 → `start`，**不用 `restart`**
- token / 讯飞 key 不进 git、不进日志、不贴聊天
- 设备**不要常驻连接**：挂着不说话也吃 0.125 核并占满一个槽位（共 6 个）。用完即断、唤醒再连

---

*所有数值于 2026-08-14/15 在 64.90.13.117 实测确认。*
*署名：cc（Claude）| 2026-08-15*
