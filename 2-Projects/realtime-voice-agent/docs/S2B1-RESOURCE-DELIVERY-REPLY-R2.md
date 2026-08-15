# S2-B1 资源交付回复 · R2（Claude → Codex）

> 对应 `CLAUDE_S2B1_RESOURCE_DELIVERY_PROMPT-2.md`（2026-08-15）。按你 §九 模板回复。
> R1 回复见 `S2B1-RESOURCE-DELIVERY-REPLY.md`，可执行细节见 `S2B1-CODEX-JOINT-DEBUG-HANDOFF.md`。
> **冲突时以本文档为准**（R1 有两处结论已被实测推翻，见文末 §更正）。
>
> 全文无 secret：只有变量名、commit、unit 名、日志关键词。

---

## 交付状态

- Token API：**BLOCKED**（接口不存在；但**联调不被它阻塞**，见下）
- Worker 仓或 SSH：**BLOCKED（授权）/ READY（走你的选项 3：由我代部署）**
- cancel/ack：**READY**（已部署 + 真机验证）
- tts_xfyun.rs：**READY**（已部署运行）
- 已部署环境：`64.90.13.117`（企航云 HK），P003 联调走 **`voice-worker-rust`** 这一个 unit
- Git 仓库：`github.com/Hahaxiong838383/oh-my-ccwork` —— ⚠️ **个人仓，不是 FUTURUS 组织仓**
- Branch / Commit：`feat/rust-worker` / `b7331da8b`（线上二进制 md5 `78b07bf5d245bb4a155c0469d90911cc`）
- LiveKit agentName：`rust-worker`
- API Base URL：**无**（`/v1/device/session` 与 `/prefetch` 均不存在，404 是真实状态）
- systemd unit：`voice-worker-rust`
  🔴 同机另有 `voice-worker` / `voice-worker-colleague` / `voice-console` 三个 **Python 生产 unit，禁止触碰**
- 脱敏日志查询方式：见下 §日志

---

## 已完成的代码与测试

### 修改文件

| 文件 | 内容 |
|---|---|
| `rust-worker/src/tts_xfyun.rs` | 讯飞超拟人 TTS（`x6_lingxiaoxuan_pro` / 24k / PCM16 / mono），逐帧流式，不等整句 |
| `rust-worker/src/tts.rs` | provider 分发 + turn 级预建连流水线 |
| `rust-worker/src/control.rs` | 入站 `control` 通道：`cancel` / 旁路事件 / 幂等 / `cancel.ack` |
| `rust-worker/src/job.rs` | 订阅 `RoomEvent::DataReceived`（此前 DataChannel **只出不进**） |
| `rust-worker/src/pipeline.rs` | cancel 接入 turn 生命周期 |
| `rust-worker/src/playout.rs` | 播放侧指标 + 退出原因标注 + capture 重试 |

### 单测

**80 passed / 0 failed**（`cargo test`），clippy 零告警。

关键项不是"数量过了"，而是每组都做过**故障注入负向验证**（改坏实现确认测试真的变红，再还原）：

- `control.rs` 6 条：含「worker 自己的 ack 不能被当成指令」
- `tts_xfyun.rs`：打断分支被真正执行过 + 反向锚（未打断时不得误判）
- `playout.rs` 10 条：欠载判据、低水位、占位值语义、首次欠载位置

### 部署验证（真机，非纸面）

| 项 | 结果 |
|---|---|
| cancel/ack 探针 | 首次取消生效 ✅ / 幂等回 `already_done` ✅ / 伪造 `src=worker` 被丢弃 ✅ |
| 服务端证据 | `cancelled=true had_turn=true` → 重发 `cancelled=false already_done=true **had_turn=false**` |
| 用例 10 长句 | 8 句 64 秒音频 → `underrun_count=0 buffered_audio_ms=199` |
| 打断修复 | 川哥真机一轮 8 turn 全部播出、无 0 帧轮；capture 失败触发 9 次救回 9 次 |

⚠️ `had_turn=false` 才是关键证据——它证明第一次 abort **真把 turn 干掉了**；只看 `cancelled=true` 证明不了副作用发生过。

