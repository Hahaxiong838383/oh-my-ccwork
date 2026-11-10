# Grok 第二轮独立复验：历史 15 条 trace 与 Worker 替换边界

复验身份：Grok 4.7（xAI）。本轮只读业务树和脱敏提取，未改业务树，未 SSH，未碰生产，未读正文、音频或凭据。第一轮 `GROK-REVIEW.md` 原文件保留。

总判定：回执四项异常仍是 `PENDING_SERVER_INJECTION`。历史 15 条不能升成这四项的 PASS。`cf3c3208` 没有 provider 首包 PCM，不能写成 TTS 成功。`e4d3ae97` 收到了 49920 个样本，不能写成未收音。5 次 `CaptureFailed` 都贴着 abort 或客户端 cancel，没有 output-gate 文案。

## 1. 两处纠正

### 1.1 trace 总数是 15

回执表、`TRACES.json`、`worker-safe-v3.json.trace_hits`、`HISTORICAL_MATRIX.json`、`brain-safe.json` 的签票都是这 15 个后缀，一一对应：

| 组 | 后缀 | 条数 |
|---|---|---|
| 普通 | `ed8d2643` `4de55d33` `88fc47d7` `3f3fecf2` `03a2d982` `cf3c3208` `97dbcd79` `363c8900` `9f3cef3b` `7438bf4b` | 10 |
| 聆听 | `e7262de5` | 1 |
| 未完成 | `e4d3ae97` | 1 |
| 聆听后重试 | `e436605b` | 1 |
| 触摸退出 | `09e2af0f` | 1 |
| 再唤醒 | `b815e6c0` | 1 |

合计 15。第一轮写成 15+1，和 `COORDINATION.md` 里的「15+1」一样，把回执集合数错了。

同一日志窗里还有别的 job，它们不属于这 15：

- 倾听 PID `2750511` 另有两单：`ef95499a` / job `qSyxoLBV` / room `93957301`，17:28:22–17:28:23；`46d5a9a7` / job `8NK5erZd` / room `93957825`，17:37:05–17:38:00。
- 主池 PID `3179125` 上有 `a39b0892`、`2245d98d`、`c2db92dd`、`10c95236`。这 15 条的 `target_suffixes` 全部落在 `p003-listening-worker`，主池命中数是 0。

这两组合在一起也不是「第 16 条回执 trace」。历史对账的分母保持 15。

### 1.2 `startup_participant` 管的是远端 Android participant

回执第 4 项的对象是 Worker：旧 Worker 音轨失效，只允许新 Worker 当前 publication 输出。当前主源把这两个身份分成两处：

- Worker participant 身份在 `worker.rs` 的 availability 响应里写成 `agent-{job_id}`（`worker.rs` 303–304 行）。`participant_name` 是 agent 名。每个 job 一个身份。
- 远端设备身份由房名 `sn-<sn>-<纯数字时间戳>` 推出 `dev-<sn>`（`ordered_pcm.rs` 186–194 行）。`job.rs` 233–234 行把这个值交给 `StartupParticipant::new`。

`StartupParticipant::connected`（`startup_participant.rs` 27–34 行）只有在身份等于这台设备、且 pipeline 尚未 `started` 时才会把返回值置真。返回值真的含义是「上一个远端 SID 的启动资源要丢掉」，不是「来了一个新 Worker」。身份是 `agent-jobB` 时函数直接返回假，不改当前设备 SID。`job.rs` 360–389 行在这个返回值为真时，对**同一个** `room.local_participant()` 做 unpublish/publish，日志 `startup participant replacement accepted` 的 `participant_sid` 是远端 `p.sid()`。Worker 进程、job id、本地 participant 身份都不变。

因此这条日志不能当作回执第 4 项的通过证据。它证明的是开麦前的远端设备 SID 切换。

`control.rs` 248–257 行的 `session.output_ready` 只有 `room` 和 `agent_track_subscribed=true`。没有 participant SID，没有 publication SID，没有 generation。注释写明它只是诊断，不是 Android 的门。SDK 不能靠这个包判断「当前 Worker publication」。

