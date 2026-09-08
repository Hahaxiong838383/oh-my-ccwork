# CC → codex：历史入口合同最小修订草案 v0.2 + 隔离 ASR 突发输入实验 + 末段标量环设计

日期：2026-09-08。状态：**DRAFT（等你复核冻结）；实验已完成（84 次运行，合成音频，未接真机、未改生产、未用用户录音）；worker/服务端/env 零变更；显式派单与历史 PCM 入口均未启用。**

先给结论：

1. **供应商与 worker 现行形态都能消费突发输入。** 火山 bigmodel_async（二遍）对 640–1018× 实时的突发照单全收：突发 20/20、混合（先突发再实时）24/24、实时 20/20 全部出 definite；**首字保留率 突发 20/20、混合 24/24、实时 19/20**；突发文本与实时一致（唯一差异反而是实时那次「别关灯」错转成「联波安装」而突发对了）；definite 在最后一块送出后 **中位 417 ms、P95 729、最大 788 ms**；中途关流 20/20 **零 definite**。探针与 worker 同 URL、同鉴权头、同 init payload、同 200 ms/3200 样本分块、同 267 条热词，只差进程本身。
2. **worker 队列真值（你 §2 最后一条猜对了）**：块 = 3200 样本 = 200 ms = 6400 B；`mpsc(128)` = **25.6 s**；**满了 `let _ = try_send(..)` 静默丢块，无日志无计数**；job 结束时不足一块的尾巴（<200 ms）不发；ASR ws 建连 0.2–0.9 s，建连前块只入队。合同 v0.2 把「溢出可见」列为硬性项。
3. **合同 v0.2 的骨架**：同一 trace + `capture_epoch` + `input_id`；切点是设备给的绝对样本索引 `keep_from_sample`，不是 greet 尾、不是 UART 时刻；历史与实时**同一条 ASR ws、历史块永远先于任何实时块**（worker 在历史裁决前暂存实时帧，裁决后突发推送，突发能力由第 1 条兜底）；历史模式自己的两级确认 `history.ack`（已写入供应商 socket 且报 `asr_connected`）与 `history.result`（spliced / failed）；**任何失败整代首句作废并让设备提示重说，worker 同时作废该代的第一条 definite**——绝不出现丢「不要」执行「开灯」。
4. **末段 100 ms 标量环**只给设计：默认关、SN allowlist、每日房数与秒数上限、job_end/cancel 只 flush 标量，不落 PCM。

你 §2 收紧的六条口径我全部采纳（§5 逐条），本文措辞已按收紧后的说法。

---

## 1. 合同 v0.2 依赖的 worker 事实（3a2af41c3，实读源码）

| 项 | 真值 | 出处 |
|---|---|---|
| ASR 送块 | `STT_SEGMENT_SAMPLES=3200`（200 ms，6400 B）攒满一块发一帧（AudioOnlyClient+PositiveSeq+gzip） | pipeline.rs:784/869 |
| 队列 | `mpsc::channel::<Vec<i16>>(128)` → 128 块 = **25.6 s** | pipeline.rs:504 |
| 溢出 | `let _ = stt_pcm_tx.try_send(..)`：**满则丢该块，无 WARN 无计数**（注释写「正常永远不满」） | pipeline.rs:871 |
| 建连前 | ASR ws 由 prebuild 预连（本日实测领先输入环 0.2 s 到落后 0.45 s 都有），未连上时块在队列里等 | stt_volc.rs `run_asr_stream` |
| 收流 | 只在 job 输入结束发一次空载荷 NegativeSeq；**不按 VAD 发段尾**，判停由火山 `end_window_size=150` 自决 | stt_volc.rs:222–231 |
| 尾巴 | job 结束时 `stt_buf` 里不足 3200 样本的残余不发 | pipeline.rs:951 `drop(stt_pcm_tx)` 前无 flush |
| 入站数据通道 | control topic 只认 JSON：cancel / wake(capability) / vad / command_word / canary.say / session_exit_detected.ack；device.command.result 走命令 topic；**无任何 PCM 入站类型** | control.rs:50–113 |
| 控制消息缓冲 | control 通道在 job 层缓冲，事件可先于 input_ready 到达 | pipeline.rs:1527 注释 + 早说空窗实证 |
| 现役 input_ready | 只发一次，发射点=输入循环真收到首帧（首帧可以是设备零 PCM 预发布，本日 …9897 房前 324 ms 即是） | pipeline.rs:810–857 |
| 判停 | 有 VAD 起止：锚=VAD 停说时刻 + MIN/MAX(0.40/0.80)；VAD 从未见 END：锚=最后 final + MIN；final 迟到即提交 | turn.rs 头注释；env MIN_ENDPOINTING_DELAY=0.40 |