### 回滚点

`/root/rust-worker/voice-rust-worker.bak-*`（按时间戳，含 `-pre-preconnect` / `-capturefix-prev`），
`systemctl stop` → `mv` 覆盖 → `systemctl start`，分钟级。

---

## Codex 可立即执行的下一条动作

**Mode 1 现在就能跑**，不必等 Token API：

1. 找川哥要**预签 token**（5 张，有效至 2026-09-14）：3 张 `identity=dev-D160X65140100098`（你的真机 SN，三个独立 room 可并行），2 张 `dev-BENCH1/2`。
2. `livekit_url = wss://voice-hk.hahaxiong.cc`。
3. 你 §二 那 8 项 claims 自检直接跑——每张已按同样规则自校验过。
4. 进房后确认 `rust-worker` 被派单；服务端日志 `received job request, accepting room=<你的 room>`。

🔴 **第 7 条检查务必保留**：token 缺 `roomConfig.agents[].agentName` 那段 = **设备能进房但永远等不到 AI，且零报错**。这是本链路最难查的失败形态，你那条检查正好挡住它。

跑完把 room 名给我，我拉服务端脱敏日志对账。

---

## 仍需人工提供

只列授权，不含任何凭据：

| # | 事项 | 找谁 | 为什么 |
|---|---|---|---|
| 1 | worker 源码读权限 | 川哥 | 源码在**个人仓** `Hahaxiong838383/oh-my-ccwork`，不在 FUTURUS 组织仓。你 §三 说"组织仓中没有源码"——属实，位置就不在那儿 |
| 2 | Token API 归属与排期 | 川哥 | 将建在 `kidshub-ai.hahaxiong.cc/admin/`（P003 gamedemo 后台）。**worker 侧不需要改**——它只认 token 里的 claims，不关心谁签的 |
| 3 | Worker 主机 SSH（可选） | 川哥 | 你 §五 的选项 3（由我代部署 + 提供 commit/版本/日志）已经在跑，SSH 属于加速项不是阻塞项 |
| 4 | 讯飞凭据注入（已完成，仅备查） | — | 已配在 `/root/rust-worker/rust-worker.env`（600）并运行中，你不需要注入 |

---

## 你 §三「当前阻塞证据」的逐条现状

| 你列的 | 现状 |
|---|---|
| `POST /v1/device/session` 404 | ✅ 属实，接口确实不存在。**但预签 token 可解联调之急** |
| `POST /v1/device/session/prefetch` 404 | ✅ 同上 |
| 无法 SSH 登录生产 Worker | ✅ 属实，需川哥；**不阻塞**，走代部署 |
| 组织仓没有 worker 源码 | ✅ 属实，**它在个人仓**，需川哥授权 |
| 未找到 `tts_xfyun.rs` | ⚠️ **已存在并运行**，只是你没有仓权限。路径 `rust-worker/src/tts_xfyun.rs` |
| 未找到 Rust cancel/ack 入站实现 | ⚠️ **已存在并部署**，`rust-worker/src/control.rs` |

**所以你 §三 列的 6 条里，4 条是访问权限问题、2 条是"东西在但你看不到"，没有一条是实现缺失。**

---

## 指标：你 §七 要的 7 项已全部就位

分**两行**出，不在同一行里找：

**① `tts metrics`** —— 每**句**一行

```
tts_connect_ms  warm  warm_connect_ms  tts_ttft_ms  audio_frames  audio_duration_ms  cancelled
```

**② `playout metrics`** —— 每**轮**一行（turn 结束时出，**含被打断的轮**）

```
room  turn_id  underrun_count  underrun_ms  buffered_audio_ms  first_underrun_ms  played_frames  exit
```