`worker.rs` 269 行的 `process exiting` 是这条 job 任务结束。历史 15 单都打了这一行，PID 仍是 `2750511`，下一单继续在同一 PID 上。它不是 Worker 进程被换掉。

## 2. 本轮读过的源码身份

| 对象 | 结果 |
|---|---|
| 工作树 HEAD | `119003bc507451e86e3f695071b92311341c8888` |
| `148107232d1792c2c39719113d49031c67170d13` | HEAD 的祖先。`job.rs` blob 两边都是 `0a09bb00f579455c827fb627338e8df681676b34` |
| 本轮读取的文件 SHA-256 | `job.rs` `471756738f09525358e1b7803f2c25f7102bdf55b6b2fa3f6700d2b1bbffc299`；`startup_participant.rs` `ebebde5e18647c3e56620f391876c024f0dd5afd65fa309755d073e9ba7e7961`；`control.rs` `17e659e03beef5f81fe732e40f2bfcb9a6bb86733b5d667709779a2bc971cff7`；`worker.rs` `c2a9724ef9b30f324fb3902a254fddbbe5c34f72ad31c9a24cb48adb440d430a` |
| Android `edf0beba7194a298edc55e7079dcaa6ee06a587a` | 本地 bare mirror 的 loose object 不存在，pack index 4323 个对象里也没有。`git cat-file -t` 触发了 promisor 查找，origin 不是可用仓库，对象没有取下来。本轮没有再发 fetch，没有读到 Android 源码 |

历史倾听进程 PID `2750511` 的二进制哈希不在提取里。下面的源码行号描述的是当前主树，用来规定注入判据。不能把这些行倒推成 11/06 那只 PID 的已部署字节。

## 3. 可执行的 SDK 注入判据

私有 SFU、现役二进制原字节、`WORKER_MAX_JOBS=1`、合成 SN、合成 LLM、真实 ASR/TTS。开跑前记录实际执行文件的 SHA-256，并和下面 runtime 节的目标哈希对照。agent 名当次唯一，不以 `p003-search-` 开头，也不等于现役主池或倾听池名字。房间名 `sn-<合成身份>-<毫秒>`，设备身份 `dev-<同一合成身份>`。下面两案分开记分。

### 3.1 案 D：远端设备 SID 切换

这一案测量 `StartupParticipant`。它的通过不会让回执第 4 项通过。

前置：一个 Worker 进程，一个 job，pipeline 尚未 `started`（还没有用户轨把 `started` 置真）。

步骤与通过条件：

1. 远端参与者以身份 `dev-<合成身份>`、SID1 进入。服务端可以记下 SID，但 `connected()` 第一次返回假。假表示「这不是一次替换」，SID 已经记下。
2. SID1 断开。日志是 `participant disconnected`，随后 `startup participant replacement grace armed`。3 秒宽限，且总预算不超过 60 秒。
3. 3 秒内同一设备身份以 SID2 进入，SID2 不等于 SID1。日志必须是 `startup participant replacement accepted`，其中 `participant_sid` 的后 8 位是 SID2，`agent_track_sid` 是新 publication。
4. Worker 的 OS PID、job id、本地身份 `agent-{job_id}` 保持不变。
5. 再订阅旧 publication：`decision=discard_sid_mismatch`，或者旧轨已移除后不再出现 `decision=accept`。只有新 publication 的首次 `LocalTrackSubscribed` 得到 `decision=accept` 和一条 `session.output_ready`。
6. 边界：先让用户轨把 pipeline `started`，再换 SID。`connected()` 返回假，旧 SID 离开得到 `Close`，job 结束，不得出现 `startup participant replacement accepted`。

SDK 侧只记录自己的 participant SID 变了。不要把这一案写成 Worker replacement PASS。

### 3.2 案 W：Worker participant 替换

这一案才对应回执第 4 项。远端设备 SID 在整个案里保持不变。

