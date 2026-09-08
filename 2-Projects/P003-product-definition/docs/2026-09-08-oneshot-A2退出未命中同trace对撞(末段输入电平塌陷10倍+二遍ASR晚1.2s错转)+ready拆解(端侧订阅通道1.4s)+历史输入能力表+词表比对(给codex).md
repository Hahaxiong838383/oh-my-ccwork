# CC → codex：One-shot A2 退出未命中同 trace 对撞 + input_ready 拆解 + 历史输入能力 + 词表比对

日期：2026-09-08。状态：**REVIEWED，只读对账完成；本轮 CC 未改任何生产件（worker 二进制/env/服务端/设备 API 零变更）。**

先给结论：

1. **A2 trace 可检索（三站日志+EOT 快照全在）。退出没命中不是 worker 退出门、不是词表、不是超时口径，是「到达 worker 的末段输入电平比同房第一句低 ~10 倍」→ 二遍 ASR 判停晚 1.2 s 且错转 7 字 → final 落在设备已关房之后 34 ms。** 同一台 0010、同一 worker 版本、11 分钟前的「退出」（电平正常）全链 0.25 s 闭环，是正锚。
2. **wake→ready 4.222 s 里 worker 自己的路径只占 0.455 s**：2.45–2.51 s 是设备从 connect_start 到信令抵达 LiveKit（本设备今日 7 房里的离群值，中位 0.58 s），0.87–0.92 s 是设备的订阅通道（subscriber transport）在 worker 发出 input_ready 之后才 ACTIVE。三类设备今天 117 房「信令到达→ACTIVE」中位都是 1.4–1.5 s，这是 ready 链现在的地板，在端侧。
3. **历史输入：worker 今天没有任何 PCM 入站口（control 通道只认 JSON 事件）**，需要改 worker（新增一个入站类型 + 拼接到同一 VAD/ASR 输入链 + 一个 ack）。传输、鉴权、Room 入口全部复用现有，不新建 token，不搬鉴权。**能力表见 §5，确认前不算接通。**
4. 词表：退出 39 词全部可达（35 exact + 4 走 fragment 桶）；**STOP 表两边差异大（交集 3 词），先列出等拍板，本轮不动。**

---

## 1. 生产锚与可检索性

| 项目 | 实取值（2026-09-08 16:38–16:57 CST 实读） |
|---|---|
| Worker 机 | 企航云 HK `64.90.13.117`，unit `voice-worker-rust`，MainPID 2017631，ActiveEnter **2026-09-06 23:49:55 UTC**（=09-07 07:49:55 CST），未重启 |
| Worker 二进制 | `/root/rust-worker/voice-rust-worker` 72137496 B，**sha256 `f3707e7eae7e3a42def95a615d50d782227a1ccc688e7c78557321df1bf9d8ba`**，md5 `5d57239ad5e264ce7f112819aad44c30` |
| Worker 源码 commit | **`3a2af41c3`**（feat/rust-worker，2026-09-07 07:48 CST「pipeline 预组装」）——本文引用的源码行全部读自该 commit 的 worktree，与二进制同源 |
| Worker 配置 revision | 三层 EnvironmentFile：`.env` md5 `1b836ebcd691`(2026-07-16) → `poc-eou.env` md5 `43e2c804b2bd`(2026-08-18) → `rust-worker.env` md5 `d0bd41227675`(**2026-09-03 14:49**)；进程 environ 实读关键值：`WORKER_MAX_JOBS=10` `ECHO_SUPPRESS_WINDOW_MS=800` `SESSION_EXIT_SIGNAL_ENABLED=1` `SESSION_EXIT_SIGNAL_CANARY_SN=`(空=全部 `sn-` 设备房启用，非 sn- 房永不启用，源码 device_intent.rs `commands_gate`) `EXIT_TAIL_MATCH` 未设=默认开 |
| LiveKit | `47.239.204.68` livekit-server 1.13.2，本机 CST；chrony 偏差 +50 µs |
| P003 服务端 | aliyun-hk `8.218.26.17` pm2 `p003-voice`，chrony 偏差 +88 µs |
| 三机对时 | 三台 NTP 同步且互差 <1 ms，**下文 worker/LiveKit/服务端时间统一按 UTC（Z）**，CST = +8 h |
| A2 trace | `98ac45ae-2c20-4ba6-b79e-05b00728419e` → 房 `sn-…0010-1788852838`（建房 07:33:58Z）→ job `AJ_tSUnAbWwGmNT` → EOT 快照 job `20260908T073402-c50020`（2 段） |
| 检索位置 | worker `journalctl -u voice-worker-rust`（33 行带房标 + 同窗未带房标的 VAD/ASR/契约行；窗内另有 Ultra …1700006 两房，已按 job 生命周期分离：前一 job 07:33:43.567Z 已 `process exiting`，后一 job 07:34:37.955Z 才起，A2 存活期 07:34:01.7–17.13Z 内 worker 只有这一个 job，未带房标的行归属无歧义）；LiveKit `journalctl -u livekit-server` 28 行；p003 `[device-session] ok … trace=98ac45ae… ms=3`（pm2 日志无时间戳，签发时刻由 worker 上报的 `issue_to_assignment_ms=2822` 反推为 07:33:58.891Z）；音频 `64.90:/root/eot-snapshots/20260908T073402-c50020/t000{0,1}.wav` + `events.jsonl`（只存本机，不外发） |

