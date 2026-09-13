# B69｜控制出口修复：IMPLEMENTED_NOT_DEPLOYED（已构建，未上线）

> **勘误（B71，2026-09-13）**：codex B70 §2 指出本文三处文案错误，已接受：① §1.1「编译期绕不过去」不成立——参数强制只防漏传，防不了调用点在函数前加 return（注入③已证）；② §1.2「控制词走不进 echo_short_turn_at 打标」错——`n_chars <= 3` 打标在豁免后仍可达，只是 STOP 随后终止旧轮故无新后果；③ §0「09:21 UTC」应为 01:21 UTC / 09:21 CST。详见 B71。

**给 codex 的回执**（按 B68 §7 结构）。第一步 Worker 最小修复已实现、已提交、已在 home-studio 出产物、**没有传到 64.90、没有换装、没有重启任何 unit**。灰度 env 零改动（没有新键）。等你确认窗口。

---

```text
结论：IMPLEMENTED_NOT_DEPLOYED
```

## 0. 当前线上锚、新提交、完整产物

| 项 | 值（本轮 09:21 UTC 只读实测） |
|---|---|
| 单机灰度 unit | `voice-worker-firstturn`，MainPID **2734957**，ActiveEnter **2026-09-12 08:34:40 UTC**，NRestarts 0 |
| 线上 exe SHA256 | `71e42ab0cf9d595ca799d0d62eff05fba43a5b857202c4ca6121a278c5a7b246`（与 B63 历史真值一致，未变） |
| 线上源码锚 | `0093c85e80daaf899260a3bd71d0c5a098ced6cd`（未变） |
| 生产 `voice-worker-rust` | MainPID 2720004，ActiveEnter 2026-09-12 06:48:18 UTC，**未动** |
| 新提交 | `299b074baa8a960f5c19325cbf00e83b312ad662`（分支 `feat/ordered-pcm-input`，已推 origin；父 `934a336bc`） |
| 新产物 SHA256 | `c2b84b2ec88b3bcfe7d69d767d43a5130b432d630e38a61a7f67d440bc9677c8` |
| 新产物 md5 / 大小 | `2be433abf7c0a9329b852a1a64178613` / 72,569,768 B |
| 构建 | home-studio（Ubuntu 24.04 = 目标机同构）`scripts/build-local.sh`，rustc 1.98.0；符号门禁 glibc 需求 ≤2.39、libstdc++ 需求最高 GLIBCXX_3.4.31（上限 3.4.33）全过；门禁自检负向验证 5/5 变红/放行正确 |
| 产物位置 | Air 中转目录（sha256 复核一致）。**未上传 64.90** |

差量文件：`src/pipeline.rs`（+25/−8）、`src/textproc.rs`（+153/−0，其中新函数约 26 行、其余为测试）、`src/caption_gate.rs`（+4/−1，仅 doc 注释）。3 files, 182 insertions, 9 deletions。

## 1. 改动位置：共同入口怎么覆盖单字 / 词库 / overlap，哪些门保持

### 1.1 一句话

开场窗块内**先算一次** `control_outlet = caption_gate::control_outlet_kind(合并句, hotwords, exit_hotwords, exit_tail_match)`（`pipeline.rs:2938`）——和下面 `swallow_kind`（`:3056`）用的是**同一组判定函数**（`is_stop_only` / `session_exit_tail_hit` / `match_command`），没有第二套词表。然后三道门都认它：

| 门 | 旧代码 | 新代码 | 位置 |
|---|---|---|---|
| 单字规则 `n_chars == 1` | 在函数外，命中即 `return` | 搬进 `textproc::opening_echo_verdict(nu, bank, control_outlet)`，outlet 为 Some 时**先于单字判定**返回 None | `textproc.rs:281`；调用 `pipeline.rs:2957` |
| 词库 `local_audio_echo_hit` | 同上 | 同一函数内，同一豁免 | 同上 |
| 重叠窗 overlap | 内联三豁免（急停 / 命令 / 尾表） | `if` 首项加 `control_outlet.is_none()`；**原三条内联豁免保留**（`EXIT_TAIL_MATCH=0` 时 outlet 不含 tail，它们仍是唯一守 tail 的） | `pipeline.rs:3002` |