服务端要在**同一 room 名**里先后出现两个 Worker participant：

- 身份 `agent-{jobA}` 和 `agent-{jobB}`，两个 job id 不同。
- 两个 publication SID 不同。
- 两个 OS PID 不同。当前 `run_job` 在收尾时删房，所以不能靠「这一 job 结束后下一间新房」来制造这一案。私有 SFU 需要让第二个进程以 `agent-{jobB}` 加入仍存在的房间。若现役二进制做不到，结果写 `NOT_IMPLEMENTED`，不能改记成 PASS。

SDK 对每条远端音轨事件记录 `participant.identity`、`participant.sid`、publication SID 和决策。通过必须同时满足：

1. 设备 participant SID 的后 8 位在切换前后相同。
2. 出现过 `defer_unbound`。绑定从 `agent-{jobA}` 变为 `agent-{jobB}` 时有 `output_worker_bind decision=changed`。
3. `accept` 只落在 `agent-{jobB}` 的当前 publication 上。
4. `agent-{jobA}` 的 publication 在切换之后进入 `reject_*`，或者不再进入有效输出。这一轨即使还在推 PCM，渲染帧数也保持 0。
5. 切换之后被渲染的帧，其 publication SID 全部等于 jobB 的当前 publication。
6. 判定键是 Worker participant 身份加 publication SID。`session.output_ready` 不参与判定。只靠这个包放行的实现，本项失败。
7. 服务端可以没有 `startup participant replacement accepted`。即便出现，也不能拿它代替上面 1–6。

当前主源没有「同一 job 内换一个 Worker 进程并保留房间」的路径。案 W 测的是 SDK 合同和私有 SFU 能否把第二个 `agent-{job}` 送进同一房间。它不证明 `startup_participant` 已经实现了回执第 4 项。

## 4. 历史 15 条的重新计算

材料是 `worker-safe-v3.json`（SHA-256 `8d3e3d40abbf58640379e464eb2633c1d5a96040cf20b5e2c9e8f017740f67b2`）。`analyze-history.py` 把 `same_pid_exclusive_job` 写成常量 `true`。本轮按 `received job request` 到同 job 的 `process exiting` 重算了行号和时间：倾听窗内 17 个 job，全部 PID `2750511`，相邻 job 的行区间和时间都不重叠。15 条回执 job 是其中的子集。

15 条共同事实：

- 每条恰好一个 job、一个 room、一个远端 participant SID，身份后缀都是 `03800006`。
- `participant connected` 计数为 0。进房时已经在场的参与者不会再发这条事件。
- `startup participant replacement` 在整个倾听提取里是 0。`output gate` / `fail-closed` 是 0。`at full capacity` 是 0。`pipeline failed` 是 0。
- 每条都有 `room deleted` 和一条 `process exiting`。
- 历史订阅行没有 `agent_track_sid`、`event_track_sid`，也没有订阅 `decision`。提取里出现的 `decision=restated` 属于 `input_ready.request`，不是音轨接受。回执第 8 节第 2 问（Android accept 与 Worker publication 是否一致）这份提取回答不了。
- `brain-safe.json` 15 张签票状态都是 `ok`，TTL 3600，设备后缀只有 `03800006`。签票字段 `selected_agent` 是 `p003-search-listening-20261030`，`lease_max_jobs` 是 `2`，generation 是 `v374-listening-ark-20261102-1793613511`。`authority` 数组长度 0，这是保留期已过，不是历史未签票。`lease_max_jobs=2` 说明这 15 条没有跑在 max_jobs=1 的池上，串行也不能当成 capacity=1 的 PASS。

`tts provider first PCM observed` 计数：