LiveKit 里两条 `not dispatching agent job since no worker is available`（JT_PARTICIPANT / JT_PUBLISHER）是 roomConfig.agents 按 job 类型逐个试派、worker 只注册 JT_ROOM 的正常噪声，JT_ROOM 那条 07:34:01.708Z 正常派出。

---

## 2. P0：A2「说了退出但未命中」同 trace 对撞

### 2.1 端侧钟 ↔ 服务端钟（两锚夹逼，不做单锚减法）

设 δ = worker 钟 − 设备钟（设备慢为正）。

- 锚 A（worker→设备）：worker `AgentSpeechStopped`/`state speaking=false` 07:34:11.4679Z，设备记 `speaking=false` 15:34:10.716 → δ = 0.752 + 单程 ≥ **0.752 s**
- 锚 B（设备→worker）：设备 15:34:16.187 发 cancel，worker 07:34:16.9998Z 收 → δ = 0.813 − 单程 ≤ **0.813 s**
- 第三条独立锚：p003 遥测批次 `[telemetry] batch sn=****0010 … skew=810ms`（= server_received − device_ts，含上传单程，是上界）；最近 12 批 850–856 ms。

**δ ∈ [0.752, 0.813] s（设备钟慢 ~0.78 s），两锚之间总单程 61 ms。** 下文设备时刻换算写成区间。⚠️ 昨天 0006 量到的是 0.27–0.33 s，**每台设备各算各的**，别复用。

### 2.2 统一时间线（服务端/worker 钟，UTC；设备行按 δ 换算）

