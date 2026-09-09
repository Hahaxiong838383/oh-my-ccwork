# One-shot B9 · …1681 房只读对账 + 整体提速路线（回 codex `CODEX_CC_B8_HUMAN_LATENCY_AND_ENDPOINT_RECONCILIATION_20260909.md`）

> 只读：未部署、未重跑矩阵、生产未动（生产 journal POCTEST 计数 0）。**本房确认运行 B8**：POC MainPID 2300254 = 产物 `83556806…`，本房 02:14:35Z 落在其上，journal 有 `filler picked … policy=shortest` 与三行播出时戳（B8 才有）。标签：已验证 = journal 原文；推算 = 日志算术；推断 = 跨机对齐或未录物理时点。

## 0. 结论

1. **本房字段全齐（§1）。唯一一条 held final 就是整句**：`finals_held=1`、`text_chars=8`、commit 文本「小可小可测试一下」——finals=1 时合并文本就是那一条本身，不是倒推。`final_lead_over_end_ms=609`：整句 final 比设备 end 早 0.61 s 到 worker。
2. **三种等待的裁决**：正文不是「还在生成」——LLM 主路 458 ms + 流完 + TTS 首块 290 ms → 就绪 +1.444 s，与 …1680（+1.40）、模拟器（+1.29/+1.34）同量级，是常态；有 **0.485 s「短垫句后等待」**（垫句 0.96 < 就绪 1.444，playout underrun 如实记）；**没有「正文早就 ready 排队」**。
3. **真正的大头不在 4 s 上限本身，在 ASR 开始得太晚**：设备 36.025 才发 begin（等 input_ready，wake 后 2.4 s），说完的音频在端侧攒着；worker 收到 begin 后 **0.99 s** 就拿到整句 final（`first_final_ms=992`）。**合同 v0.3 与 worker 实现都允许 begin 先于 input_ready**：job.rs 原文「begin 可早于用户轨订阅到达」，入站包先进 256 深通道缓冲（≈10 s 音频），pipeline 接管后按序消费，STT 发送端在主循环前已就绪。端侧改成「连上就发 begin+pre-roll」= **零 worker 改动**，ASR 可提前 ≈1.3–1.8 s 开始。
4. 在此之上，worker 借现有 ack 带最薄「结束候选」提示（条件 = 已 hold 整句 final ∧ worker 在同一有序 PCM 上量到尾部安静 ≥600 ms），设备收到即发 end；完整性门不变、不在 end 前 commit、不把第一条 final 当整句（安静条件就是为了这个）。本房若两条都在，end 可从 37.63 提到 ≈35.7（推算）。
5. 再上一层：worker 把 LLM 投机挂到 held final（现有 S1v3 `start_speculation`，ordered 模式目前旁路），把 458 ms TTFT 藏进领先量，正文就绪 ≈+0.6 s 与最短垫句持平，空档≈0。
6. 不做：缩垫句、调增益、缩 4 s、换 ASR 参数、动 AEC/音量（同意）；字幕仍低优先级。

## 1. 本房字段（trace 993c3722… / input 893666e1… / job AJ_WwTjxerYREAd；worker UTC；已验证）

| 项 | 值 |
|---|---|
| job request / input_ready / output_ready | 02:14:35.758 / 36.167 / 37.242（elapsed 1473） |
| ordered_pcm result | 39.111 `complete`，finals 1 / finals_held 1 / samples_queued 95680 / text_chars 8 |
| decision evidence | first_chunk_ms 92 / **first_final_ms 992** / **end_ms 1601** / stream_end_ms 1692 / **final_lead_over_end_ms 609** / interims_held 4 / final_before_end 1 / chunks 158（packets 160）/ keep_from=first_sample 723680 / end_sample 819360 / rtc_frames_dropped 295 / silence 9600 / duplicate、rejected、queue_full、interrupted 均 0 |
| turn committed | 39.115「小可小可测试一下」**eou_ms=3**；commit 恰 1；device.command 0 |
| filler | `bucket=gen dur_ms=960 policy=shortest text='嗯。'`（用户换题落 gen 桶，未照搬 ask） |
| LLM / TTS | race won main race_ttft 458（39.574）；stream done 40.270（28 字）；tts synth 40.270；tts_ttft 290；整句合成完 43.363（6320 ms 音频） |
| 播出三时戳 | `body_ready_since_turn_ms=1444`（字段=事件时刻；行在 43.363 才出）；`filler playout done` +999；`body first frame published` +1449 |
| playout | underrun 1 × 485 ms（first_underrun 754 自 audio_start）；played 728 帧 = 0.96 + 6.32；drained 46.901 |
| 收尾 | participant disconnected 59.191 → job closed 59.237（uptime 23）；WARN 1（P2 termination，良性）/ ERROR 0 |

