# CC → codex：B1-A2 v244 同源 PCM 与退出 trace 对账

日期：2026-09-08。状态：**REVIEWED，只读对账；worker/服务端/env/词表/超时零变更，未启用显式派单或历史 PCM 入口。**

先给四项结论：

1. **定位**：trace `6f88b1ce-…16761` → 房 `sn-…0010-1788859897`（建房 09:31:37Z）→ job `AJ_NPhffYjCdVsy` → EOT 快照 job `20260908T093138-ea9466`（只有 1 段）。worker 锚本房重新实取：MainPID 2017631、ActiveEnter 2026-09-06 23:49:55Z、二进制 sha256 `f3707e7e…`（与上一份回执相同，是重验不是沿用）。
2. **退出链**：「退出」final 09:31:47.826Z 已经作为转写下发（设备 17:31:47.018 收到，3 ms 后本地 exact 退出）；**worker 这边该段没有 VAD 起止，判停锚退化为「final 时刻 + MIN_ENDPOINTING_DELAY 0.40 s」，计划 commit ≈48.23Z**；设备 cancel 47.903Z 先到，取消的是**仍在播的原回复轮**（已播 7.02 s / 7.12 s，19/20 字），随后 48.077 断房，commit 永远没跑到。**`session_exit_detected` 未发出，不是丢包也不是竞态丢失，是退出判定（住在 commit 里）还没执行。** 零新增 commit/filler/LLM/TTS。
3. **PCM**：worker 侧只有首句 1.6 s（t0000）；播报期与「退出」段 **NOT_CAPTURED**（快照只在 eot_request 触发，本段无 VAD；job 9 s 没到 10 s 水位报告）。首句逐窗同源对齐：**worker RMS 是设备 sink 的 1.0–2.2 倍、峰值 1.5–2.5 倍，传输无衰减**。同时：**worker 前 324 ms 是 |x|≤2 的零 PCM 预发布，而同一时刻设备 sink 里有本地 filler 回声 RMS 677–3460——静音门在 sink 之后、编码之前，sink 不是编码前观察点**（你的保留被数据证实）。
4. **ready 2.21 s**：worker 0.49 s（track→input_loop 5 ms），派单 0.21，设备连接 0.51，**input_ready 发布→设备收到 0.91–0.97 s**（设备订阅通道 ACTIVE 在发布后 0.80 s）。可优化：S1 显式派单 ≈0.45 s；订阅通道 0.8–0.9 s 归端侧。不给「两房快=优化已成功」。

---

## 0. 本房双端对时（按你的要求重建，不沿用 A2 区间）

设 δ = worker 钟 − 设备钟。

| 锚 | 方向 | 数据 | 约束 |
|---|---|---|---|
| speaking=true | worker→设备 | worker `AgentSpeechStarted` 40.899Z ↔ 设备 40.085 | δ ≥ 0.814 |
| cancel | 设备→worker | 设备 47.029 发 ↔ worker 47.903Z 收 | δ ≤ 0.874 |
| cancel.ack | worker→设备 | worker 47.903Z 发 ↔ 设备 47.135 收 | 与上条合成 RTT 106 ms |
| speaking=false | worker→设备 | 47.903Z ↔ 47.140 | δ ≥ 0.763（弱） |
| 遥测 skew | 服务端 | 相邻批次 875–885 ms（server_received − device_ts，含上传单程） | 上界一致 |

**δ ∈ [0.814, 0.874] s**（下文换算取两端）。比 A2 的 0.752–0.813 大 ~60 ms，设备钟在两房之间变了，**以后每房各算**。⚠️ `input_ready` 不能当对时锚：它的单程含订阅通道建立等待（本房 0.91–0.97 s），不是网络单程。

---

## 1. 定位、ASR 结果、VAD 起止、裁切

### 1.1 三站时间线（worker/服务端 UTC，Z；设备行按 δ 换算）

