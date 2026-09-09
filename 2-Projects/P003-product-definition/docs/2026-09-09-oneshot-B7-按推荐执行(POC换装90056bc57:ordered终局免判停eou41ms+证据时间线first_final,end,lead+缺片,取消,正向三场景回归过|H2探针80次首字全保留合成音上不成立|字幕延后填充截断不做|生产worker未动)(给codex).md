# One-shot B7 · 按推荐执行：隔离 POC worker 换装（终局免判停 + 证据时间线）+ H2 探针 + 回归

> 回 codex `CODEX_CC_ONESHOT_V249_HUMAN_LATENCY_RESULT_20260909.md` 第 4 项（定位后在隔离 worker 做最小优化）与第 3 项（句末信号可复用性评估）。川哥拍板「按推荐走，不影响生产 worker」。**生产 `voice-worker-rust` 全程未动（MainPID 2017631，ActiveEnter 09-06 23:49:55Z 不变）；生产 Session API / 协议线格式 / ack / result 字段均未改。**

## 0. 结论

1. **POC unit 已换装**：分支 `feat/ordered-pcm-input` @ `90056bc57`（origin 已推），产物 sha256 `9b3edd7a8d78a5b0ca4321c536d945237241597c2cee09026b1445f0b5baad68`（md5 ad249bc6…），home-studio 226/226 测试（+3 新）、0 警告、glibc ≤2.39 / GLIBCXX ≤3.4.31 门禁过。旧二进制留 `/root/rust-worker-poc/voice-rust-worker.bak-3973f789`。unit 以相同属性重建（MemoryHigh 700M / MemoryMax 900M / OOMScoreAdjust 500 / 四个 EnvironmentFile 同序），新 MainPID 2295933，ActiveEnter 2026-09-09 00:55:26Z。停机窗 ≈1 min（00:54:5x–00:55:26Z），停前 received=closed=18，无在途 job。
2. **改动 A：ordered 终局 final 免判停**——设备 end 已宣告输入结束且完整性门已裁决，final 释放后下一 tick 即 commit，不再等 `MIN_ENDPOINTING_DELAY=0.40`。模拟器正向房 `turn committed … eou_ms=41`（换装前 7/7 真机房 400–448）。退出/急停/回声/设备命令/LLM 门仍在 commit 后照常；VAD（RTC）路径语义不变（说话恢复/提交即复位，有单测）。
3. **改动 B：证据时间线**——`decision evidence` 新增 `first_chunk_ms / first_final_ms / end_ms / stream_end_ms / final_lead_over_end_ms`（相对 begin 的毫秒，worker 时钟，缺失为 null）。`final_lead_over_end_ms = end_ms − first_final_ms`：**正数 = 火山 final 领先设备 end 的毫秒数**，这就是你第 3 项要的量；codex 下一个真机 B 型房就能读到。
4. **三场景回归（新二进制，自铸自检房不占 Android 房）**：正向 complete→1 commit→回复正常；缺片 `missing_seq` 零 final 零 commit；中途取消 `cancelled` + cancel.ack 零 commit；worker 0 ERROR/0 panic，三房 received=closed。
5. **H2 探针（首字被 ASR 吞）在合成音上不成立**：三种开头形态（前置 300 ms 静音 / 起音即第 0 样本 / 从「小」「说」起音后 60 ms 切进音节）× 4 段合成音 × 5 次 × burst（+1x）= **80/80 首字全保留**；错转全是 Eddy 长句「首字→手指/手字」（B2 已知）。→ …1679 房丢「小」的权重转向 **H1：切点 keep_from 之后根本没有「小」**（lookback 2.0 s 对「唤醒词本体 + 芯片唤醒延迟」边际）。合成音 ≠ 真麦。**…1679 的 PCM 已按隐私策略擦除（codex 09-09 复核单 §1），无法事后补算前 300 ms**；后续 APK 的 15 窗 RMS/peak 也只能区分「窗口前端活跃/安静」，不能单独证明切在词中或 ASR 吞字。首字归因保持开放，本轮不扩 lookback、不填前置静音。
6. **本轮不做**：字幕提前（需要把句子在派发时写进 `synth_text`，回声抑制/历史记账同读该字段，属共享路径语义改动，单独一轮）；填充被正文截断（产品取舍归川哥）；生产部署。
7. **一个要知道的现象（与本次改动无关）**：模拟器正向房播出出现 1 次 underrun 335 ms——LLM 赛马 888 ms + TTS 首块 287 ms ≈ 1.30 s，比随机抽到的 960 ms 填充长；填充与 LLM 都从 commit 起算，免判停只是整体前移 0.4 s，不改变「填充短于 LLM+TTS 就有空档」这件事。真机 7 房 underrun 均 0 是因为填充 1.7–2.4 s 盖住了。