| 时刻 (Z) | 来源 | 事实 |
|---|---|---|
| 58.81–58.87 | 设备 15:33:58.059 | 硬件唤醒 |
| 58.891 | 服务端(反推) | token 签发 `issue_ts_ms` |
| 58.98–59.05 | 设备 58.230/.234 | Session 绑定 / Room connect_start |
| 00.27–00.33 | 设备 59.513 | greet 播放头完成 |
| **01.503** | LiveKit | **设备信令抵达（starting RTC session）**——距 connect_start **2.45–2.51 s** |
| 01.708 / 01.713 | LiveKit / worker | JT_ROOM 派单 / worker `job_assignment_received issue_to_assignment_ms=2822` |
| 01.73–01.80 | 设备 00.982 | Room 连接返回、解除 capture 静音、microphone_enabled（此刻 SFU 上还没有设备麦轨） |
| 01.910 | LiveKit | 设备 PUBLISHER ICE 选中直连 UDP（remote prflx，无 TURN） |
| 01.953 | worker | `worker_room_connected connect_ms=239`（ASR 已于 01.957 预连成功，`pipeline prebuilt` 01.936） |
| 01.98–02.05 | 设备 01.232 | input_ready_fallback |
| 02.003 / 02.044 | worker / LiveKit | agent 出声轨发布 |
| **02.068** | LiveKit | **设备麦轨 `mediaTrack published`**（信令后 565 ms；比设备自记 microphone_enabled 晚 0.27–0.34 s） |
| 02.166 / 02.168 | worker | `user_track_subscribed`(+98 ms) → `input_loop_started track_to_input_loop_ms=1` → **`session.input_ready published`（只发一次，源码 `input_ready_fired`）** |
| 02.213 | worker | 收到设备 capability（`l2 capability … contract_version=2`）——设备→worker 的数据通道此刻已通 |
| **02.910** | LiveKit | **设备 `participant active`（订阅通道 ACTIVE）**——信令后 1.407 s |
| 03.03–03.09 | 设备 02.278 | 可信 input_ready 到达（距 worker 发布 0.87–0.92 s） |
| 03.031 → 03.04–03.10 | worker → 设备 02.283 | `agent_track_subscribed_by_android` → `output_ready` 发布 → 设备收到（单程 ≤70 ms，说明 03.0 以后数据通道单程是正常的） |
| 05.522 | worker VAD | speech_start（第 1 句） |
| 06.098 / 06.202 / 06.296 | worker | eot_request（speech 0.51 s，silence 224 ms）/ speech_end / eot_prob 0.61 accepted |
| 06.546 / 06.569 | worker | `stt final: 测试一下`（二遍 definite，距 eot_prob **250 ms**）/ `turn committed eou_ms=687 stt_ms=663` → filler(gen 桶 2040 ms) → LLM ttft 1200 ms → TTS 11 字(含称呼，正文不入文) 2840 ms |
| 06.55–06.61 | 设备 05.797 | 「local final」4 字——与 worker 06.546Z 经 LiveKit transcription 下发的 user final 时刻吻合（推断：它就是 worker 的转写，不是端侧 ASR） |
| 11.4679 | worker | 播完 `SourceDrained`，speaking→listening（锚 A） |
| 12.169 | worker | `audio in (10s) frames=1001 mean_amp=56`（覆盖 02.17–12.17，含第 1 句） |
| **15.539** | worker VAD | **speech_start（第 2 句）**——设备钟 14.73–14.79，距 speaking=false **+4.0 s**，距设备超时截止 **−1.4 s** |
| 15.799 / 15.892 / 15.926 | worker | eot_request（**speech_s 0.19**，silence 224）/ speech_end / eot_prob 0.58 accepted；**该段零 interim** |
| 16.93–16.99 | 设备 16.182 | `session_end_requested reason=idle_timeout idle_ms=5465`（= 10.716→16.182 分毫不差，**端侧计时器中途从未被重置**） |
| 16.9998 | worker | `control cancel seq=14 cancelled=false already_done=false had_turn=false` + `cancel.ack` 已发 |
| 17.072 / 17.080 / 17.084 | LiveKit / worker | 设备 `CLIENT_REQUEST_LEAVE` / `participant disconnected → closing job` / EOT `job_end snapshots=2` |
| **17.118** | worker | **`stt final: 完成了创业大师`（7 字，距 eot_prob 1.192 s，晚于 job_end 34 ms）→ 无 commit、无吞句、无信令（journal 零此类行）** |
| 17.131 / 17.156 | worker | room deleted / job closed uptime 15 s / asr ws closed |

### 2.3 五问逐条

**① 末段输入。** worker 到关房前一直在收帧（10 s 水位 1001 帧）。最后一段可消费输入：VAD 起点 07:34:15.539Z、判停请求 15.799Z（speech 0.19 s）、speech_end 15.892Z。能量（worker 侧 16k mono s16 环形缓冲，100 ms RMS，与第 1 句同一把尺）：**第 2 段 RMS 13–33，8 s 窗峰值 278；第 1 句「测试一下」RMS 116–652，峰值 2183。** 8 s 窗（07.80–15.80Z）里：播报期间 RMS 5–11（端侧 AEC 把回声消得很干净）；播完紧接着 11.6–12.1Z 有一段 RMS 25–63、约 0.5 s 的隆起（设备钟 10.8–11.3，即回答刚结束那一下）；14.6–15.4Z RMS 13–34；然后才是 VAD 咬到的 0.19 s。**是：回答结束后 worker 收到了新的输入，但电平只有同房第 1 句的 1/10。** 音频只在 64.90 本机（路径见 §1）。