`opening_echo_verdict` 的形状 = B53 `mark_echo_drop(control_outlet)` 的形状：**不变量在被调方**，调用点必须显式传 outlet，编译期绕不过去；不是在三个命中点各补一个 `if`。

### 1.2 保持不变（逐字）

- 开场窗**外**的路径：`control_outlet` 只在窗内块里算，窗外一行没碰。
- STOP/EXIT 出口本体（`:3056–3125`）、TTS 子串门、设备命令、cmd single exit、普通 LLM 轮：零改动。
- 词表：`INTERRUPT_HOTWORDS` 7 词、`EXIT_SWALLOW_HOTWORDS` 35 词（灰度 env 实读）、尾表、规范化、`MODAL_PREFIX` 剥离：零改动。
- 本地音频词库 filter（`greeting.*`）**没动**：farewell 仍不进库（§3.3 先修出口）。
- `first_speech_onset_at`：没用、没改。
- `echo_drop_caption` / `mark_echo_drop` 的字幕豁免：保留（现在对控制出口是第二道防线；TTS 子串门上的 `command` 类仍靠它）。
- 追杀（chase-abort）、`echo_short_turn_at` 打标：保持——控制词走不进这两处，非控制短句行为不变。

### 1.3 顺带修了一个既存洞（同一个判定的直接后果，不是额外扩 scope）

重叠窗旧内联豁免是「急停 / 命令 / 尾表」三条，**不含 exit 精确词**。「不用了」在 `EXIT_SWALLOW_HOTWORDS` 里但不在尾表（尾表注释明写「不用了」这类高频词不进），对招呼语「你来了故事继续」LCS = 1/3 ≥ 0.3——本会话第 1 句、commit 前无 VAD 起点、截止前说出，旧代码判回声吞掉，用户退不出。`control_outlet_kind` 含 `exit_exact`，加上 `control_outlet.is_none()` 后自动覆盖。测试 `overlap_gate_would_swallow_exact_exit_word_without_outlet` 钉了前提（这层真会命中 + 旧三豁免一条不救）。

### 1.4 2939 那条假注释

「急停单字在此被吞与 stop_only 效果等价：都不成 turn」已改成真话：STOP 出口无条件硬停在途轮（含 paused 待续播的）并作废投机生成，本门只在追杀条件下 abort。

## 2. 测试：矩阵逐行 + 负向验证

基线 312 → **320 passed**，0 failed；`cargo clippy --all-targets` 我改的行号范围内 **0 新增告警**（既有 10 条全在别处）。

**先说清测试的层**：8 条新用例在 `textproc::opening_echo_verdict_tests`，走的是 `control_outlet_kind` → `opening_echo_verdict` 这条真实判定链，**不是**穿过 `on_tick_inner`。原因：`Orchestrator`（`pipeline.rs:406–633`）约 100 个字段，持 Room / mpsc / JoinHandle / OutputGate / ordered Session 等活句柄，单测构造不出，抽出整个 commit 裁决序列又超出 §3.2.2「仅抽这一小段」。所以下面凡是「pipeline 层」的行，证据是**源码行号 + 负向注入**，不是跑过的用例，逐行标明。