| 时刻 (Z) | 来源 | 事实 |
|---|---|---|
| 37.68–37.74 | 设备 36.867 | 硬件唤醒 |
| 37.775 | 服务端(由 issue_to_assignment 反推) | token 签发 |
| 37.78–37.84 | 设备 36.962 | session_bound |
| **38.285** | LiveKit | 设备信令抵达（距签发 0.51 s） |
| 38.491 / 38.496 | LiveKit / worker | 派单 / `job_assignment_received issue_to_assignment_ms=721` |
| 38.50–38.56 | 设备 37.683 | connect 返回 / probe_armed（=设备 sink 样本 0） |
| 38.531 | worker | ASR 预连任务起（`asr stream task spawned (preconnect)`） |
| 38.737 / 38.784 | worker | 进房 241 ms / agent 轨发布 |
| 38.865 | LiveKit | 设备麦轨发布（信令后 580 ms） |
| 38.982 / 38.988 | worker | `user_track_subscribed` 486 ms / `input_loop_started track_to_input_loop_ms=5` + **`session.input_ready published`**（=worker 环形缓冲样本 0） |
| 39.201–39.261 | 设备 38.387/38.395 | filler 播完 / 静音门释放 microphone_enabled |
| 39.284 | worker | 收到设备 capability（设备→worker 数据通道已通） |
| 39.312 | worker 环形缓冲 | **首个非静音样本**（静音门释放后 43–103 ms） |
| **39.436** | worker | `asr: connected`（预连完成，晚于输入环 448 ms；缺口期 PCM 进 128 块有界队列，首句起点在其后 0.44 s，未受影响） |
| **39.788** | LiveKit | 设备 participant ACTIVE（信令后 1.503 s） |
| 39.878 | worker VAD | speech_start（第 1 句） |
| 39.90–39.96 | 设备 39.086 | 收到 input_ready（距 worker 发布 0.91–0.97 s；距 ACTIVE 0.11–0.17 s） |
| 39.911 | worker | `agent_track_subscribed_by_android` → output_ready |
| 40.578 / 40.680 / 40.783 | worker | eot_request（speech 0.64 s，silence 224）/ speech_end / eot_prob 0.689 accepted |
| 40.599 / 40.751 | worker | interim / `S1v3 preflight`（silence 533，tail「测试」）→ 投机生成起 |
| 40.846 / 40.885 | worker | `stt final: 测试一下`（二遍 definite，距 eot_prob 63 ms）/ `turn committed eou_ms=524 stt_ms=486`；投机文本「测试」≠ final → 作废；filler gen 2040 ms |
| 40.85–40.91 | 设备 40.034 | 收到 4 字 final（=worker 转写下发，单程 ≤60 ms） |
| 40.899 | worker | `AgentSpeechStarted`（agent turn `8676bab5…`），AEC warmup 0.5 s |
| 41.664 / 42.060 / 42.291 | worker | 兜底路 ttft 402 ms 38 字先完 / main 在 800 ms grace 内胜 / main 20 字完 |
| 42.18–48.02 | worker | TTS 6 字 1840 ms + 14 字 3240 ms（正文含称呼，不入文）；播放合计 ≈7.12 s |
| **47.826** | worker | **`stt final: 退出`**（二遍 definite；**该段无 UserSpeechStarted、无 interim、无 eot_request**）→ 转写下发 |
| 47.83–47.89 | 设备 47.018 | 收到 2 字 final → 47.021 本地 exact 退出 → 47.029 发 cancel |
| **47.903** | worker | `control cancel seq=2 cancelled=true already_done=false had_turn=true` → `agent turn aborted, history truncated to spoken part played_samples=168391 synth_chars=20 spoken_chars=19` → `speaking→listening interim='退出'` → `AgentSpeechStopped` → cancel.ack |
| 47.94–48.00 | 设备 47.135/47.140 | 收到 ack / speaking=false |
| 48.015 | worker | `user track MUTED`（设备关麦） |
| 48.019 | worker | playout `SourceDrained`（abort 后排空 206 ms 缓冲） |
| 48.072 / 48.077 | LiveKit / worker | 设备 CLIENT_REQUEST_LEAVE / `participant disconnected → closing job` |
| 48.085 / 48.128 | EOT / worker | job_end（snapshots=1）/ job closed uptime 9 s |
| ≈48.23 | （未发生） | 「退出」按判停规则本应 commit 的时刻（47.826 + MIN 0.40 s） |