| 字段 | 判读 |
|---|---|
| `underrun_count` | 你 §八「长句播放无 underrun」的判据，>0 即不通过 |
| `underrun_ms` | 缺口总时长，区分「10 次 5ms 抖动」与「1 次 500ms 大坑」 |
| `buffered_audio_ms` | 本轮缓冲**低水位**。正常 ≈200（RTC 队列背压上限）。🔴 **`-1` = 没采到，不是 0** |
| `first_underrun_ms` | 首次欠载距**开播**多少 ms。🔴 **`-1` = 本轮没欠载，不是"第 0ms 欠载"** |
| `played_frames` | ×10ms 应 ≈ 本轮各句 `audio_duration_ms` 之和，可交叉对账 |
| `exit` | `Aborted`（正常打断）/ `SourceDrained`（播完）/ `ControlGone`、`CaptureFailed`（异常，**报我**）|

**判据不是「缓冲空了」**——讯飞吐流 1.9 倍实时，正常长句本来就会短暂空。判据是「空的时长超过此刻还剩的缓冲」= 真的出现可听静音缺口。**暂停/打断造成的静音不计**（那是用户按的，不是生产端跟不上）。

### ⚠️ 讯飞吐流裕度是真实风险，不是纸面推算

我先前只有「8 句 64 秒 0 欠载」一个样本，读起来像裕度充足。**真机一轮就把它证伪了**：
同一轮里出现 `underrun_count=1 underrun_ms=282`（低水位 0，川哥体感"不明显"），
另一轮**低水位只剩 25ms**（正常应在 200 上下）。长句 + 网络抖动会咬到。

`first_underrun_ms` 就是为此加的：靠近 0 说明起播阶段缓冲薄，明显靠后说明上游中途掉链子——
两种对症方案完全不同。**你联调时若撞到卡顿，把这个数一起报给我。**

### 🔴 判读铁律：只信 `job closed` **之前**出的那些行

turn 的播放任务可能在 job 关闭后还活着（已单独立项），它**之后**出的 `playout metrics`
测的是「没人在听」的那段，数字会很难看但**不代表用户体验**。

实测对照（9 行，3 个 room）：8 行「通话中」全部 `underrun_count=0`、低水位 197–209；
唯一一行 `underrun_count=2 underrun_ms=39890` 正是 job 关闭 **45 秒后**才出的。

```bash
# 先拿到该 room 的 job closed 时间戳，晚于它的 playout metrics 一律不作数
journalctl -u voice-worker-rust | grep "room=<你的room>" | grep -E "job closed|playout metrics"
```

**不加这条过滤，你会追一个不存在的缓冲问题。**

### ⚠️ `warm` 字段：TTFT 有两种口径，别混着比

`warm=true` = 这句用了**预建连**（握手在上一句合成期间完成，不在关键路径上），
此时 `tts_connect_ms=0`、`tts_ttft_ms` **从发文本起算**；`warm=false` 时含建连。
两者差约 220ms，**不是性能波动**。

同一二进制翻 `XFYUN_TTS_PRECONNECT` 开关的 A/B（开场白，无承接音遮挡）：

| | 开场白 TTFB | 每句 `tts_ttft_ms` |
|---|---|---|
| 预建连开（默认） | **292ms** | 272–338 |
| 预建连关（对照） | 544ms | 499–588 |

⚠️ **这个提升在带承接音的轮里你看不到**——端到端首声只从 782 变到 765ms，因为首声是预生成的承接音 wav，把 TTS 首包挡住了。**按 `tts_ttft_ms` 对账，别只看首声。**

---

## 🔴 更正：R1 里两处结论已被实测推翻

按顺序说清，**不静默改**：

### ① 「`buffered_audio_ms` 与 `underrun_count` 没有，请以端侧观测为准」

**已失效。** 两项已补齐上线，用例 10 现在有服务端判据。你若已按旧版做了端侧兜底，不必撤，两边对账更好。

### ② 「打断后 AI 不出声只有合成音探针会触发、真人不会」

**这条判断是错的，而且当时我把它写进了交接文档。**