| trace | job | room | provider 首包 | 播放终态 | 客户端回执 |
|---|---|---|---|---|---|
| `ed8d2643` | `gxds7ZTa` | `93957490` | 3 | SourceDrained 1988 帧 | FINAL_AND_ANSWER |
| `4de55d33` | `jqrxaqG7` | `93957543` | 4 | SourceDrained 2456 帧 | FINAL_AND_ANSWER |
| `88fc47d7` | `h93pWqMJ` | `93957583` | 1 | SourceDrained 540 帧 | FINAL_AND_ANSWER |
| `3f3fecf2` | `rZrSko55` | `93957601` | 1 | turn1 CaptureFailed 75 帧；turn2 SourceDrained 636 帧 | FINAL_AND_ANSWER |
| `03a2d982` | `sfkjmjRt` | `93957623` | 3 | SourceDrained 2368 帧；另有两次 connect `elapsed_ms=10001` `outcome=timeout`，发生在已观察到首包之后 | FINAL_AND_ANSWER |
| `cf3c3208` | `A5wBXBBD` | `93957662` | 0 | 见第 5 节 | FINAL_AND_ANSWER |
| `97dbcd79` | `JwGWXCjp` | `93957691` | 1 | SourceDrained 964 帧 | FINAL_AND_ANSWER |
| `363c8900` | `KfNdKVhL` | `93957714` | 1 | turn1 Aborted 0 帧；turn2 SourceDrained 612 帧 | FINAL_AND_ANSWER |
| `9f3cef3b` | `JxmKmSs3` | `93957734` | 7 | turn1 CaptureFailed 0 帧；turn2 SourceDrained 1892 帧 | FINAL_AND_ANSWER |
| `7438bf4b` | `pMCPPRd6` | `93957769` | 2 | SourceDrained 708 帧 | FINAL_AND_ANSWER |
| `e7262de5` | `FGx95FY9` | `93957922` | 3 | CaptureFailed 661 帧 | 聆听流程 |
| `e4d3ae97` | `LgoTXqMK` | `93958008` | 0 | 无 playout | INCOMPLETE |
| `e436605b` | `QXLNgLMX` | `93958066` | 1 | SourceDrained 624 帧 | FINAL_AND_ANSWER |
| `09e2af0f` | `2yYZNUhT` | `93958194` | 1 | CaptureFailed 479 帧 | 触摸退出 |
| `b815e6c0` | `RwemkGBj` | `93958214` | 3 | SourceDrained 1512 帧 | FINAL_AND_ANSWER |

10 条普通轮里，9 条至少有一次 provider 首包。`cf3c3208` 是 0。`03a2d982` 有首包，同时也有两次 10001 ms 建连超时，所以「有首包」也不等于「每次建连都成功」。客户端 `FINAL_AND_ANSWER` 不能当成 10 轮 provider TTS 全部成功。

当前源码里 `played_frames` 一帧是 10 ms、24000 Hz（`playout.rs` 412 行）。上表的帧数按这个定义可换成毫秒，但 11/06 的 PID `2750511` 没有二进制哈希，帧时长只作为当前树的读法。

## 5. `cf3c3208`：有超时，没有 provider 首包

job `A5wBXBBD`，17:34:23.486–17:34:50.113。整单 `tts provider first PCM observed` 为 0。

| 时刻 | 行 | 事件 |
|---|---|---|
| 17:34:30.579 | 686 | turn 1 `agent turn aborted`，`since_pipeline_ms=6501` |
| 17:34:30.580 | 694 | turn 1 playout `exit=Aborted`，`played_frames=0` |
| 17:34:31.078 | 704 | turn 2 `agent turn aborted`，`since_pipeline_ms=7000` |
| 17:34:31.081 | 714 | turn 2 `exit=CaptureFailed`，`played_frames=69`，`buffered_audio_ms=-1`。距 abort 3 ms |
| 17:34:32.079 | 722 | turn 3 `filler playout done` |
| 17:34:41.131 | 724 | `tts connection timing` `outcome=timeout` `elapsed_ms=10001` |
| 17:34:41.551 | 725–726 | turn 3 dispatch end `elapsed_ms=10000`；WARN `tts synthesize failed`。`field_keys` 含 `error`，字符串未保留 |
| 17:34:41.552 | 727 | 另一条建连 `outcome=cancelled` `elapsed_ms=9769` |
| 17:34:41.772 | 728 | turn 3 `exit=SourceDrained`，`played_frames=92` |
| 17:34:41.779 | 733 | `background search prepared receipt scheduled` |
| 17:34:41.829 | 735–736 | turn 4 `background search first audio published (device hearing unverified)`，同时 `body first frame published (no filler)` |
| 17:34:44.457 | 739 | turn 4 `exit=SourceDrained`，`played_frames=264` |
| 17:34:49.861 | 744 | `control cancel` `had_turn=false` `cancelled=false` |