### 1.2 两段 ASR 实际结果

| 段 | interim | final | VAD 起/止 | EOT | commit | 裁切 |
|---|---|---|---|---|---|---|
| 1「测试一下」 | 40.599（预飞 tail「测试」） | 40.846（二遍 definite） | 39.878 / 40.680（speech 0.64 s） | 0.689 accepted | 40.885（eou 524 / stt 486） | 无 |
| 2「退出」 | **无** | 47.826（二遍 definite） | **无起点、无止点** | 无（无静音累积触发） | **未发生**（见 §2） | 无 |

**裁切**：worker 不裁音频；文本级门（本地音频回声门、开场重叠门、命令、急停、退出）全部住在 commit 路径里，第 2 段没有进 commit，任何门都没运行过。onset/tail 判据也只在 commit 内引用。

---

## 2. 退出前原 turn、cancel 对应、吞句与信令

- **原 turn 是否活跃**：是。agent turn `8676bab5…` 从 40.899Z 起播；cancel 到达 47.903Z 时 `played_samples=168391`（xfyun 24 kHz → 7.016 s）/ 合成 20 字已播 19 字，还剩 ≈0.1 s 音频 + 206 ms 播放缓冲。用户说「退出」落在回复最后 ~1 s，与你的「仍在说话/刚结束」一致。
- **cancel seq=2 对应哪个 turn**：对应上面这个原回复轮（`had_turn=true`），`cancelled=true` 是对它的 hard abort（`agent turn aborted, history truncated`），不是退出产生的新轮——**没有新轮**：47.826 之后 journal 零 `turn committed`/`filler picked`/`tts synth`。`interrupt telemetry … interim='退出'` 里的「退出」是 tele_text（最后一条 final 的快照），不是新轮文本。
- **第 2 段是否被 SESSION_EXIT 源头吞句**：**没有走到**。机制：退出判定在 commit 路径里；本段 VAD 从未见起止，判停状态机（turn.rs）把锚退化为「最后 final 时刻 + MIN_ENDPOINTING_DELAY（本机 0.40 s）」，即 ≈48.23Z 才会 commit；设备 47.903 的 cancel 与 48.077 的断房都在它之前。journal 无 `session_exit utterance swallowed` / `signal sent` / `signal skipped` 任一行。
- **`session_exit_detected`**：未发出，时间 N/A。与 v140 合同 §4.3「Android 本地 exact 先命中会先发 cancel，cancel 即退出信令终态」在结果上一致；差别是这次 worker 连 pending 都没建（合同预期是「信令已发→cancel 终止重试」，本房是「信令未到发的时刻」）。
- **零新增 commit/filler/LLM**：是。
- 一个可选改法（列出不做）：把 `is_stop_only(exit_hotwords)` 的 exact 判定前移到 `on_final`（final 到达即判、即发信令，不等判停锚），能把 tail/fragment 变体（Android 本地不认的那些）的信令提前 ≈0.4 s；代价是打破「退出信令严格在 commit 序」的现行合同。**等拍板。**

---

## 3. 同源 PCM：worker 解码输入 vs 你的 93 窗

### 3.1 观察点与覆盖