首条 held final 的文本未单独记录（只有计数）；本房 finals=1 无歧义。多 final 房建议在 evidence 加 `first_final_chars`（计数不记文本）。

## 2. 与端侧时间线对齐（推断：δ = worker − 设备 ≈ 1.33–1.39 s，三锚）

- begin：设备 36.025 → worker 处理 ≈37.42（= result 39.111 − stream_end_ms 1.692）；end：设备 37.633 → worker 39.02（= begin + 1.601）；result：worker 39.111 → 设备 37.780。
- 整句 final 到 worker 38.41 = 设备钟 ≈37.06；设备 end 37.633 → 领先 0.57–0.61 ✓。
- 说完话时刻（推断，无录音）：wake 33.612 在唤醒词尾，「测试一下」≈0.9–1.2 s → ≈34.5–34.8；与 speech_ms=1720 相容。
- 链条：说完 →（等 ready）→ begin 36.025 ≈ **1.3 s** → 整句 final ≈37.06（begin 后 0.99）→ 等 4 s 上限 → end 37.633（**0.61**）→ result 37.780（0.15）→ commit（0.004）→ 垫句到端 37.928（0.16）→ 正文起播 ≈39.21（commit 后 1.449，空档 0.485）。**说完→正文首音 ≈4.4–4.7 s（推算）**：可动的三块 = ASR 前等待 ≈1.3 + final 后等 end 0.61 + 正文生成 1.45。

## 3. 整体提速路线（按收益/改动比；每条独立可回滚）

| # | 改动 | 归属 | 依据 | 预计收益（本房口径，推算） |
|---|---|---|---|---|
| 1 | **设备连上就发 begin+pre-roll，不等 input_ready** | codex（端侧，需 >v249 APK） | job.rs「begin 可早于用户轨订阅到达」+ 256 包缓冲 + STT 主循环前就绪；合同 v0.3 原文 | ASR 提前 1.3–1.8 s；整句 final 在说完后 ≈0.8–1.0 s 到 |
| 2 | worker 在 ack 带可选 `end_candidate`（held 整句 final ∧ 同 PCM 尾部安静 ≥600 ms，门限相对本代次语音峰值），设备收到即 end | cc（worker）+ codex（端侧响应；无字段=无提示，可忽略） | 本房 lead 609；端侧 RMS≤80/peak≤320 在真麦 quiet=0 | 去掉 final→end 等待（本房 0.61；#1 后更大） |
| 3 | held final 起投机 LLM（复用 `start_speculation`；commit 时文本/版本相同才消费，否则丢弃） | cc | 现有 S1v3 机制，ordered 旁路 | 藏 0.46–0.9 s TTFT；空档≈0 |
| 4 | 4 s 上限保留兜底；字幕/AEC/音量/固件不动 | — | codex §5 | — |

叠加（推算）：说完→正文首音 ≈4.4–4.7 s → **≈1.6–2.0 s**；只做 #1+#2 → ≈2.4–2.8 s；只做 #2+#3（不刷 APK）→ ≈3.3–3.6 s。

## 4. 请 codex / 川哥定的

- #1 本轮改不改端侧（v249 不能测，要 >249 的 APK，冻结与回滚照旧）。
- #2 字段名与语义（建议 ack 加 `end_candidate: true` + `quiet_ms`，只在条件成立时出现）；worker 侧安静门限用相对峰值不用固定 80。
- #2/#3 若点头，cc 只换 POC unit（保留 B8 产物回滚），一个自有合成房验证后回交，不占 Android 剩余 3 房。

## 5. 未验证 / 未知

- 说完话物理时刻（无录音）；两机绝对钟只用于排序。
- #1 真机上 begin→pipeline 接管的缓冲量（≈0.6 s，通道够）。
- 首条 held final 文本（本房无歧义）。

署名：cc（Claude）| 2026-09-09 10:25 CST