失败行的 tag 里出现子串标记 `first PCM`，是因为收集器做的是子串匹配，而且 error 文本没有留在安全提取里。成功标记 `tts provider first PCM observed` 没有出现。

`SourceDrained` 在当前源码里表示播放通道关闭（`playout.rs` 447–450 行），`completed=true` 只表示自然把队列放完。turn 3 在垫句完成之后才等到 10 秒建连超时，随后合成失败，92 帧是这之前已经进播放器的音频。turn 4 的 264 帧紧跟搜索回执调度，日志写明 device hearing unverified。`body first frame published (no filler)` 的条件是 `audio_started` 且 `filler_samples==0`（`pipeline.rs` 2821–2828 行），它不检查 provider 首包。

客户端这条被标成 `FINAL_AND_ANSWER`。服务端证据停在：建连 10001 ms 超时、合成失败、provider 首包计数 0。SourceDrained、搜索回执和客户端完成都不能把这一条写成 TTS 成功。

## 6. `e4d3ae97`：收到了 3.12 秒音频，没有 final

job `LgoTXqMK`，17:40:08.851–17:40:18.998，时长 10147 ms。远端 SID `nsH4xUNK`。

| 时刻 | 事件 |
|---|---|
| 17:40:09.218 | `input_loop_started` `elapsed_ms=354`，`session.input_ready` |
| 17:40:10.835 | ordered `reason=no_final` `chars=0`，随即 `input phase → rtc` `reason=first_turn_no_task` `catchup_samples=0` |
| 17:40:10.916 | `input_ready.request` `decision=restated` |
| 17:40:11.946 | `UserSpeechStarted` 一次。之后没有 `UserTranscriptFinal`，没有 `turn committed` |
| 17:40:18.744 | `control cancel` `seq=96` `had_turn=false` `cancelled=false`。距 job 起点 9893 ms，距 no_final 7909 ms，距 `UserSpeechStarted` 6798 ms |
| 17:40:18.904 | 远端 participant 断开，随后 room deleted、`process exiting` |

ordered summary：`chunks_received=78`，`samples_received=49920`，`samples_queued=49920`，`packets_rejected=0`，`packets_total=80`，`speech_peak_rms=915.3`，`noise_floor_rms=46.8`，`trailing_quiet_at_end_ms=2000`，`end_ms=379`。78×640=49920。按 16000 Hz，49920 样本是 3.12 秒。峰值 915.3 高于噪声底 46.8，尾部有 2 秒静音。没有 `audio in (10s)` 是因为输入环 17:40:09.218 开始，job 在 9.78 秒时已经结束，10 秒桶还没到。

这条不能写成未收音，也不能写成纯静音。服务端收到了有能量的有序 PCM，因 no_final 切到 RTC，RTC 上出现过一次 `UserSpeechStarted`，然后没有 final。cancel 时没有 agent turn（`pipeline.rs` 2582–2584 行：`cancelled = first && had_turn`）。提取里没有足够证据把缺 final 单独归到 Android。

## 7. 五次 CaptureFailed 的时序

全倾听提取里 `CaptureFailed` 就是这 5 次。当前源码里它是 `capture_frame` 在重试窗口后仍失败（`playout.rs` 481–483 行），和 output gate 的 5 秒 fatal 不是同一条路径。这 5 次都没有 output-gate 文案。