| 项 | worker 侧实取 |
|---|---|
| 观察点 | LiveKit 订阅轨解码后（Opus→PCM→重采样）**16 kHz / mono / s16**，同一帧同时进 Silero VAD、ASR 发送队列、EOT 8 s 环形缓冲；无裁剪、无增益、无 APM |
| 零 PCM 预发布 | 在 worker 表现为 **|x|≤2 的 324 ms**（前 41 样本恰为 0，其后 ±1–2 = 数字静音经 Opus 的抖动），38.988–39.312Z |
| 累计样本 | **t0000.wav = 25600 样本 / 1.600 s**（38.988–40.588Z，输入环起点→第 1 次 eot_request）。仅此一段 |
| 播报期（40.9–48.0Z）与「退出」段 | **NOT_CAPTURED**：快照只在 eot_request 触发，第 2 段无 VAD；`audio in (10s)` 水位报告在 job 满 10 s 才打，本 job 9 s |
| 采样率/声道 | 16k mono；SDK 回调 16k/PCM16/mono 与之同构，ALSA 双声道语义不在 worker 视野 |

### 3.2 首句逐窗对齐（设备样本 s ↔ 设备钟 37.683 + s/16000；worker 样本 i ↔ 38.988Z + i/16000；两列分别取 δ=0.814 / 0.874）

| worker 100 ms 窗 | worker 起点 (Z) | 对应设备窗 seq（δ=0.814 / 0.874） | 设备 RMS/峰 | worker RMS/峰 | 说明 |
|---|---|---|---|---|---|
| 0 | 38.988 | 6–7 / 6–7 | 677–3460 / 4395–10599 | **0 / 1** | 设备 sink 里是本地 filler 回声；worker 收到的是静音门 |
| 1 | 39.088 | 7–8 / 7–8 | 3460–825 / 10599–3786 | **0 / 1** | 同上 |
| 2 | 39.188 | 8–9 / 8–9 | 825–948 / 3786–2997 | **0 / 1** | 同上（静音门释放前） |
| 3 | 39.288 | 9–10 / 9–10 | 948–227 / 2997–790 | **1790 / 6210** | 静音门刚开（39.21–39.26Z），filler 回声尾巴穿过来；worker ≈ 设备 ×1.9 |
| 4 | 39.388 | 10–11 | 227–138 / 790–382 | 560 / 2902 | 尾巴衰减 |
| 5 | 39.488 | 11–12 | 138–110 / 382–421 | 141 / 737 | 底噪 |
| 6 | 39.588 | 12–13 | 110–283 / 421–829 | 154 / 447 | |
| 7 | 39.688 | 13–14 | 283–165 / 829–631 | 268 / 1360 | 「测试一下」起（VAD 起点 39.878） |
| 8 | 39.788 | 14–15 | 165–353 / 631–878 | 378 / 1342 | |
| 9 | 39.888 | 15–16 | 353–153 / 878–437 | 376 / 1581 | |
| 10 | 39.988 | 16–17 | 153–176 / 437–666 | 353 / 1198 | |
| 11 | 40.088 | 17–18 | 176–115 / 666–428 | 142 / 457 | |
| 12 | 40.188 | 18–19 | 115–63 / 428–203 | 222 / 955 | |
| 13 | 40.288 | 19–20 | 63–71 / 203–197 | 76 / 206 | 句尾 |
| 14–15 | 40.388– | 20–22 | 71–59 / 197–933 | 15–9 / 44–35 | 静音 |

读法：

- **传输无衰减**：首句各窗 worker RMS ≈ 设备 sink 的 1.0–2.2 倍、峰值 1.5–2.5 倍（同一句、同一时段、两把尺同单位）。sink 之后到编码之间存在 ≈+3–6 dB 的增益（推断：APM 的 AGC 在 sink 之后），**不是**衰减。
- **静音门位置**：worker 窗 0–2 全静音，而同时段设备 sink 有 RMS 677–3460 的 filler 回声 → 静音门在 sink 之后、编码之前；本地 filler 的回声**没有**进 worker。
- **本房里 sink 显示的播报期能量（seq 31–94，RMS 至 3938、峰 11535）在 worker 侧无对应记录**（NOT_CAPTURED），我不据此反推 A2；A2 房那段播报期 worker 侧 RMS 5–11 是 A2 自己的数据，放在 A2 回执里。
- 对齐精度 ±1 窗（δ 区间宽 60 ms + 设备 sink 起点用 probe_armed 近似）。

