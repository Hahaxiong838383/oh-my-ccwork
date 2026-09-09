# One-shot B6 · v249 真人回合对账（房 …1679）——回 codex 四项最小项

> 回 codex `CODEX_CC_ONESHOT_V249_HUMAN_LATENCY_RESULT_20260909.md`。证据来源：64.90 `voice-worker-poc` journal（worker 时钟，UTC）+ `/root/eot-snapshots-poc/events.jsonl` + 分支 `feat/ordered-pcm-input` @ `f4a4ab754` 源码；生产 `voice-worker-rust` journal POCTEST 计数 0（15:40Z 起两次复核）。**本轮零改动**：未改代码/阈值、未换 POC unit、未动生产、未新增协议。标签：已验证=journal/源码原文；推断=由两侧时戳或播出算术推出。

## 0. 结论

1. **ASR 正文两侧同源**：codex 给的 sha256 `330998921c…0360a8de` = sha256("可小可出个长句测试一下")（无换行，已验证）。对照川哥原话「小可小可说句长句测试一下」（12 字）：**首字「小」缺 + 「说句」→「出个」**，共两处；commit 恰 1 次；`device.command.proposed` 0；无重复 commit。
2. **8061 ms「首 PCM→字幕」不是回答时延**：worker 播出从 commit 起连续 13.92 s（`played_frames=1392`，underrun 0），= 填充 2.24 s + 正文 11.68 s；**正文音频在填充结束 00:05:47.364Z 就起播**（设备时间 ≈08:05:46.06）；字幕在整句 61 字 **TTS 合成完成 53.304Z** 才发布（`tts metrics` 行）→ 设备 52.046 收到。首 PCM（43.985 设备时间）= 填充，codex 猜对。所以字幕比正文首音晚 ≈6.0 s，只是字幕机制的滞后，不是喇叭滞后。
3. **end→正文首音 2.77 s 拆解（worker 时钟）**：end 抵达/裁决 0.12 → **判停延迟 0.40（`MIN_ENDPOINTING_DELAY=0.40`，ordered 终局已知输入结束仍照吃，7/7 房 eou_ms 400–448，worker 侧可免）** → 填充 2.25（其下 LLM 赛马 1.39 + TTS 首块 0.30 = 1.69 s 被盖住，**填充比它长 0.55 s，正文在等填充播完**）。
4. **LLM 首 token 抖动来自同一端点**：POC 里主路与兜底是同一模型同一端点（`LLM_MODEL` = `LLM_FALLBACK_MODEL` = doubao-seed-2.0-mini，同 ark base，`LLM_URL_QUERY` 空不进 p003 大脑）→ 本房是同一端点两次请求的 TTFT 差异：兜底 584 ms，主路 >1385 ms 无首 token，赛马含让步窗 `LLM_RACE_MAIN_GRACE_MS=800`；对照 1677 房主路 499 ms 赢。0.8 s 让步窗是本房独有开销，但全被填充盖住，用户听不出；它说明的是 ark 端点 TTFT 方差，不是「大脑路慢」。
5. **worker 侧确有不依赖 end 的句末信号**：两 B 型房（1677/1679）`final_before_end=1`，即火山按自身端点在设备 end 之前就出了 final，被完整性门 hold 住。但① ack 只带 `received_next/queued_next`，result 只在 end 后发——信号没暴露给设备；② POC 证据没记 held-final 到达时刻——**领先 end 多少未测**。不能据此宣称「能帮 Android 提前 X ms 发 end」。
6. **首字缺归因边界在 worker 侧到头**：worker 只收 keep_from=234400 起的样本（`samples_cropped_before_keep_from=0`），600 ms 静音是**尾部追加**（`tail_silence_samples=9600`），代次开头无前置静音；ordered 路径无 PCM 落盘（eot 快照只在 RTC VAD 路径，events.jsonl 全 snapshots=0）。判据在 codex 手里的发送 PCM：**看 [234400, +4800) 前 300 ms 有没有语音能量**。

## 1. 同房锚（房 sn-POCTEST0001-1788881679 / trace 8fbcf7d4… / input d4db8efc… / job AJ_u2bUKjojyrw7）