| # | 场景 | 结果 | 证据层 |
|---|---|---|---|
| 1 | 开场 15 s 内单字「停」，有 interim，Speaking | 既有硬停保持：`on_interim → check_hotword`（`:1912`，Speaking 且精确命中 → `hard_abort_current`）未动；随后 final commit：outlet=`stop` → `opening_echo_verdict` 返回 None（用例 `stop_single_char_reaches_stop_outlet` ✅）→ 走到 `swallow_kind = stop_only`（`:3056`）→ 不成 turn、0 LLM、0 filler；`swallow_lifecycle("stop_only") = Interrupt` 非终态，不发 session_exit → 房间不关 | 用例 + 行号 |
| 2 | 同词 final-only，Speaking | `on_final` 也调 `check_hotword`（`:1894` 前一行）→ 已急停；commit 再走 STOP 出口：`hard_abort_current` 开头 `let Some(turn) = self.agent_turn.take() else { return }`（`:2586–2591`）→ 第二次是 no-op，无重复终止副作用 | 行号 |
| 3 | 同词 final-only，音频已 pause、仍有可恢复 turn | **这是被修的核心状态**：`check_hotword` 在非 Speaking 直接 return（`:1913`），旧代码单字门吞掉 → `false_deadline` 到期 `paused.take()` 后 `turn.ctl.resume()`（`:2902–2910`）续播。新代码 outlet=`stop` → 放行 → STOP 出口 `hard_abort_current`（`:3112–3115`）→ `turn.ctl.abort(); turn.task.abort(); source.clear_buffer(); paused=None; false_deadline=None`（`:2628–2629`）→ 续播分支的两个前提（`paused.take().is_some()` 且 `agent_turn` 在）都不成立，**不能稍后续播** | 用例（判定层）+ 行号（副作用层） |
| 4 | 开场窗内「再见」恰为告别词槽子串 | 用例 `goodbye_in_farewell_bank_reaches_exit_outlet` ✅：先证 `local_audio_echo_hit("再见", 含 farewell 的库) = Some("farewell.goodbye")`（这层真会命中），再证 outlet=`exit_exact` → verdict None → 走到 `session_exit exact` → 既有信令/端侧收尾路径未动（`:3087–3110`） | 用例 + 行号 |
| 5 | 「退出 / 不聊了 / 退出对话 / 不用了 / 我不想聊了 / 不想聊了，退出吧」 | 用例 `exit_words_and_tails_never_swallowed_even_if_bank_would_hit` ✅：每句把自身放进库保证词库层必命中，outlet 全 Some，verdict 全 None；词表/尾表未改，语义与 exact 同 = 只吞不提交 LLM、不播 filler（出口本体未动） | 用例 + 行号 |
| 6 | 「退出后告诉我怎么重新进入」 | 用例 `question_about_reentry_is_not_control_and_still_echo_checked` ✅：outlet None（`怎么` 疑问豁免）→ 不是控制出口 → **仍过回声门**（同句真在库里时 LCS 1.0 照吞，证明不是免检）→ 库里没有则放行到 LLM；不会误关房 | 用例 |
| 7 | 重复 final / 重复控制 / cancel 晚到 | 未改：`exit_seq`/`exit_pending` 重试同 seq（`:2880–2893`）；cancel 包 `cancelled = first && had_turn`，无在途 turn 时 `cancelled=false` 不报错、不补造 turn（`:2443–2459`） | 行号（本轮零改动） |
| 8 | 非控制的既有已知回声 | 用例 `non_control_single_char_still_swallowed`（「那」→ single-char）、`non_control_bank_hits_still_swallowed`（「刚打了个盹儿」LCS 层 / 「来啦」子串层照吞；「讲个故事吧」LCS 0.4 放行）✅ | 用例 |
| 9 | 未实际播放的告别词槽 | 库 filter 没动，farewell 不进库 → 没有新增抑制权；即便日后进库，行 4 用例已钉「真控制词不得被吞」 | 用例 + 差量为零 |
| 10 | 有可信自声证据的控制词样回声 | **文本层没有这个判据，本轮也没造**。既有防护是声学（AEC）+ 招呼语生成禁急停/命令/退出词；interim 路径的 `check_hotword` 本来就绕过所有回声门（B49 §B.1），本修复只是把 final-only 路径拉齐到同一暴露面，没有新增类别。限制见 §5 | 源码依据 |
| 11 | 窗口外控制词、普通问答、设备命令 | 窗外路径逐字不变；设备命令唯一执行方（`match_command` → `start_device_command`）未动 | diff 范围 |
| 全称 | 两张默认表（10 急停 + 12 退出）逐词：自身入库、outlet Some ⇒ verdict None | 用例 `control_outlet_is_never_swallowed_over_default_tables` ✅（n=22 ≥ 20 锚） | 用例 |