**② ASR 链。** 一遍流式对第 2 段零 interim；EOT 模型 accepted；二遍 definite final 17.118Z，文本 7 字、与任何退出词零重合、与 0.19 s 的 VAD 段长不相称（低电平段上的错转/幻觉，不是可用转写）。**被丢弃的阶段是「final 晚于关房」：** 到达时 job 已 end，commit 门根本没跑——短词过滤/回声门/端点/投机撤销一个都没参与（这些都在 commit 之后）。二遍判停延迟对照：同房第 1 句 250 ms、07:23 正锚「退出」359 ms、本段 **1192 ms**；判停由火山端点自己决定（worker 只在整个 job 输入结束时发一次 NegativeSeq 收流，不按 VAD 发段尾，源码 stt_volc.rs），弱段判停慢在火山那侧。

**③ 退出吞句与通知。** 本 trace 没走到退出判定，无从谈通知。按源码（3a2af41c3）写清现行行为，供合同对表：命中 SESSION_EXIT 时 worker **依次**：(a) LiveKit transcription 的 user final（identity=dev-…，final=true）——它在 `on_final` 里先于词表判定发出，所以 Android 一定能看到这句文本；(b) `control` topic（reliable+ordered）发 `session_exit_detected`，payload 只有 `reply_kind`(night/goodbye/general)+`path`(exact/tail/fragment)，同 seq 每 800 ms 重发至多 3 发，收到 `session_exit_detected.ack`/对方 cancel/房关闭任一即停；(c) 若有在播 agent turn → hard abort → `state {"k":"speaking","speaking":false}`；(d) 不发 UserTurnCommitted、不起 filler/LLM/TTS；(e) 不关房，收到 cancel 回 `cancel.ack {cancelled, already_done}`。没有第二种「生命周期结束」事件。**正锚（同设备同版本，11 分钟前，trace `d9c499b1-97f3-4011-9123-fc42875d44e5`，房 …2172）：** 07:23:03.110Z final「退出」→ .125 swallowed path=exact → .1256 signal sent seq=1 reply_kind=general → .2757 设备 cancel（+150 ms）→ .3277 断房 → .3724 job closed。

**④ 没有输入的分支。** 不成立——worker 有第 2 段输入。可缩小的范围：**端侧采集/声学/用户距离与音量**，三者 worker 侧无法区分。不断言用户没说，也不断言用户说了什么。

**⑤ cancel 幂等。** seq=14 首见（already_done=false），`had_turn=false`（那一段还在 ASR 里，没有成 turn）→ `cancelled=false` 合法且已 ack。迟到 final 落在 job_end 之后没有产生任何 commit/信令，**无迟到复活**；序列 cancel(16.9998) → 断房(17.080) → job_end(17.084) → 迟到 final(17.118，丢弃) → room deleted(17.131) 单调。

### 2.4 同设备今日各房的电平序列（worker 侧同一把尺）

| 房（建房 Z） | 事件摘要 | 用户语音电平（100 ms RMS 峰 / 样本峰） |
|---|---|---|
| 07:13:35 | 2 次 VAD 起点、**0 条对应 final**（上游整段丢弃形态，另案） | 5869 / 14295 |
| 07:22:53 | 第 1 句 6 字 commit；「退出」exact 吞句+信令，0.25 s 闭环 | 第 1 句 2454；「退出」段 433–591 / 2314 |
| **07:33:58（A2）** | 第 1 句 commit；第 2 段 0.19 s，final 晚 1.2 s 且错转 | 第 1 句 **652** / 2183；第 2 段 **≤63** / 278 |
| 07:37:55 | **0 次 VAD 起点、0 段快照，却有 5 条 final（1/2/1/4 字）4 次 commit** | 低于 worker VAD 门（Silero），火山仍转出碎片 |
| 08:22:56 | 只有 1 个开场单字被回声门吞 | — |

从 07:13 到 08:22，到达 worker 的用户语音电平单调塌陷（5869 → 2454/591 → 652/63 → VAD 不触发）。**这是端侧或用户侧的量，B1 探针（采音回调能量）正是对它的直接观测。** 07:37 那房「VAD 不触发但 ASR 有 final」说明电平已低到 worker VAD 门之下、而火山模型仍在给碎片——那种状态下任何短指令都不可靠。

### 2.5 反事实（推断，不进结论）

若第 2 段判停延迟按正锚的 0.36 s：final ≈ 16.29Z → 吞句+信令 ≈ 16.30Z → 到设备约 15.5（设备钟），比端侧超时截止（16.182）早 0.68 s，大概率赶得上。实际 1.19 s → 17.12Z，已在设备离房后 0.13 s。**低电平同时造成了两个失败：判停慢 3.3 倍 + 文本错转（就算准时到也不是「退出」）。**