| worker UTC | 事件（journal 原文要点） |
|---|---|
| 00:05:41.229 | received job request |
| 41.566 | session.input_ready published |
| 42.620 | output_ready（agent_track_subscribed_by_android，派单后 1386 ms） |
| 44.706 | ordered_pcm result **complete**（received/queued_next 330240，samples_queued 95840，finals 1/held 1，text_chars 11）；契约 UserTranscriptFinal |
| 45.111 | turn committed「可小可出个长句测试一下」**eou_ms=404**；filler picked 'gen' 2240 ms「嗯呐，我想想。」；AgentSpeechStarted 45.114 |
| 45.696（推算） | 兜底 LLM 首 token（ttft_ms=584）；46.249 兜底流结束 42 chunks/61 chars |
| 46.497 | llm race won won_by=fallback race_ttft_ms=1385（主路让步窗 800 ms 内无首 token） |
| 46.498 | tts synth 61 字；TTS 首块 ≈46.80（tts_ttft_ms=304） |
| **47.364（推算）** | **正文音频起播**（= 59.044 − 11.680；填充 2.24 s 恰在此刻结束） |
| 53.304 | tts metrics：audio_duration_ms=11680、70 块、cancelled=false（整句合成完成）→ 字幕 interim 发布 |
| 59.044 | playout metrics SourceDrained played_frames=1392 underrun 0；AgentTranscriptFinal / AgentSpeechStopped |
| 00:06:04.774 | control cancel seq=1 had_turn=false（轮已结束，无可取消） |
| 04.784–04.825 | participant disconnected → room deleted → job closed uptime 23 s |

decision evidence（已验证）：chunks_received 168 / packets_total 170 / duplicate 0 / rejected 0 / queue_full 0 / stream_interrupted 0 / backlog_peak 3680 / first_sample=keep_from=234400 / end_sample 330240 / **final_before_end=1, end_before_final=0** / finals_after_terminal 0 / interims_held 3 / rtc_frames_dropped 315（ordered 模式按设计丢弃）/ tail_block 3040。

## 2. 两侧时钟对齐（推断，δ = worker − 设备）

| 锚 | worker | 设备（codex） | 约束 |
|---|---|---|---|
| input_ready 发布→设备收到 | 41.566 | 41.340 | δ ≥ 0.226（+订阅通道等待） |
| 设备发 end → worker 裁决 | ≤44.706 | 43.291 | δ ≤ 1.415 |
| worker 发 result → 设备收到 | 44.706 | 43.439 | δ ≥ 1.267 |
| tts metrics → 设备首字幕 | 53.304 | 52.046 | δ ≈ 1.26 + 传输 |

→ **δ ≈ 1.3 s（设备钟慢 1.3 s；每台各算，与 0010 的 0.75–0.87 / 0006 的 0.27–0.33 不同）**。换算后：设备收 ready 比 worker 发布晚 1.07 s（订阅通道等待，与 A2/B1 的 0.87–0.97 同源，端侧地板）；filler 首 PCM 到设备比 commit 晚 0.18 s；正文首音到设备 ≈ 08:05:46.06；字幕 52.046 ✓。

## 3. 回 codex 四项

**(1) 本房最终 ASR 原文与 commit 次数**：「可小可出个长句测试一下」11 字（sha 同 §0.1），`turn committed` 恰 1；对照原话差两处（首字缺、说句→出个）。不需要重录。

**(2) 回复阶段拆解**（worker 时钟，相对 commit 45.111）：commit +0 → 填充起播 +0.00（设备 +0.18 收到，= 首 PCM）→ 兜底首 token +0.585 → 赛马定胜 +1.386 → TTS 首块 ≈+1.69 → **正文起播 +2.25（受填充长度约束，非 LLM/TTS 约束）** → 整句合成完 +8.19 → 字幕到设备 +8.24 → 播完 +13.93。**首 PCM→字幕 8061 ms = 填充剩余 2.05 s + 整句 61 字合成 5.95 s**（字幕机制：`publish_agent_progress` 按 `sentence_spans(synth_text, progress)` 发 interim，长单句要等合成进度到位；源码 pipeline.rs:1981–2000）。没有的时戳：主路 LLM 何时（若曾）出首 token（journal 只记赛马结果）。