### 负向验证（三处注入，每处先确认 diff 非空，再看**哪几条**红）

| 注入 | 内容 | diff 行 | 结果 | 与预期 |
|---|---|---|---|---|
| ① 单字规则忽略 outlet | `opening_echo_verdict` 里把 `count()==1` 提到 outlet 检查之前 | 6 | **2 红**：`stop_single_char_reaches_stop_outlet`、`control_outlet_is_never_swallowed_over_default_tables`；其余 6 绿 | 完全一致（「停」是急停表里唯一单字） |
| ② 词库命中忽略 outlet | outlet 只守单字、不守 `local_audio_echo_hit` | 5 | **3 红**：`goodbye_in_farewell_bank…`、`exit_words_and_tails…`、`control_outlet_is_never…`；其余 5 绿 | 完全一致 |
| ③ **调用点**恢复外层单字早退 | `pipeline.rs` 把 `let hit = if n_chars == 1 { Some("single-char") } else { opening_echo_verdict(...) }` 装回去（能编译） | 4 | **320 全绿** | **预期就是全绿**——这是在证明盲区，不是通过 |

③ 的含义如实写：**单测看不见调用点的顺序回归**。今天能挡住它的只有 (a) 被调方必须收 outlet 参数（编译期）、(b) 代码审查、(c) 灰度真机行 1/3。要让 ③ 也能红，需要一个能构造 `Orchestrator` 的测试骨架，那是另一轮的重构，本轮按 §3.2.2 不做。

复原后：三文件与提交前逐字节一致（`cmp` 过），全量 320 绿。

## 3. 控制副作用：不拿字幕代替

- **旧 turn 是否终止**：STOP/EXIT 出口 `hard_abort_current` 未动（行 3 已逐行）。判据不是字幕、不是「新 turn=0」，是 `turn.ctl.abort()` + `source.clear_buffer()` + `paused/false_deadline` 清空，三者在同一函数里连着执行。
- **会话是否保留**：`stop_only` → `Lifecycle::Interrupt`（`ready_confirm.rs:151`），不发 `session_exit_detected`，不进终态；房间由端侧空闲/退出流程管，本轮没有新增「worker 自己关掉一切」。
- **EXIT 幂等**：`exit_seq` 递增、`exit_pending` 同 seq 重试 ≤3 次、`cancelled=false` 合法 ACK——全部既有，零改动。
- **字幕**：`caption_gate` 路径没碰；控制出口本就 Publish。

## 4. 播放参考：无需新 wire

本修复不依赖任何端侧播放事件。告别词槽不进库（§3.3「先修出口」）。日后若要把 farewell/g1/posture 纳入对撞，Worker 侧需要的**唯一**字段集是：`trace`、`slot`、`state ∈ {started, cancelled, completed}` + 该 state 的端侧单调时刻——`WakePromptTextPublisher` 只更新本地 UI，不算；调 play / 生成文案不算物理播放证据。但那是另一轮，本轮不请求。

## 5. 残余风险（文本独判不了的范围）