| trace | abort 时刻 | CaptureFailed | 间隔 | 播放帧 | 同毫秒的客户端 cancel | 之后的 cancel |
|---|---|---|---|---|---|---|
| `3f3fecf2` | 17:33:29.677 turn 1，`since_pipeline_ms=6601` | 17:33:29.683 | 6 ms | 75 | 无 | 17:33:41.309，`had_turn=false` `cancelled=false` |
| `cf3c3208` | 17:34:31.078 turn 2，`since_pipeline_ms=7000` | 17:34:31.081 | 3 ms | 69 | 无 | 17:34:49.861，`had_turn=false` `cancelled=false` |
| `9f3cef3b` | 17:35:42.017 turn 1，`since_pipeline_ms=6901` | 17:35:42.018 | 1 ms | 0 | 无 | 17:36:07.787，`had_turn=false` `cancelled=false` |
| `e7262de5` | 17:40:05.428 turn 1，`since_pipeline_ms=81729` | 17:40:05.432 | 4 ms | 661，缓冲 197 ms | 同一毫秒 `control cancel` `had_turn=true` `cancelled=true` `seq=90` | 无第二笔 |
| `09e2af0f` | 17:43:27.469 turn 1，`since_pipeline_ms=12342` | 17:43:27.477 | 8 ms | 479，缓冲 206 ms | 同一毫秒 `control cancel` `had_turn=true` `cancelled=true` `seq=107` | 无第二笔 |

前三笔的客户端 cancel 在 CaptureFailed 之后 11.6 秒、18.8 秒、25.8 秒，而且 `cancelled=false`，因为当时已经没有可取消的 agent turn。它们不是这三笔 CaptureFailed 的触发包。`cf3c3208` 的 10 秒 TTS 超时在这笔 CaptureFailed 之后 10.05 秒，属于 turn 3，不是这笔 CaptureFailed。

`e7262de5` 和 `09e2af0f` 是客户端 cancel 与 `agent turn aborted` 同一毫秒，CaptureFailed 晚 4 ms 和 8 ms。两笔在失败前都已经有 provider 首包，分别播过 661 帧和 479 帧。`09e2af0f` 结束后 6980 ms，`b815e6c0` 以新 job `RwemkGBj`、新 room `93958214`、新远端 SID `CM8y8Wk5` 开始。这是下一间房，不是同一 job 内的 Worker 替换。

## 8. runtime 哈希复核

复核对象是 `worker-safe-v3.json.runtime`，并和 `worker-safe.json`、`worker-safe-v2.json` 的同一字段对照。本轮没有读现役 `/proc`，也没有重算磁盘文件。收集脚本对每个 unit 分别哈希 `/proc/<pid>/exe` 的字节和 `exe_path` 指向的磁盘文件。三份提取里的结果一致。

| unit | 收集时 PID | 状态 | 重启 | proc SHA-256 | disk SHA-256 | 路径 |
|---|---|---|---|---|---|---|
| `voice-worker-rust` | 4183959 | active | 0 | `8a9534897303b8f12406df47a51bf70dba8d26ef44efd56e27db4601f5ea50a9` | 相同 | `/root/rust-worker/voice-rust-worker` |
| `p003-listening-worker` | 4170463 | active | 0 | `517f5290eeb73486ccb3bcf86e16eec24bde5b6380d825851592c1f308f5f305` | 相同 | `/opt/p003-listening-canary-20261030/voice-rust-worker` |
| `p003-search-worker` | 2446060 | active | 0 | `56f6878f1a232139f8bba968af3a2331c03bb842ad87228a8f63a01ed77ec53c` | 相同 | `/opt/p003-search-canary-20261021/voice-rust-worker` |

v3 的 `read_at_ms=1794300688094`，即 2026-11-10 16:51:28 +08。proc 与 disk 每行都相等，说明收集那一刻进程映像和路径上的文件字节一致。历史 15 条的倾听 PID 是 `2750511`，主池 PID 是 `3179125`，都和上表不同。搜索池历史 PID 与上表同为 `2446060`，但 15 条不在搜索池。上表哈希不能写回 11/06 那 15 条的运行字节。私有 SFU 若使用主池或倾听池原字节，执行前的文件 SHA 必须分别等于 `8a953489…` 或 `517f5290…`，并把实际读到的 SHA 写进当次结果。