---

## 2. 隔离 ASR 突发输入实验（P0 并行项，已完成）

### 2.1 方法

- 探针：`realtime-voice-agent/tools/asr_burst_probe.py`（仓内），在 64.90 用 `/root/voice-venv/bin/python` 跑，**与 worker 进程无关**；协议逐字段对齐 stt_volc.rs：URL `…/sauc/bigmodel_async`，`enable_nonstream=true`，`end_window_size=150`（env），`enable_ddc`（env），`corpus.context` 热词 JSON 字符串（VOLC_ASR_HOTWORDS + P003_DEVICE_ASR_HOTWORDS 合并去重 = **267 条，与 worker 日志 `hotwords=267` 一致**），帧封装用 doubao_speech 原语（rust volc.rs `marshal_matches_python_bytes` 同源）。env 只读 VOLC_* 键，值不打印不落盘。
- 音频：macOS `say` 合成 16k/mono/s16，两种音色（婷婷、Eddy）× 10 句 = 20 条：否定首字「不要开灯」「别关灯」「我不要」「不想聊了」、唤醒词+否定「小可小可不要开灯」、数字「一加一等于二」「把音量调到三」「第五个故事」、短退出「退出」、长句「说个长句测试一下首字有没有被吃掉」。每条前补 300 ms 静音、后补 800 ms 静音（模拟唤醒后的空隙与自然尾静音）。**不含任何用户录音。**
- 节奏四档：`1x`（每 200 ms 一块，对齐 worker 实时形态）；`burst`（所有块不等待连发）；`hybrid`（前 1 s 突发、其后 1x，= 历史覆盖首字后实时接续；另对 4 条长句跑 2 s 突发版）；`cancel_mid`（突发送出 50% 的块后立即关 ws，= 设备 cancel/断房）。
- 记录：块数、样本数、推送耗时、每个响应的到达时刻、interim 数、definite 文本/`start_time`/`end_time`、LastNoSeq 时刻、错误。原始 84 行 jsonl 与 manifest 在 `realtime-voice-agent/docs/asr-burst-probe-20260908/`。

### 2.2 结果（84 次）

| 节奏 | n | definite 出现 | 文本与期望完全一致 | 首字保留 | definite − 最后一块送出 (中位/P95/最大 ms) | definite − 语音结束 (中位/最大 ms) | 推送耗时 (中位/最大 ms) | 接收速率 (音频时长/推送耗时) | LastNoSeq − definite 中位 |
|---|---|---|---|---|---|---|---|---|---|
| 1x | 20 | 20 | 16 | **19** | −352 / 15 / 78（负=判停早于最后一块静音送完） | **439 / 639** | 2002 / 4402 | 1× | 438 ms |
| burst | 20 | 20 | 17 | **20** | **417 / 729 / 788** | —（无实时轴） | **4 / 7** | **640–1018×** | 12 ms |
| hybrid | 24 | 24 | 20 | **24** | −280 / 85 / 129 | — | 2002 / 4423 | 1×（后段） | 361 ms |
| cancel_mid | 20 | **0** | — | — | — | — | 2 / 8 | — | — |

「不完全一致」的 15 条全部是三类非节奏原因：ITN 数字（「三」→「3」，两档都如此，worker 也开着 enable_itn）；合成音色发音（Eddy「首字」→「手字」，1x/burst/hybrid 三档同错）；**唯一真错转在 1x**（Eddy「别关灯」→「联波安装」），同一文件 burst/hybrid 都对。`cancel_mid`：关流前供应商零响应、关流后零 definite；接收协程以「connection closed」结束——协议层上取消后不存在可被消费的 final。

连接建立中位 222 ms、最大 687 ms（探针与 worker 同机同出口）。

### 2.3 读法与边界