### 2.6 关于超时口径与一个设计缝

- 服务端配置注册表没有 idle 类键（`apps/server/src` 全量 `rg -c 'idle_timeout|session_idle'` 零文件命中，非截断检索），Android 读 null → v242 默认 5000 ms 生效，与你本机核对一致。**同意不用延长超时来遮缺失 final。**
- 设计缝（列出不动）：端侧空闲计时器只认本地信号，worker 的 VAD 起点对它不可见；worker 也没有「用户在说」的状态提示（`state` topic 今天只有 `speaking`）。本地 VAD 漏掉低电平语音时，端侧超时与 worker 在途识别就是一场赛跑。两个最小合同候选，单变量、不与 One-shot 混发：(a) worker 在 VAD 起/止时发 `state {"k":"user_speech","active":true|false}`，端侧 active 期间挂起空闲计时并给 final ≤1.5 s 宽限；(b) 端侧超时前先发 `session_end_intent`，等 worker ≤300 ms 回 `turn_in_flight` 再断。**需要不需要，等川哥与你拍板。**

---

## 3. P1：input_ready 4.222 s 拆解

### 3.1 A2 单房（服务端单调钟）

| 区间 | 值 | 计时定义 / 证据 |
|---|---|---|
| 唤醒 → token 签发 | 0.02–0.08 s | 设备 58.059(换算) → issue_ts 58.891Z |
| token 签发 → 设备信令抵达 LiveKit | 2.61 s（其中 **connect_start→信令抵达 2.45–2.51 s**） | LiveKit `starting RTC session` 01.503Z。**本设备今日离群**：0010 今日 7 房 issue→assignment = 480/511/528/584/621/899/**2822** ms |
| 信令抵达 → 派单 → worker 接单 | 0.205 / 0.210 s | LiveKit 在设备进房时按 roomConfig.agents 派单；**无排队、无冷启动**（进程 09-06 起未重启，prebuild 在接单瞬间起） |
| 接单 → worker 进房 | 0.239 s | 与设备 PUBLISHER ICE（01.910）并行；**不叠加** |
| 进房 → agent 轨发布 | 0.05 s | 02.003Z |
| 设备麦轨到 SFU | 02.068Z（信令后 0.565 s） | 设备自记 microphone_enabled 比它早 0.27–0.34 s——**那段时间说话，SFU 上没有轨，LiveKit 不补帧** |
| SFU 有轨 → worker 订到 → 首帧入环 → input_ready 发布 | 0.098 s + **1 ms** | 02.166 → 02.168Z；ASR 于 01.957Z 预连成功（早于首帧 0.21 s）；ready 前无积压、无媒体丢弃策略（帧一到就进 VAD/ASR） |
| input_ready 发布 → 设备可信收到 | **0.87–0.92 s** | worker 只发一次；设备订阅通道 ACTIVE 在 02.910Z（LiveKit）。推断：包在 SFU 侧等到设备订阅通道建立才送达（未读 SFU 源码）。同通道 03.03 之后的 output_ready 单程 ≤70 ms，说明不是网络慢 |
| 合计 | 4.22 s ✓ | 端侧/网络 3.4 s（2.5 + 0.9）+ 派单 0.2 + worker 0.455 + token 0.05 |

### 3.2 近期样本（同配置，worker 自 09-06 23:49Z 起 235 房，全部热态；今日 121 房）

worker 视角（ms，中位/P95/最大）：

| 设备 | n(今日) | issue→assignment | worker connect | assignment→user_track | assignment→input_loop | assignment→output_ready |
|---|---|---|---|---|---|---|
| ****0006 | 78 | 647/875/22741† | 172/249/450 | 594/1227/2410 | 600/1236/2414 | 1374/1716/2393 |
| ****0002 | 36 | 657/1445/1831 | 171/318/522 | 718/1708/2396 | 729/1710/2406 | 1486/2206/2578 |
| ****0010 | 7 | 584/2245/2822 | 239/388/437 | 408/502/523 | 413/509/533 | 1317/1357/1367 |

† 0006 那个 22.7 s 是一次 token 签发后很久才进房的个例，不代表连接。

LiveKit 视角（设备侧，服务端钟，ms，中位/P95/最大）：

| 设备 | n | 信令抵达 → 设备麦轨发布 | 信令抵达 → 设备 participant ACTIVE |
|---|---|---|---|
| ****0006 | 77 | 737/1363/1780 | **1435**/1703/2239 |
| ****0002 | 33 | 850/1856/2529 | **1538**/2082/2256 |
| ****0010 | 7 | 511/562/566 | **1408**/1451/1458 |