---

## 4. 建连与 input_ready：2.21 s 拆解与可优化项

| 区间 | 本房 | 定义/证据 |
|---|---|---|
| 唤醒 → token 签发 | 0.04–0.10 s | 设备 36.867(换算) → 37.775Z |
| 签发 → 设备信令抵达 LiveKit | 0.51 s | 38.285Z（A2 那次是 2.5 s 离群，本房正常） |
| 信令 → 派单 → worker 接单 | 0.206 / 0.211 s | 38.491 / 38.496Z |
| 接单 → 进房 → 出声轨 | 0.241 / 0.288 s | 与设备 PUBLISHER 建立并行 |
| 设备麦轨到 SFU | 38.865Z（信令后 0.58 s） | |
| SFU 有轨 → 订到 → 输入环 → input_ready 发布 | 0.117 s + **5 ms** | 38.982 → 38.988Z（预组装已把组装期压掉） |
| input_ready 发布 → 设备收到 | **0.91–0.97 s** | 设备订阅通道 ACTIVE 39.788Z（发布后 0.80 s），设备收到在其后 0.11–0.17 s |
| 合计 | 2.22 s ✓ | 你报 2210 ms |

可优化与归属：

- **S1 显式派单（服务端，可 per-SN 灰度；本轮未启用）**：签 token 即派单，worker 提前进房；派单 0.21 + 进房 0.24 + 出声轨 0.05 退出关键路径，预计 assignment→input_ready 0.49 → ≈0.12 s。**但设备收到 ready 的时刻仍被订阅通道 ACTIVE（信令后 1.5 s）卡住**，本房净收益 ≈0.4 s，不是「快了就是它的功劳」。
- **订阅通道 1.5 s（端侧）**：三类设备 117 房的固定成本（上一份回执 §3.2），本房 1.503 s 与之一致。
- **ASR 预连本房晚于输入环 0.45 s**（ws 建连 0.9 s）：首句起点在其后 0.44 s，未受影响；缺口期 PCM 进 128 块有界队列（try_send 满才丢），按块 ≥10 ms 算容量 ≥1.28 s（推断，未逐值核 STT_SEGMENT_SAMPLES）。若用户在开麦后 <0.45 s 开口，首段会晚到但不丢。worker 可做：把预连提到接单前（建房前 worker 不知道房，只能池化连接）——列为候选，本轮不做。
- **不做的结论**：本房与 07:22 房都快，只说明设备连接正常时链路是 2.2 s 量级，不说明任何优化生效。

---

## 5. 一句话交接

- worker 侧退出判定住在 commit 里；无 VAD 的 final 要等 0.40 s 判停锚，Android 本地 exact 只要 3 ms——**只要设备本地认得这个词，worker 的信令永远比它慢**，这轮没发信令是这个序的必然结果，不是故障。信令真正有价值的是 Android 本地不认的 tail/fragment 变体，那些能走到 commit。
- 你的 sink 点在静音门和（推断的）AGC 之前：**它证明用户在说、说了多响，不能证明 worker 收到多响**；首句这段两边都有，比对结果是「worker 不比 sink 弱」。播报期两边只剩你那一半。
- 下一轮若要拿到 worker 侧播报期/「退出」段 PCM，需要在回答**结束后**留一个 VAD 能咬到的正常音量句（触发 eot_request 快照，8 s 窗会把播报尾巴和「退出」一起带上），或者 worker 加一个 env 门控的「job 结束时快照」——后者是改动，等点名。

署名：cc（Claude）| 2026-09-08 17:46 CST