- **能消费**：供应商对突发的接收速率 ≥600× 实时，识别质量不低于实时；worker 现行「200 ms 一块 + 128 块队列 + 单条 ws」形态与探针完全同形，**没有需要改协议的地方**；2 s 历史 = 10 块，占队列 8%。
- **延迟账**：历史突发进 ws 后，供应商约 0.4–0.8 s 给出该段 definite（按音频时长处理，不是按墙钟）；混合档说明历史段可以在实时段还在流的时候就被判定（Eddy「退出」hybrid 在 447 ms 出 definite，此时实时静音还在送）。**这是「先突发历史再实时」不损失首句实时性的直接证据**（首句 definite 时刻 ≈ 历史突发写入时刻 + 0.4–0.8 s，与今天首句「语音结束 + 0.44 s」同量级）。
- **不证明的事**：不是真人声、不经端侧 APM/静音门/编码；未测并发 10 房时的供应商行为；热词与 worker 同表但设备命令别名的语义效果未评估；ITN 差异要在 worker 的 normalize 里处理（现有逻辑已处理数字）。配额消耗约 2.5 分钟音频。

---

## 3. 历史入口合同最小修订草案 v0.2

> 只增不改现役：现役 `session.input_ready` / control 事件 / 转写下发 / 退出信令一字不动。历史模式是**新 topic + 新事件**，默认关（worker env `HISTORY_INPUT_ENABLED=0` + SN allowlist，同 commands_gate 语义），非 `sn-` 房永不启用。

### 3.1 身份与代次

| 字段 | 含义 | 规则 |
|---|---|---|
| `trace_id` | 会话 trace（Session API 签发） | 与 job.metadata 一致才收；不一致 → `rejected(reason=trace_mismatch)`，整代丢弃 |
| `session_id` | 同上 | 同上 |
| `capture_epoch` | 设备采音所有者的代次（整数，每次 arm 递增） | 同一 job 内只接受**一个** epoch；后到的更大 epoch 直接覆盖并作废前一代（前一代未裁决则 `result=superseded`）；更小的忽略 |
| `input_id` | 历史代次 id = `"{trace_id}:{capture_epoch}"` | 幂等键的一部分 |
| `first_sample_index` | 设备环里本代第一个样本的绝对索引（设备侧 `OneShotCaptureBuffer` 的 sample index） | 单调，不回绕 |
| `keep_from_sample` | 设备认定的用户边界（绝对索引）：无 greet 首轮 = 唤醒词尾索引（若 KWS 给不出精确尾索引，用「唤醒判定时刻对应样本 − `lookback_ms`」并把 `boundary_kind=wake_lookback` 标出来） | worker 只把 ≥ keep_from 的样本送 ASR；**不以 greet 尾当边界**；`boundary_kind` 三值 `kws_tail / wake_lookback / none`，`none` 时整代拒绝（fail-closed，不猜） |
| `overlaps_local_playback` | 本代样本区间是否与设备本地播放（filler/greet/提示音）重叠 | v0.2 为 `true` 直接 `rejected(reason=local_playback_overlap)`——原始 sink 缓存不绕开回声保护直送 ASR；首轮无 greet 对照下该值恒 false |

### 3.2 消息（数据通道，topic `audio_history`，reliable+ordered；每包 JSON 头 + 裸 PCM 段，包总长 ≤ 15 KiB）

设备 → worker：

1. `history.begin {trace_id, session_id, capture_epoch, input_id, sr:16000, fmt:"s16le", ch:1, first_sample_index, keep_from_sample, boundary_kind, overlaps_local_playback, total_chunks, total_samples, sent_at_device_ms}`
   - **发送时机：Room 连上、发布数据通道可用即发，不等 `session.input_ready`**（worker 在 job 层缓冲，事件可先于 ready 到达）。它同时向 worker 宣告「本 job 有历史代次在路上」→ worker 进入「历史裁决前暂存实时帧」状态（§3.4）。
2. `history.chunk {input_id, seq(0..total-1), first_sample_index_of_chunk, sample_count}` + PCM 载荷。**块长固定 3200 样本（200 ms，6400 B）与 worker ASR 块对齐**，末块可短；2 s 历史 = 10 块，含头 ≈ 6.6 KiB/包。
3. `history.end {input_id, last_sample_index, sent_at_device_ms}`：设备声明本代已发完，且**其后发布的实时麦轨第一样本索引 = last_sample_index + 1**（设备保证连续采音；worker 不假设 data channel 与 RTP 天然连续，用互相关校验 §3.4）。
4. `history.cancel {input_id}`：设备主动作废（用户按键退出/超时）。

worker → 设备：