三类设备「信令→ACTIVE」都稳定在 1.4–1.5 s，且 assignment→output_ready 中位 1.3–1.5 s 与之同源。**这是 ready 链现在的地板，worker 碰不到（Android SDK 2.27.0 订阅 PeerConnection 建立耗时，怀疑 ICE 候选收集/中继等待，请端侧核）。**

### 3.3 最小优化项（不新增常驻大服务、不加每设备账号；Session API/鉴权/零 PCM 预发布/可信 input_ready 语义全部保持）

| 项 | 谁 | 改什么 | 预计影响（基于上表） |
|---|---|---|---|
| S1 显式派单 | 服务端（可独立灰度，per-SN） | device-session 签 token 时同步 `AgentDispatchService/CreateDispatch`，token 去掉 roomConfig.agents 防双派；worker 加「设备 10 s 未进房关 job」守卫 | worker 在设备进房前已在房里：派单 0.2 + 进房 0.24 + 出声轨 0.05 全部退出关键路径，assignment→input_ready 455 ms → ≈100 ms（设备麦轨发布+SFU 转发）。A2 4.22 → ≈3.7 s；0010 中位房 ≈2.6 → ≈2.2 s。**收益封顶在端侧 1.4 s ACTIVE 之下** |
| 连接离群 | 端侧 | 把 SDK connect 拆成 DNS/TCP/TLS/join 子阶段打点；信令 TLS 会话预热或复用 | 本次 2.5 s 是离群（中位 0.58），先量再改 |
| 订阅通道 1.4 s | 端侧 | 查 ICE 候选收集/中继等待、connect() 返回与订阅通道 ACTIVE 的先后 | 这是全体样本的固定成本，压掉它才是 ready 的大头 |
| worker | 无 | track→input_loop 已 1 ms，ASR 预连领先首帧 0.2 s | — |

**「收到零帧/Room connected ≠ 历史音频入口 ready」同意**：worker 的 input_ready 只在输入循环真收到首帧才发（源码 pipeline.rs `input_ready_fired`），此前不接受任何输入语义。

---

## 4. 词表与不变项比对（本轮两侧都没改词）

### 4.1 退出词

- worker 生效表 = 进程 environ `EXIT_SWALLOW_HOTWORDS` **35 词**，按你的规程（Unicode 排序、LF 连接、末尾 LF、UTF-8 SHA256）= `0246e10d66c61db6430eadab65ddb0bfd0df4d9755bf09f12ad17b6be9cbdf2a`。
- 你的 39 词按同规程我算得 `894ad2c5…1915ed44`，**与你给的一致**，规程对上了。
- 差集 = 你多 4 词：`不想聊 / 我不想聊 / 不想聊天 / 我不想聊天`。worker 侧这 4 个不在 exact 表，但**尾表 `STRONG_EXIT_TAILS` 含 `不想聊天`/`不想聊`（人称前缀剥离后句尾命中）→ 走 `path=fragment`**，所以 **39/39 可达：35 exact + 4 fragment**。差异只在信令 `path` 取值，不在命中与否。
- worker 额外有、Android 不一定有的判定：尾表 13 词（退出对话/结束聊天/结束对话/不想聊了/我要睡觉了/去睡觉了/我要休息了/不想聊天/不想聊/不聊了/退出/再见/拜拜）+ 尾语气词逐层剥离（吧呀啦哦咯喽呗嘛哈啊哟呢了）+ 否定豁免（不/别/没 紧邻或双字否定在 3 字窗）+ 疑问豁免（怎么/如何/为什么/什么/吗/能不能/可不可以/要不要/还是）+ exact 前的语气前缀剥离（好/那/嗯/哎，≤2 字）。负锚「退出后告诉我怎么重新进入」含「怎么」→ 不吞（单测锚在 textproc）。
- AMBIGUOUS 11 词 worker 一律当普通句，与你一致。

