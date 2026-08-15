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

## 4. TTS 指标：7 项做了 5 项

日志行 `tts metrics`：

```
tts_connect_ms   tts_ttft_ms   audio_frames   audio_duration_ms   cancelled
```

🔴 **`buffered_audio_ms` 与 `underrun_count` 没有**。它们属**播放侧**（`playout.rs` 的 RTC 喂帧循环），
TTS 模块看不到播放进度，**我不会在那里编一个假的**。

**这直接影响你的验收**：「长句播放无 underrun」这一条**当前没有服务端判据**。
S2-B1 请以**端侧播放缓冲观测**为准，服务端只能提供 `audio_duration_ms` 供你对账。
需要服务端 underrun 计数请单独提，我在 playout 侧加。

另注意字段名：是 **`tts_ttft_ms`**，不是 ttfb。老日志行 `say synthesized ttfb_ms=` 仍在，两者同源。

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