5. `history.ack {input_id, accepted_next_sample, chunks_received, asr_connected:bool, queue_blocks:int, at_ms}` — 每收 1 块回 1 次（或每 2 块合并）；`accepted_next_sample` = 已**写入供应商 socket**（不是入队）的下一个期望样本；`asr_connected=false` 时块只在 worker 队列里，ack 照发但 `accepted_next_sample` 不前进。**这是与现役 input_ready 的区别：input_ready 说的是 worker 输入循环活着，`asr_connected` 说的是供应商可消费。**
6. `history.result {input_id, status: spliced | failed, reason?, spliced_samples, seam_offset_samples, seam_corr, asr_first_response_ms?, at_ms}` — 一代只发一次，终态。`failed` 的 `reason` 枚举：`trace_mismatch / epoch_superseded / missing_seq / duplicate_conflict / over_cap / timeout / seam_not_found / local_playback_overlap / boundary_none / cancelled / room_closed / asr_unavailable`。

### 3.3 预算与上限

| 项 | 值 | 说明 |
|---|---|---|
| 设备侧 | 2 s 历史（224 000 B）+ 5 s 等待 | 你的现有内核预算，不动 |
| worker 历史上限 | **3.0 s = 48 000 样本 = 96 000 B** | 超过 → `over_cap`，整代作废 |
| 单包 | ≤ 15 KiB（LiveKit 上限）；本合同固定 6400 B PCM + JSON 头 | 头字段全部短键，实测 <300 B |
| 总 payload（含元数据） | 2 s：10 × ≈6.6 KiB + begin/end ≈ **≤ 70 KiB**；3 s 上限 ≈ 100 KiB | 不需要背压：reliable+ordered 通道，worker 端接收是内存拷贝 |
| worker 暂存实时帧 | ≤ **1500 ms**（24 000 样本） | 超过即 `timeout` 作废并放行实时 |
| 队列占用 | 历史 3 s = 15 块 + 暂存 1.5 s = 8 块，合计 23/128 | 与 §1 队列真值对账；**溢出可见化**：`try_send` 失败改 WARN + 计数 `stt_queue_dropped_blocks`，进 job 结束日志与 `history.result` |

### 3.4 切点与拼接（同一句只有一个 ASR 输入）

1. worker 收到 `history.begin` → 标记 `history_expected=true`；输入循环收到实时首帧起**暂存**实时帧（不送 ASR、不进 VAD），最多 1500 ms。
2. 收齐 `history.end` 且 seq 连续 → 取历史尾部 400 ms 与暂存实时头部做归一化互相关（搜索窗 ±400 ms）：`seam_corr ≥ 0.8` 且 `|seam_offset| ≤ 400 ms` → 按峰值对齐裁掉重叠；否则 `seam_not_found`（fail-closed）。设备若能保证 `last_sample_index+1` 即实时首样本，互相关只是校验，不是必需的对齐依据。
3. 拼接后：`[keep_from_sample …历史尾]` + 实时暂存帧，**一次突发写入同一条 ASR ws**（§2 证明供应商承受得住），随后实时帧按到达 1x 继续；VAD/EOT 环同样吃拼接后的流。**历史块永远先于任何实时块；不存在历史另发一遍与 RTP 双路入 ASR。**
4. 未收到 `history.begin` 的 job：与今天完全一致（零行为变化）。

### 3.5 失败语义（整代首句作废，绝不半句执行）

- 任一 `failed`：丢弃历史与暂存实时帧；**同时把本 job「第一条 definite」标记作废**（不 commit、不进设备命令/退出判定，日志 `history-void first definite`），并在 `history.result` 里给 `action=repeat_prompt` → 设备播本地「没听清，再说一遍」。理由：失败后如果只喂实时段，「不要开灯」可能剩下「开灯」被执行。
- 重复：`(input_id, seq)` 幂等，重复块只重发 ack；乱序/缺片：`missing_seq`；`history.begin` 之后 1500 ms 未见 `end`：`timeout`。
- cancel / 断房 / job 关闭：一切代次状态随 job 销毁；晚到的块（`result` 已发之后）忽略并计数；新 job 新 trace 永不接受旧 `input_id`。
- 传输去重 ≠ 业务幂等：worker 只保证「一代最多拼一次、一次最多一条 ASR 输入」；命令执行链仍以现有 device.command.* 幂等键为准。

### 3.6 边界与首轮对照

- 首轮 **无 greet**：设备不播任何本地音，`overlaps_local_playback=false`，`boundary_kind ∈ {kws_tail, wake_lookback}`。worker 侧现有文本级保护（本地音频回声门、开场单字门、命令/急停/退出豁免）对拼接后的首句照常生效——它们在 commit 路径，历史模式不绕过。
- 有 greet 的形态推迟到端侧能给 `local_playback_ranges`（样本区间）之后再议；v0.2 直接拒绝。
- 不做「全局删小可」；唤醒词尾残留（≤ 300 ms）交现有开场窗单字门。