### 4.2 STOP_ONLY（差异大，先列出）

- worker 生效表 = environ `INTERRUPT_HOTWORDS` **7 词** `停,停止,停停,停下,停一下,等等,等一下`（env 覆盖了内置默认 10 词，内置里的 别说了/别说/闭嘴/安静 被覆盖掉了）。SHA256 `af1f1054…8332a9`；你的 17 词 `dc807378…5273bb`。
- 交集 3：停 / 停止 / 停下。
- **你有我无 14**：不要说了 / 不要说话了 / 不说了 / 停下来 / 停止播放 / 停止说 / 先不说了 / 别再讲了 / 别出声 / 别说了 / 安静 / 安静点 / 暂停 / 闭嘴。worker 对这 14 个的行为：0 字打断门会打断在播（`MIN_INTERRUPTION_WORDS=0`），**但随后按普通句 commit → filler + LLM 回答**（例：「暂停」会得到一句回话）。若 Android 本地已按 STOP 处理，两侧就是 8-17「退出」同款幽灵轮赛跑。
- 我有你无 4：停停 / 停一下 / 等等 / 等一下——worker 吞句静默并中止在播，端侧即使不认也不会错。
- 建议：STOP 表单一真源、两侧同表（与退出词同一发布纪律）。**本轮不动，等拍板。**

### 4.3 不变项（worker 侧现状，按 §5 清单逐条）

打断由 worker 权威判定且 0 字门、假打断 0.7 s 恢复 ✓｜咳嗽/嗯/任意 VAD START ≠ 停（只有 normalize 后整句等于急停词才吞）✓｜「停」只中止在播、房间保留 ✓｜明确退出只吞句+信令，关房归 Android ✓｜纯退出零 filler/LLM/TTS（commit 前 early return）✓｜`cancel.ack` 在 control 处理器内同步先发（本轮无 barge 样本，未实测）｜无固定开场白（`开场白已关闭,保持 Listening`）✓｜音色 xfyun `x6_lingxiaoxuan_pro`、worker 不碰端侧 APM ✓｜不拉旧 MyJavis 链（Python voice-worker 09-07 已 stop+disable，LiveKit 只剩 rust-worker 注册）✓｜断网本地 VAD 兜底=端侧。

---

## 5. One-shot 历史输入：能力表（确认前不算接通）

worker 今天的数据通道入站解析（control.rs）只认 JSON 事件：`cancel / wake(capability) / vad / command_word / canary.say / session_exit_detected.ack / device.command.result`，其它一律 `Bypass`。**没有任何 PCM 入站口**。下面每项按现状回答。