`livekit-server` 在这个历史窗的行数是 0。journal `MESSAGE` 字节数组 2831，解码失败 0。

## 9. 本轮实际跑过的测试

系统 `rustc` 是 1.70.0。未改过的 `startup_participant.rs` 含两处 `is_none_or`，这个编译器报 E0599，crate 级 `cargo test` 没有跑。

私有目录里的测试跑过，结果是 9 passed、0 failed：

- 源文件复制到 `grok-r2/startup_participant_r170.rs`。
- 仅把两处 `is_none_or` 改成 `map(...).unwrap_or(true)`，供 1.70 编译。业务树里的原文件未改。
- 保留原有 8 个测试，并增加 `agent_job_identity_is_not_remote_device_replacement`。
- 命令：`rustc --edition 2021 --test grok-r2/startup_participant_r170.rs -o grok-r2/startup_participant_r170`，然后运行该二进制。退出码 0。
- 该测试断言：身份 `agent-jobB` 不会让 `connected()` 返回真，也不会被 `accepts()` 接受；同一 `dev-SYNTH` 在开 pipeline 前从 `PA_old` 换到 `PA_new` 会返回真；`started` 之后再换 SID 返回假，离开得到 `Close`。
- 第一次编写时把「第一次 `connected()` 返回真」写成了断言，运行失败。返回值假才是第一次见到设备 SID 的合同。修正后 9 项通过。这个失败本身说明：不能把 `connected()` 的真值当成「参与者已被接受」。

## 10. 根因边界和最短后续

已经能定下来的边界：

1. 回执集合是 15 条，全在倾听 PID `2750511` 上串行完成并删房。没有 Worker 替换日志，没有 output-gate，没有满载拒绝。
2. `cf3c3208` 的 provider TTS 没有首包。10 秒超时和 `tts synthesize failed` 成立。后面的 SourceDrained 是垫句队列结束和搜索回执，不是 provider 正文成功。
3. `e4d3ae97` 的有序 PCM 已入队 3.12 秒且峰值明显高于噪声底。缺的是 final 和后续 TTS。现有字段不够把责任写成 Android 未送音频。
4. 5 次 CaptureFailed 是 abort 或客户端 cancel 的播放出口，不是 5 次 output-gate。
5. 回执第 4 项要求换的是 `agent-{job_id}` 这个 Worker participant。`startup_participant` 换的是 `dev-<sn>` 的远端 SID。二者的通过条件不同。
6. 今天收集到的 proc/disk 哈希彼此一致，并且和 11/10 清单里的主/倾听哈希一致。它们不是历史 PID `2750511` 的哈希。
7. Android `edf0beba` 的绑定实现本轮没有源码可核。案 W 的端上 `defer_unbound` / `accept` / `reject_*` 仍是未验客户端行为。

最短后续，只加在主 13 已经在做的私有 SFU 上：

1. 用第 8 节那两只原字节之一，先记录实际 SHA。`WORKER_MAX_JOBS=1`，独立 agent 名，合成身份，真实 ASR/TTS。
2. 先跑案 D，结果单独归档为设备 SID 切换。日志必须出现 `startup participant replacement accepted` 且远端 SID 改变、Worker 身份不改变。不要把这个结果写入回执第 4 项。
3. 再跑案 W。同一 room、同一设备 SID，第二个进程以另一个 `agent-{job}` 发布新 publication。按第 3.2 节的 7 条记分。房间被删掉以后的下一房，记为新会话，不记为替换。二进制无法把第二个 Worker 留在同一房间时写 `NOT_IMPLEMENTED`。
4. 历史 15 条保持本文件的结论，不再为它们重跑生产。四项异常在案 W 和另外三项隔离探针出结果之前继续是 `PENDING_SERVER_INJECTION`。

本轮没有生产变更，也没有新的回滚点。
