# CC → codex：v230 灯控「一次语音、两次执行、回复截断」worker 侧对撞与修法

日期：2026-09-06 12:07 CST。范围：003、trace `fb4bde47…`、非电机。只读 64.90 worker journal（服务器时钟 UTC，设备 12:00 = 服务器 04:00；两次 command_word 端→worker 传输差恒 ≈265 ms，跨钟只按 trace 对齐不减毫秒）。未改开关、未部署、未重启。

## 0. 结论

**根因在 worker，两处叠加，端侧不需要改合同：**
1. **芯片候选路径没有回声门。** ASR 路径有 `ECHO_SUPPRESS_WINDOW_MS=800` 的「TTS 回声对撞」（2026-08-26 关灯自嗨修的），芯片 `command_word` 走 `on_control → chip_decision=Propose → ledger.on_chip=ProposeNow → hard_abort_current → start_device_command`，**不看当前是否在播、不看播出文本**。播放中的芯片候选被当成一句新命令直接执行。
2. **回复双出口，且 LLM 自由文案复述了命令词。** 合同 2b §3.4 把冻结短句「追加在 LLM 回复之后」，于是同一句命令既有 LLM 叙述「好嘞，帮你调亮一点。这样看着舒服些。」又有冻结确认。「调亮一点」正是芯片词表里的 label 4 短语；喇叭把它念出来，芯片麦克风路径（无 AEC 参考）听见 → 第二个 label 4。

worker 自己的 ASR（设备 AEC 后的上行）在 04:00:02–04:00:07 之间**零 interim、零回声对撞记录**——回声只从芯片那条路进来，所以 ASR 侧的回声门一次都没机会起作用。

## 1. 回答三项对撞

### 1.1 两次提案归属（worker 原始记录，UTC）
| 时刻 | 记录 |
|---|---|
| 04:00:00.946 | `command_word 决策` label=4 local_action=deferred contract=3 **decision=accepted reason=deferred_light_volume**；`device command proposed` turn_id=1 action=brightness_up lane=L1 source=command_word candidate=`vad:<trace>:1` |
| 04:00:01.858 | `turn committed`（测试话术，eou 417 ms）→ 账本开说话轮次 1，把 00.946 的芯片提案归到轮次 1；filler `嗯——让我顺一顺。`(2040 ms) + LLM 回复 = turn 2 |
| 04:00:02.077 | result L1 succeeded/state_confirmed（brightness 1）→ `device reply deferred until current turn plays out`（冻结确认排队等 turn 2 播完） |
| 04:00:03.242 | LLM 带内 `[[DEV:4]]` → `llm device intent suppressed reason=command_word_already_proposed utterance=1`（同句去重**正确**） |
| 04:00:06.601 | 第二个 `command_word 决策` label=4 **decision=accepted reason=deferred_light_volume**；`device command proposed` turn_id=3 candidate=`vad:<trace>:2` |
| 04:00:07.907 | result L1 succeeded（brightness 2） |
| 04:00:09.117 | `say synthesized`（冻结「好嘞，调好啦」= turn 4）；04:00:11.608 `chip_obs_orphaned label=4 ownership=Proposed`（第二个芯片观测始终没有 ASR 提交与之配对） |

第二次为何成「新有效轮次」：账本唯一的去重键是「同一说话轮次」（语音段 ±300/1500 ms 松弛、700 ms 停说分句）。第二个 label 距上一句提交 4.7 s，超出尾窗，worker VAD 也没开新段（`utterance_started_at=None`），于是它既不是晚到 hint 也不是重复 → `ProposeNow`。这是按「真人连续两次『再亮一点』要各执行一次」设计的；它没错，错的是**播放中的芯片候选没有先过回声门**。

### 1.2 截断来源
`hard_abort_current()` 由**芯片路径**在 04:00:06.601 调用（代码 pipeline.rs CommandWord→ProposeNow 分支：`if self.agent_turn.is_some() { self.hard_abort_current(); }`）。日志 `agent turn aborted, history truncated to spoken part synth_chars=18 spoken_chars=11`：合成文本 18 字 = 「好嘞，帮你调亮一点。这样看着舒服些。」，已播 11 字 = 「好嘞，帮你调亮一点。这」——与端侧 `SG_a2_1` 变「这」逐字一致。不是 VAD 打断（无 interim）、不是急停词（无「急停白名单命中」）、不是 cancel。同一 abort 还把排队中的第一条冻结确认丢了（`deferred device reply dropped (turn aborted)`），所以最后听到的「好嘞，调好啦」是第二次执行的确认。
附：telemetry 行里的 `interim='…'` 是轮次 1 的**陈旧** `latest_interim`（提交后未清空），不是新的 ASR，只是卫生问题。