| 项 | 回答 | 现成入口 / 改动点 |
|---|---|---|
| 收 16k mono s16le 带索引历史 PCM | **需改动（worker）** | 复用**现有受认证 Room 的 reliable 数据通道**（设备 token 已有 canPublishData，今天的 control 消息就走它），单包 ≤15 KiB（LiveKit 限制）= 480 ms 音频，2 s 历史 = 5 包。不建新 token、不建新 endpoint、鉴权不动。worker 新增一个入站类型（建议 `preroll` on 新 topic `audio_preroll`，不与 control 混）+ 一个出站 `preroll.ack` |
| 历史与实时同一有序 ASR 输入 | **需改动（worker），设计可满足** | 输入循环起点：先喂 preroll 再接实时帧，同一路 VAD→火山 ws；不另开一路。ws 是连续流、按帧推，快于实时的突发推送火山端是否照单接收是**前提待验**（可用 worker 侧离线探针验，不需真机） |
| 快于实时：chunk/吞吐/缓冲上限/背压/缺片重复 | **需改动** | chunk=480 ms/包，seq+total 编号；worker 缓冲上限 3 s（超出丢最旧并标 `truncated`）；无背压需求（5 包）；缺片/乱序/重复 → 该 preroll 整体作废 fail-open 回今天路径；**`SDK send 成功≠worker 已接受`：以 `preroll.ack{accepted_next_sample}` 为准** |
| 就绪/输入代次/接受水位语义 | **可复用现合同信封，需加 1 个 type** | 信封已有 `trace_id/session_id(job metadata)/seq`；新增字段 `input_id/start_sample/sample_count`，ack 回 `accepted_next_sample`。不发明新 endpoint |
| cancel/超时/断线后旧片、旧 ready/ack 不复活 | **结构上成立，需改动补 dedup 键** | 一切 preroll 状态是 job 作用域（job 关即销毁，本轮 A2 也证明 job 外无残留）；cancel 到达即丢弃未拼接的 preroll；dedup 键 `(trace_id, input_id, seq)` 复用现有 `ctrl_dedup` 机制。业务幂等仍归 Game/设备执行链，worker 只喂 ASR |
| pre-roll 内唤醒前旁人话不执行 / 边界 | **YES（双侧裁切）** | 设备按自己知道的边界裁（无 greet：唤醒词尾偏移；有 greet：g_end−300 ms），只发 `keep_from` 之后；worker 再按包内 `keep_from_ms` 二次裁，之前的样本不进 ASR。**不按 UART 到达时间切、不全局删「小可」**：残余 ≤300 ms 里的唤醒词尾碎片交现有开场窗单字回声门（只吞单字）；「不要/停/退出」等短指令在 keep_from 之后完整保留。**边界不可靠 → 端侧不发 preroll（fail-closed 到今天路径），不是 worker 猜** |
| 预算 2 s 历史 + 5 s 等 ready | **YES，但不要等 ready 再发** | worker 的 control 通道在 job 层缓冲，**事件可先于 input_ready 到达**（源码 pipeline.rs 注释与早说空窗实证）。所以 preroll 应在 Room 连上（发布通道打开）后立即发，覆盖 [keep_from, 麦轨发布时刻]，实时轨紧接其后——**与实时帧天然连续，无依赖环**。worker 输入循环起来时 preroll 已在缓冲，直接拼；若 preroll 晚于首个实时帧到达，worker 给 ≤400 ms 宽限（此期间实时帧暂存不丢），超时 fail-open |
| 首句实时性代价 | 1 倍速不成立 | 5 包突发 + 本地 VAD 追赶都远快于实时；ASR 端接收突发若被证实，首句延迟增量 ≈ preroll 时长的 ASR 处理时间（火山按音频时长计，约 +0.1–0.3 s），不是 2 s |

⚠️ 一个真实冲突（昨天预滚设计里的 400 ms 宽限锚在「首个实时帧」）：A2 这类房设备要在 worker 首帧后 0.9 s 才知道 ready，若 preroll 等 ready 再发必然超宽限而作废。**上表已改成「连上就发、不等 ready」，请按此定合同。**

---

## 6. 需要 codex 补的观测 / 真人重测

1. **B1 探针开着重测（需真人）**，同一距离、同一音量，每轮一个 trace：
   - 话术 A（3 轮）：唤醒 → 「测试一下」→ 回答结束后 **≈1 s** 说「退出」。
   - 话术 B（3 轮）：同上，但回答结束后 **≈3.5–4 s** 说「退出」（复现 A2 的时点，考端侧超时赛跑）。
   - 每轮记：设备单调钟上「退出」开口时刻、B1 回调 100 ms 能量序列、本地 VAD 有无 START、trace_id。我按房拉 worker/LiveKit/EOT 快照，用 §2.1 的两锚法对时后把 B1 能量与 worker 环形缓冲 RMS 逐 100 ms 对齐——**同一段语音在端侧回调和 worker 入口各是多少，一张表就能定「采集/传输/声学/用户」四选一**。
2. **端侧回答两件事**：(a) A2 里设备钟 14.7–15.1 那段，本地 VAD 有没有 START？（idle_ms=5465 说明计时器没被重置）(b) 空闲计时器的重置条件是本地 VAD START 还是 final？
3. **07:37:55 那房**（设备钟约 15:37:00–15:37:50）：请看端侧当时的采集能量和 AGC/增益状态——worker 侧全程零 VAD 起点却有 5 条 final，若 B1 显示回调能量正常而 worker 侧极低，问题在编码/传输；若回调能量也极低，问题在采集/声学。
4. 连接离群 2.5 s 与订阅通道 1.4 s：请给 SDK connect 子阶段打点（§3.3）。
5. 词表：STOP 表 14 词差异等拍板，我不动。

**本轮 CC 未做的事（明确）**：未部署预滚/显式派单，未改 env/词表/超时，未装任何设备、未调用设备 API。

署名：cc（Claude）| 2026-09-08 17:00 CST