1. **设备自声「再见」/「停」错转穿过 AEC**：本修复让它们走到 EXIT/STOP 出口。现实暴露面 = 开场 15 s 内设备播出含这些词的内容——当前库不含 farewell、招呼语生成门禁这些词、退出衔接语只在退出流程里播（那时会话已在退出）。interim 路径的 `check_hotword` 此前就有同样暴露面，本轮没有新增类别，但**也没有缩小**。
2. **真人弱声 vs 回声**：仍无文本判据；本轮没加「无 VAD 即回声」或任何全短句静音。
3. **合并 final**：「停」被 `poll_commit` 合并进长句时，本门与 STOP 出口同样不认（既有限制，字幕层 B52 已按单条兜，吞句层没有）。
4. **调用点回归盲区**（§2 注入 ③）。
5. `EXIT_TAIL_MATCH=0` 的部署：outlet 不含 tail，重叠窗仍靠保留的内联 `session_exit_tail_hit` 守；单字/词库门在该配置下对纯尾句不豁免（尾句 ≥4 字，只会撞 LCS 层，且退出尾句对招呼语 LCS≥0.8 概率极低）。灰度未设该键 = 默认开，不受影响。

## 6. 部署计划（等 codex 确认窗口，我不自行开始）

| 步 | 动作 | 判据 |
|---|---|---|
| 0 | 复核线上锚仍为 MainPID 2734957 / exe `71e42ab0…`；不同即先报差量 | 对上再动 |
| 1 | 产物 scp 到 `/root/rust-worker-firstturn/voice-rust-worker.new`，服务器端 `sha256sum` 必须 = `c2b84b2e…` | 对撞过才继续 |
| 2 | **空闲守卫**：`journalctl -u voice-worker-firstturn` 最近 job 已 `process exiting` 且无活动 job；有会话就等 | 无在途会话 |
| 3 | `mv voice-rust-worker voice-rust-worker.prev && mv .new voice-rust-worker && systemctl restart voice-worker-firstturn` | `.prev` = 回滚锚 `71e42ab0…` |
| 4 | 核 MainPID 变化、`/proc/<pid>/exe` sha256 = `c2b84b2e…`、ActiveEnter 新时刻、`registered` 日志 | 三项全对才算换装 |
| 5 | 回滚 = `mv .prev voice-rust-worker && restart`，零 env 改动 | 一步 |

env：**零改动**（本修复没有新键、不需要开关）。不写共享生产 `.env`，不扩灰度名单，生产 `voice-worker-rust` 不碰。先单独验 Worker 控制修复（行 1/3/4 真机各一次），再谈 Android 音频候选，不混成一次 A/B。

## 7. 清理：旧 30 秒录音

| 项 | 本轮只读实测 |
|---|---|
| 录音目录 | 1 个 `.wav`，960,044 B（=30 s × 16 kHz × mono × s16 + 44 B 头），创建 2026-09-12 07:48:49 UTC；目录另 1 个非音频条目 |
| 定时器 | `oneshot-audit-cleanup-persistent.timer` active，NextElapse **2026-09-13 07:35:39 UTC**（15:35:39 CST），`Persistent=true`，落 `/etc`（B58 已从 `/run` 迁出） |
| 清理脚本 | `cleanup.py` SHA256 `5e378b79…`（codex 版，`FileNotFoundError` 容错），glob `*.wav` |
| 本轮 | 未复制、未延期、未读取内容、未传任何机器 |

到期后我再给一次「数量/路径类别」回执，不贴内容。

## 8. 一件给川哥的旁注（不是给 codex 的）

home-studio `/tmp/wt-rust-build`（分支 `tmp-rust-ordered24`，HEAD `93dfb62b`）里有 **2026-09-12 13:44 的未提交改动**：`control.rs / eot_snapshot.rs / main.rs / pipeline.rs` +672 行、未跟踪 `ready_confirm.rs`——看内容是 `be68f91b`（B46 ready 补确认）提交前的构建副本。我**没有动它**（checkout 被它挡住，我另开 `/tmp/wt-rust-build-b68` 构建完即删）。需要清理请点名，我不自作主张。

---

Worker 未换装、Android 未动、音量/AEC/阈值/ready/词表全未动。生产 2720004 未动。没有开房、没有录音。

署名：cc（Claude）| 2026-09-13 09:40 CST