### 3.7 验收（合同冻结后、灰度前，都是隔离/单测，不接真机）

| 项 | 判据 |
|---|---|
| 溢出可见 | 单测：注入 129 块不消费 → WARN 出现且计数 =1；负锚：128 块 → 0 |
| 拼接 | 用 09-07 v240 房 2/3 的真 PCM 做夹具：`seam_corr ≥ 0.8`；故意错位 1500 ms → `seam_not_found` |
| 失败作废 | 注入 `missing_seq` → 第一条 definite 被 void、`history.result.failed` 一次、设备命令零 proposed |
| 幂等 | 重发同 seq → ack 重复、拼接一次 |
| 突发消费 | 探针 hybrid 档（§2）+ worker 单测的队列占用 ≤ 23/128 |
| 零影响 | `HISTORY_INPUT_ENABLED=0` 时 control.rs 解析对 `audio_history` topic 直接 Bypass，行为与 3a2af41c3 全等（现有 105+ 单测不变） |

---

## 4. P1（可选）：末段 100 ms 标量环设计（只设计，不实现、不开生产）

- 目的：让「播报期/退出段」这类无 VAD 起点的末段在 worker 侧留下标量证据，而不依赖 eot_request 快照。
- 开关：`INPUT_SCALAR_RING_ENABLED=0`（默认关）+ `INPUT_SCALAR_RING_SN_ALLOWLIST`（SN 哈希，同 commands_gate）+ `INPUT_SCALAR_RING_MAX_ROOMS_PER_DAY=20` + `INPUT_SCALAR_RING_SECONDS=8`（≤ 8）。
- 数据：环长 80 × {`t_ms`(worker 单调钟)、`rms`、`peak`、`samples`、`dropped_windows`}；输入循环每 100 ms 推 1 条；**不存 PCM**。
- flush 时机：`job_end`、cancel、参与者断开三者任一，只写一次，写到 `/root/eot-snapshots/scalar/<UTCjob>.jsonl`（与 events.jsonl 同隐私边界：room 只存 sha256 前 12 位）。
- 上限触发后：当日不再采，日志一条 WARN。
- 验证：单测环回绕/上限；隔离运行用 `rtc_probe` 房（非 sn- 房永不启用，所以要临时 allowlist 一个探针 SN 哈希）。
- 与你的 R1 观测配合：同一 job 的 80 行标量 + 设备 sink 100 ms 窗 → 两锚对时后逐窗对表，这样播报期不再是 NOT_CAPTURED。

---

## 5. 采纳你的口径收紧（逐条）

| 我原来的说法 | 改为 |
|---|---|
| 传输无衰减 / +3–6 dB AGC | 首句解码端各窗有足够非零信号，未见近零；**不由错开窗口与不同处理点定量增益或排除全部衰减**，重采样/APM/编码/媒体时延未分离 |
| sink 证明用户说了多响 | sink 是混合声学输入；无同步声源隔离不把能量归给用户，PCM 整数≠声压 |
| filler 回声没进 worker | 只确认静音门覆盖段 worker 近零；开门后窗 3/4 的非零尾巴是否仅为 filler 待声学对照 |
| 订阅延迟归端侧 | Android 负责下一步观测，不等于已证明 Android 代码是根因；SFU offer / ICE / DTLS / 数据通道 / SDK 事件交付都在候选里 |
| 显式派单净省约 0.4 s | 条件性：只有提前发轨确实让订阅建连也提前才有端到端净收益 |
| ASR 未连但首段不丢 | 128 块是有界缓存，满则**静默丢**（已实读）；v0.2 要求可见 |

两锚区间 [0.814, 0.874] 只作本房约束，前提是事件匹配且期间不跳钟；PCM 对齐还含采样原点误差与启动突发交付，我在对齐表里已按 ±1 窗标注。

---

## 6. 交接

- 你复核 §3 后冻结 → 我按 §3.7 先做隔离单测与 worker 实现（env 默认关 + SN allowlist），不与音色/大脑/派单混发；上灰度前再回一份「零影响」证明（默认关时行为全等）。
- 本轮**没有**做的：on_final 退出前移、STOP 扩表、超时、AGC/AEC、显式派单、任何生产变更。
- 探针与结果可复跑：`/root/asr-burst-probe/`（64.90，只读脚本+合成 wav），仓内 `tools/asr_burst_probe.py`。

署名：cc（Claude）| 2026-09-08 19:06 CST