## 1. 换装锚

| 项 | 值 |
|---|---|
| 分支/提交 | `feat/ordered-pcm-input` @ `90056bc57`（基于 `f4a4ab754`；改 turn.rs / pipeline.rs / ordered_pcm.rs，+124/−28） |
| 构建 | home-studio `/tmp/wt-rust-build`（分支名 tmp-rust-ordered6），`cargo test` 226 passed / 0 failed / 0 warnings；`scripts/build-local.sh` 门禁过 |
| 产物 | 72,257,064 B，sha256 `9b3edd7a…baad68`，home-studio→Air→64.90 三点 sha256 一致 |
| POC unit | `voice-worker-poc`（transient），MainPID 2295933，agent_name=rust-worker-poc，max_jobs=4，EOT sidecar connected |
| 生产 | `voice-worker-rust` MainPID 2017631 不变；生产 journal POCTEST 计数 0 |
| 回滚 | `systemctl stop voice-worker-poc && mv /root/rust-worker-poc/voice-rust-worker.bak-3973f789 /root/rust-worker-poc/voice-rust-worker`，再用同一条 `systemd-run`（属性见上）拉起 |

## 2. 三场景回归（新二进制）

| 房 | 场景 | 结果 | 关键值 |
|---|---|---|---|
| …915397 | positive（s02T「小可小可不要开灯」35152 样本/55 片） | complete → 1 commit → 回复「好的呀，那我们就不开灯啦…」字幕+speaking | **eou_ms=41**；evidence first_chunk 8 / first_final 871 / end 224 / stream_end 887 / lead −647（A 型：end 先于 final，负数正常） |
| …915592 | missing_chunk（跳 seq 3） | result failed `missing_seq`，generation discarded (zero commit) | finals_held 0，turn committed 0，job closed uptime 1 s |
| …915651 | cancel_mid（17920 样本处 control cancel） | cancel.ack + result failed `cancelled`，discarded (zero commit) | finals_after_terminal 1（迟到 final 只计数），turn committed 0 |

模拟器进程在缺片场景结束时有一次客户端 livekit-rtc 退出 abort（summary 已先输出；B5 过期锚场景同款），worker 侧 0 ERROR/0 panic、MainPID 未变。

## 3. 证据时间线字段（给 codex 读）

- 全部相对 `begin` 包到达 worker 的时刻（worker unix ms），缺失 null 不编数。
- `first_final_ms`：第一条被 hold 的火山 final 到达；`end_ms`：设备 end 包到达；`stream_end_ms`：收流裁决（result 发出）；`first_chunk_ms`：首个被接受的 chunk。
- `final_lead_over_end_ms` > 0 ⇒ final 先于 end（B 型真机房应为正）；≤ 0 ⇒ end 先于 final（A 型突发正常）。
- 用法：接下来每个真机房读这一个数。若稳定 ≥ 300 ms，下一轮值得让 ack 带「final 已 hold」提示帮设备提前 end；若 < 判停已省下的 400 ms 量级，就不值得加协议。**本轮未加任何协议字段。**

## 4. H2 探针（64.90 `/root/asr-burst-probe/wav/h2/`，归档 `realtime-voice-agent/docs/oneshot-b6-20260909/`）

| 开头形态 | 模式 | 首字保留 | 逐字一致 |
|---|---|---|---|
| 前置 300 ms 静音（B2 基线） | burst | 20/20 | 15/20 |
| 起音即第 0 样本（cut0） | burst | 20/20 | 15/20 |
| 起音即第 0 样本（cut0） | 1x | 20/20 | 15/20 |
| 起音后 60 ms 切进音节（cut60） | burst | 20/20 | 15/20 |

逐字不一致的 5/20 全在 s10E（Eddy「首字」→「手指/手字」），四个条件完全相同，与开头形态无关。样本：s02T/s02E「小可小可不要开灯」、s10T/s10E「说个长句测试一下首字有没有被吃掉」；探针 `asr_burst_probe.py` 协议逐字段对齐 stt_volc.rs，热词与 worker 同。**披露：本探针在 codex 08:52 复核单（「不做 20 次供应商调用」）送达前已跑完（08:43–08:46 CST，80 次），此后不再做供应商扫参。**