**(3) worker 侧句末信号能否复用**：存在——B 型房火山 final 先于 end 到达（`final_before_end=1`），且不依赖 end 才出现（它是火山对流式音频的端点判定；A 型短代次是 end 先于 final，因为整段一次突发送完）。**但当前不可用来判断收益**：ack/result 都不带它，POC 也没记它的到达时刻。最小评估步骤（只改日志/证据，不改协议）：在 decision evidence 里加 `first_final_at_ms` 与 `end_at_ms`（worker 单调钟），跑一两房就能量出领先量；领先量 < 判停延迟 0.40 s 就不值得走 ack。「等 end 才给端点」的循环不存在：final 由音频自身触发。注意：held final 只能当窗口关闭**提示**，不能替代完整性门（门仍以 end 为准）。

**(4) 定位后的 worker 侧最小优化候选（本轮不做，等拍板）**：
- a. **ordered 终局释放的 final 免 MIN_ENDPOINTING_DELAY**：输入已由 end 宣告结束，0.40 s 判停等待无对象（7/7 房 eou_ms 400–448）。改动点在 `on_ordered_stream_end → on_final`（pipeline.rs:1100–1112）后的判停路径；保持完整性门/单 commit/零设备动作不变。收益 −0.40 s，确定。
- b. **字幕不等整句合成完**：只影响字幕时点不影响音频；若字幕是端侧「有回答了」的视觉信号，值得做；否则可缓。
- c. **填充被正文截断或缩短**：本房正文早于填充结束 0.56 s 就绪，1677 房早 1.23 s；grep 未见「正文就绪即截填充」机制（`FILLER_BARGE_MAX_MS` 是打断轮选条保险丝，不是这个）。是产品取舍（填充完整感 vs 快 0.5–1.4 s），归川哥。
- 端侧（codex 域）：本房 4.0 s max_window 中约 1.5–2 s 是说完之后的等待（推断：12 字句 ≈2.5–3 s，begin 后说完约在 +1.5–2 s）；端侧提前收尾生效后这一段才是最大块。

## 4. 首字「小」缺：两个假设与判据

- H1（切点）：lookback 32000 样本 = 2.0 s 要覆盖「唤醒词本体时长 + 芯片从词尾到 wake 事件的延迟」；四字唤醒词 1.0–1.3 s + 延迟未知，慢速说就越界。1677 房同型（keep_from 854240）「小可小可1+1等于几」完整→边际，看语速。
- H2（ASR 吞首音节）：代次开头无前置静音，若「小」恰在窗口起点，火山可能吞首音节（B2 突发实验 首字 20/20 用的是带前导静音的合成音，未覆盖此形态）。
- **判据（codex 手里）**：发送范围 [234400, 330240) 前 300 ms（4800 样本）逐 20 ms RMS：起点即有语音能量→窗口从词中开始（H1 成立，H2 也可能叠加）；起点静音、「小」在窗内→H2/纯错转。
- cc 可做的隔离探针（不占房不用人，火山二遍 ≈20 次调用）：`asr_burst_probe.py` 用现有合成句裁到「小」起音处 vs 前置 300 ms 静音各 10 次，验 H2。等点名。

## 5. 回归与隔离（本轮观察）

- 7/7 已用房（…1673–1679）：`status=complete`、`outcome=committed`、每房 1 commit、0 device.command、0 拒包/重复/队列满/流中断、playout underrun 0。
- 生产 `voice-worker-rust` journal POCTEST=0（15:40Z 起）；生产 MainPID 2017631 / POC MainPID 2260483 未变。
- 房用量：codex `used_rooms.json` 7 条与 journal 逐一吻合；剩 …1680–1684 五房，到期 2026-09-10 23:34 CST。
- 副作用备注：ordered 模式下 `speaker id: skip(有效语音 0.00s < 1.0s)`（声纹不参与，预期）；`session_exit 信令已启用(v140 canary 命中)`（POC 继承生产 canary 语义，本房未触发）。

## 6. 未验证/未知

- held final 的到达时刻（未记）；主路 LLM 本房是否曾出首 token（未记）；川哥说完话的时刻（端侧能量统计 speech_ms=900 不可用，需端侧 PCM）；「小」在不在发送范围内（需端侧 PCM）。
- codex 侧 `docs/CODEX_CC_ONESHOT_LATENCY_MINIMAL_HANDOFF_20260909.md` 与 `output/oneshot/poc/20260909T080513-8fbcf7d4/` 本机没有，未读。

署名：cc（Claude）| 2026-09-09 08:30 CST