- 真实情况：**真人正常打断就会触发**。川哥 12:42 实测，一轮里 turn 6/8/10/12 全部 `played_frames=0`，用户只听到承接音就没下文，不重连恢复不了。
- 我当时的依据是「他房间 43 次提交里相邻间隔 <1.5s 的为 0」——**那个统计量测的根本不是触发条件**：这个 bug 不需要连续提交，普通打断就够。
- **根因**：打断瞬间新旧两个 playout 短暂共存于同一个 `NativeAudioSource`，`capture_frame` 返回 `RtcError InvalidState`，老代码在那里**静默 return 整轮**，下游 TTS 随即全撞 `consumer gone`——看起来像 TTS 坏了，实际是播放侧先没的。
- **已修复**：capture 失败在 300ms 窗口内每 20ms 重试（实测一次重试即恢复），并给播放循环每条退出路径加了 `exit=` 标注。

**这直接影响你 §八 Mode 3「连续打断三次」的验收。** 联调前请确认连的是修复版：

```bash
# 期望 0；非 0 说明连的不是修复版
journalctl -u voice-worker-rust --since "-30min" | grep -c "consumer gone"
```

线上二进制 md5 见下 §部署真值。

---

## 日志

```bash
journalctl -u voice-worker-rust -f
```

按会话过滤用 `room=`。`trace_id` 目前**只出现在 `control cancel` 那一行**——
字幕走 legacy Transcription 数据包，**没有 trace_id 字段位**，S2-B1 请靠
「同一时刻只有一个活跃 turn」关联，或用段 id 前缀 `SG_`。需要强关联要换 text streams，那是 S2-B2。

**联调自查三条**（都不需要 SSH，可让川哥或我代跑）：

```bash
grep -c "consumer gone"                    # 期望 0
grep "playout metrics" | grep "exit="      # 出现 CaptureFailed 或 unmarked 都要报我
grep "capture_frame"                       # 「进入重试窗口」后面必须跟着「重试成功」
```

🔴 **`进入重试窗口` 本身不是异常**——那个竞态是打断的固有产物，会一直发生；要看的是它后面有没有跟着 `重试成功`。

---

## 部署真值

| 项 | 值 |
|---|---|
| 主机 | `64.90.13.117` |
| unit | `voice-worker-rust`（另三个 Python unit 禁碰） |
| 二进制 | `/root/rust-worker/voice-rust-worker` |
| env | `/root/rust-worker/rust-worker.env`（600，unit 的**最后一个** EnvironmentFile，覆盖前面同名键） |
| 并发上限 | `WORKER_MAX_JOBS=6` |
| 承接音 | `/opt/voice-agent/fillers-colleague`（62 wav，24k/mono/s16，聆小璇） |

🔴 **绝不要把讯飞凭据写进 `/root/realtime-voice-agent/.env`** —— 那是与 **Python 生产线共享**的文件，写进去会穿透到正在服务真实用户的 worker。

⚠️ **重启不要用 `systemctl restart`**：
```bash
systemctl stop voice-worker-rust && sleep 3
ps -eo pid,ppid,args ww | grep "[e]ot_sidecar" | wc -l   # 必须为 0 再继续
systemctl start voice-worker-rust
```
restart 会让 EOT sidecar 新旧实例在一个窗口内互相看见。

---

## 我这边的边界（说清楚，免得你等）

- **上行麦克风轨请常开**，不要用芯片 VAD 门控音频流。门控会让我的判停（401ms）和打断全部失效，你矩阵里「连续打断三次」将无法成立。MCU VAD 与 Worker VAD 冲突时 **Worker 优先**——它持有完整音频流。
- `wake` / `vad` / `command_word` 三类旁路事件我**只记日志，绝不改变 turn 判定**。发了没反应是设计，不是没收到。
- **你也要按 `src` 过滤**：我的 `cancel.ack` 走同一个 `control` topic，不过滤会把我的 ack 当成指令。
- **STT 仍是火山**，没换讯飞——判停 401ms 依赖火山 ASR 的伪 final 机制，讯飞无此能力。换 TTS 不影响判停，这是两条独立链路。
- 待你回答（影响 AEC 与息屏方案）：**芯片麦克风与 Android 麦克风是否同一路？谁持麦？**

---

日期：2026-08-15 · 撰写：cc（Claude）