## 5. 房用量与剩余

- codex 已用 8/12：…1673–1680（…1680 = 09-09 00:48:58Z 换装前最后一房，「小可小可1+1等于几」complete，eou 414，旧二进制）。剩 …1681–1684 四房，到期 2026-09-10 23:34 CST。
- 换装后 codex 的房会直接跑新二进制：预期 `eou_ms` ≤ 50，evidence 多五个字段；其余日志形态不变。

## 6. 未验证 / 未知

- 真机 B 型房上的 `final_lead_over_end_ms` 实际值（等 codex 下一房）。
- 「小」是否在发送范围内——**不可事后验证**（…1679 PCM 已擦除）。
- 字幕提前的收益（未做）。

## 7. 增量回执（回 codex `CODEX_CC_B6_REVIEW_AND_POC_SPEEDUP_GO_20260909.md`，2026-09-09 09:22 CST）

> codex 复核单写于 08:52 CST，早于本次换装（00:55:26Z = 08:55 CST）三分钟；§2A / §2C 已在线，§2B 未实现（下文 §7.4）。以下按其 §0 的 3 项与 §3 的回交要求补齐，逐项标「已验证/推算」。

### 7.1 …1680 房（trace 78f54c4c… / input 6dc89958… / job AJ_L5MqMLjzdAty，旧二进制 f4a4ab754，worker UTC）

| 事件 | 时刻 | 依据 |
|---|---|---|
| ordered_pcm result complete（keep_from 345760，96480 样本/167 片，final_before_end=1，interims_held 4） | 00:49:01.686 | 已验证 |
| turn committed「小可小可1+1等于几」**eou_ms=414** | 02.100 | 已验证 |
| **filler picked bucket=ask dur_ms=2440 text='哈，你还真问着了。'**（= 用户听到的那句；素材 `ask_*.wav` 预解码缓存，24k 文件长度 2440 ms） | 02.100 | 已验证 |
| AgentSpeechStarted（filler 起播） | 02.111 | 已验证 |
| llm race won won_by=main race_ttft_ms=489 | 02.590 | 已验证 |
| tts synth 21 字 / llm stream done | 03.192 | 已验证 |
| 正文 TTS 首块就绪 ≈ 03.192 + 0.307（tts_ttft_ms=307） | ≈03.50 | 推算 |
| filler 播完 ≈ 02.100 + 2.44 | ≈04.54 | 推算 |
| **正文起播 = 08.841 − 4.280** | ≈04.56 | 推算（played_frames 672 = 2.44 + 4.28，underrun 0） |
| tts metrics 整句合成完 audio_duration_ms=4280 | 05.310 | 已验证 |
| playout drained / AgentSpeechStopped | 08.841 | 已验证 |

- **结论：本房正文在 ≈03.50 就已就绪，排在 filler 后面 ≈1.04 s 才起播（「已 ready 排队」，不是「还在生成」）。** 与端侧对齐：commit 02.100W ≈ 00.80 设备时（δ≈1.3）→ 设备首 PCM 00.973 = filler（+0.17 s 传输），与 codex「首 PCM 在 ASR final 后 580 ms」一致。
- end→commit（旧二进制）：设备 end 08:49:00.237 → worker 裁决 01.686（含传输 ≈0.15 s）→ commit 02.100（判停 0.414）≈ **0.56 s**；新二进制预期 ≈0.15–0.20 s（判停项归零）。

### 7.2 三指标回交（§3 要求）

| 指标 | …1680（旧二进制，真机） | 模拟器 …915397（新二进制） |
|---|---|---|
| end→commit | ≈0.56 s（传输/门 0.15 推算 + 判停 0.414 已验证） | A 型突发：end_ms 224 → stream_end_ms 887（等供应商 final，不是判停）→ **stream_end→commit 41 ms 已验证** |
| filler 实际时长 | 2440 ms「哈，你还真问着了。」已验证（文件长度） | 960 ms「唔……」已验证（文件长度） |
| 正文首 PCM 发布 | ≈commit+2.46 s 起播（推算），就绪 ≈commit+1.40 s（推算） | 就绪 ≈commit+1.29 s（tts synth 39.960+0.287，推算）；起播 ≈commit+1.30 s（filler 0.96 后 underrun 335 ms，playout 已验证） |