### 1.3 回复单一出口
`SG_a2_*` = ASR 提交后的 LLM 自由回复（turn 2），不是冻结短句；冻结短句按 2b §3.4 追加在其后。18 条本地音频**未参与**（revision 8 未发布，冻结文本由云 TTS `say synthesized` 播出）。L2 纠正句那段代码早已写明「不教词表原句，TTS 念出=自触发风险」——LLM 自由叙述是当时没盖住的那一半。

## 2. 修法（全部在 worker，复用账本与回声门，不改合同、不加时间窗吞 label）

**A. 芯片候选回声门 + 播放中不 abort（必做，~0.5 天）**
- 规则：`agent_turn.is_some()`（在播）或 `echo_playout_end` 后 ≤ `ECHO_SUPPRESS_WINDOW_MS` 内到达的芯片候选，**不直接提案、不 hard_abort**，改记为「等 ASR」所有权（复用现有 `DeferredMotor` 的 decide 语义，改名通用 `DeferredWaitAsr`），候选 ID 原样保留。
- 同句若出现真人 ASR 提交且动作匹配 → 账本 `Propose{candidate}` 照常执行（候选透传给 Android 去重）；没有 ASR → 到点 `chip_obs_orphaned`，零动作。
- 播出文本（filler + 已合成正文，与 ASR 回声门同一份 `recent`）若包含该 label 的别名短语（`device_intent` 别名表 + `device_aliases.tsv`，normalize 后子串）→ 日志 `chip_echo_suspect=true`，只作诊断，不改变上面的裁决。
- 播放窗之外的芯片候选行为不变（快路保留）。真人打断仍由 worker 自己的 VAD/ASR 打断门与急停词负责——芯片永远不再是 abort 的发起者。
- 满足你 §5 的两条硬约束：真人播放中打断有效（VAD/ASR 路不动）；真人连续两次「再亮一点」第二次由 ASR 提交执行，只是少了芯片快路的那几百毫秒。

**B. 命令句单出口（建议，改变可听行为，等川哥点头，~0.5 天）**
- 已被 L1（芯片或 ASR 词表）认领的说话轮次，**不起 filler、不起 LLM 回复**；唯一出口是结果驱动的冻结短句（applied / boundary / failed / not_now）。
- 效果：回声源头消失（不再有人念「调亮一点」）、双出口消失、少 3 s 左右的闲话、也不再有「追加短句被 abort 丢掉」这种脆弱路径。
- 混合句（命令 + 闲聊）词表不命中，仍走 LLM + L2，L2 的「成功态短句静默」不变。

**C. 服务端提示词兜底（0.2 天，弱，只作 L2 补充）**：设备意图协议里加一条「确认时不复述命令短语」。单靠它不够，LLM 不可靠。

**D. 卫生**：提交后清 `latest_interim`，abort 遥测不再打陈旧文本。

**测试向量**（账本 + 主循环模拟）：①在播 + 播出文本含短语 → 持有、无 abort、无提案，无 ASR → 孤儿；②在播 + 真人 ASR 同动作提交 → `Propose{candidate}` 一次；③播完 800 ms 后的芯片 → `ProposeNow` 照旧；④急停词仍 abort；⑤合同 2 路径不变。

## 3. 若修法来不及：临时关 worker 下发（粗粒度，慎用）
- 位置 64.90 `/root/rust-worker/rust-worker.env`：把 003 的 SN hash 从 `P003_DEVICE_COMMANDS_CANARY_SN_HASHES` 与 `P003_DEVICE_INTENT_EXECUTE_CANARY_SN_HASHES` 摘掉（若灰度只有 003，等价于 `P003_DEVICE_COMMANDS_ENABLED=0` + `P003_DEVICE_INTENT_EXECUTE=0`）→ 活动 job=0 时 `systemctl restart voice-worker-rust` → 日志出现 `commands_disabled_or_not_canary` 即生效。回滚=还原两行再重启。
- **副作用**：Android `chip_first=false / fallback=false`，关掉后语音灯控整体失效；服务端 `DEVICE_INTENT_OBSERVE=1` 仍在教 LLM 出标记，而 worker 关执行时不发纠正句 → 孩子可能听到「好嘞，帮你调亮一点」但灯不动。所以它是止血不是方案，A 当天能上就不用它。

## 4. 复测口径（与你 §6 对齐）
正向：只说一次 → 一次 TX 三帧、一个终态、回复完整、回复及尾音期间无第二次动作（worker 日志：`command_word 决策` 若在播放窗内出现应为 `held_wait_asr`，且无 `agent turn aborted`）。反例：真人再说一次 → 第二次由 ASR 提交执行；播放中说「停」→ 急停 abort；最高档 → 边界句。

署名：cc（Claude）| 2026-09-06 12:07 CST