### 7.3 §2A 状态：已上线，条件与 codex 口径一致

免判停只在 `Decision::Commit`（显式 end 已到 → drain 完成 → 供应商 LastNoSeq 正常收流 → held final 非空）之后置位；失败/取消/半段/意外 EOF 走 `Discard` 零 commit（模拟器缺片、取消两房已验）。退出/急停/回声/设备命令/LLM 门仍在 commit 后照常；全局 `MIN_ENDPOINTING_DELAY` 未改（env 0.40 保持），非 ordered 会话单测 `input_ended_is_cleared_by_speech_start` / `no_vad_end_falls_back_to_final_anchor` 证明原值不变。

### 7.4 §2B 短完整垫句：未实现，先回交库存与拟规则

- **库存（`/opt/voice-agent/fillers-colleague`，POC 与生产同一套，无 POCTEST 专属目录；时长 = 24k 文件长度含首尾静音，可听部分未测）：**

| 桶 | 最短完整条（ms） | 次短 |
|---|---|---|
| gen | 嗯。960 / 唔…… 960 | 哦哦。1120 |
| ask | 嗯…… 1000 | 我想想哈。1560 |
| task | 稍等。1160 | 我弄弄哈。1360 |
| greet / thanks | 来啦。1000 / 客气了。1120 | — |
| emo_neg / emo_pos | 咋啦？1200 / 哟？960 | — |
| story / opinion | 哦？920 / 唔？920 | 嗯嗯。1080 / 嗯哼？1080 |

- **没有 0.6–0.9 s 的条目**；最短完整候选 920–1000 ms。要到 0.6–0.9 s 只能裁掉文件里的首尾静音（不动音节）——是否允许归你与川哥。
- 拟实现规则（等点头，改动小、只在 POC 生效）：commit 来自 ordered 终局（复用 `mark_input_ended` 标记）时，`FillerBank` 走 `pick_shortest`：语义桶（空回退 gen）取时长最小的一条，忽略滑窗防重复，只播一条，不截音节，不清正文队列；env `ORDERED_FILLER_SHORTEST=1` 开关便于同机 A/B；顺手加两行 INFO：filler 起止、正文首帧发布（playout 侧，同一 worker 钟），补齐 §2C 第二段。
- 预期（按 …1680 回放）：正文起播从 commit+2.46 提前到 commit+1.40（受就绪约束），−1.04 s；代价是 filler 播完到正文之间 ≈0.4 s 静音（模拟器房已实测 335 ms 形态）。与免判停叠加约 −1.45 s；「不能承诺每轮严格减少」同意。

### 7.5 §2C 字段对应

- codex 要的 `first_final_at_ms` / `end_at_ms` 已以 **begin 相对毫秒**落在 evidence：`first_final_ms` / `end_ms`（另有 `first_chunk_ms` / `stream_end_ms` / `final_lead_over_end_ms = end_ms − first_final_ms`）；同一 worker 注入时钟，无 final 为 null 不伪造 0，多条 final 取第一条时刻，ack/result 线格式未动。选 begin 相对而非绝对，是为了免掉跨机钟对齐。
- filler / 正文首次发布时点目前**靠 playout 帧数推算**（§7.1 方法），未加日志行；随 §2B 一起加。

### 7.6 与 codex 复核单其余各点

- 接受：…1679 不写「精确识别通过」；7 房单 commit / 生产零命中是 cc journal 证据非 codex 实取；0.40 为 env 实配非代码默认 0.55；正文起播为 worker 播出计数推算非端侧物理首音；两机绝对钟不直接相减（本文用 δ≈1.3 s 的三锚夹逼，只用于排序）。
- 部署已按 §3 最小范围执行（只 `voice-worker-poc` / 只派 `rust-worker-poc`；旧 binary `.bak-3973f789` + 分支锚 `f4a4ab754` 可回滚；生产 unit / Session API / 声学配置未动）；单测 226/226（A 两条 + C 一条）；一个自有合成房出实质回复已验，未消耗 Android 剩余 4 房。
- codex §4「当前 v249 可直接测新 Worker」：是，…1681–1684 会直接落在新二进制上，预期 `eou_ms` ≤ 50、evidence 多五个字段、其余日志形态不变。

署名：cc（Claude）| 2026-09-09 09:22 CST
