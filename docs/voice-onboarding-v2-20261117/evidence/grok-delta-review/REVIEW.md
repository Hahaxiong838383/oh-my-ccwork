# 最终增量只读审查

署名：grok（xAI）
日期：2026-11-17
范围：两个已固定提交。未部署，未 SSH，未改这两个提交里的源码。审查开始时两个工作树 `git status` 都是干净的。审查期间语音工作树出现了与本增量无关的文档/测试脏文件，T5 工作树出现未跟踪目录 `docs/prnas-storage-50/t5/review-followup-20261117/`。这些不是本审查写入的，也没有回滚。`pipeline.rs` 与 `rollup.ts` 相对各自固定 HEAD 无工作树差异。

## 1. 语音教学 `da3109f7385d56d5b2829959ef4f54aa5b9a8b19`

工作树：`/Users/fu-121/.codex/worktrees/p003-voice-onboarding-20261117`
父提交：`40233116448c23922f08b702728c2afbb7f029f2`
结论：源码路径与「真实 v2 begin 后立刻走既有 phase switch」一致。这不是上线结论，也没有真人验证。

相对父提交只有两处：

- `2-Projects/realtime-voice-agent/rust-worker/src/pipeline.rs` 在已有的 v2 generation 变化块里增加一行：`action == "begin"` 时调用既有 `request_phase_switch("voice_onboarding_v2")`。
- `docs/voice-onboarding-v2-20261117/CONTRACT.md` 增加两行，描述同一行为。

402 的协议与数据库测试留给会话 379，这里没有重跑。

### 主循环

真实 begin 的门是叠在一起的。

1. 控制包先过 `trusted_origin`。不可信包在进入 `control` 之前返回。
2. `local_lesson` 为 `onboarding.is_v2()`，即 session version 为 2。
3. `control_v2` 只接受尚未开始、`revision == 0`、`question_index == 0` 的 begin。重复 request、非法字段、过期或序号不新的包不改 revision / active / blocks_input。
4. 接受后 `started` 被写上，phase 为 `idle`。`generation()` 从 `(0, false, false)` 变为 `(0, true, true)`，因为 v2 在 phase 不是 `ready` 时 `blocks_input` 为真。
5. 只有 generation 真的变了，并且 action 是 begin，才调用 `request_phase_switch`。
6. 该函数只在 `input_phase == FirstTurn`、`ordered.first_turn_rtc()`、且 `pending_phase_switch` 为空时把 reason 设为 `voice_onboarding_v2`。

主循环在下一次迭代开头、下一次 `select` 之前取走这个 flag（`pipeline.rs` 1130 行起）。因此 begin 被接受之后再从麦克风取出的帧，看到的已经是 RTC。

旧 ordered 首句仍会丢帧。`ordered_first_turn_active()` 为 `ordered` 存在且 `input_phase == FirstTurn`。这个条件下 RTC 样本只计数，然后 `continue`，不进 `stt_buf`。默认 `ORDERED_RTC_CATCHUP_MS` 为 0，这些帧也不进追补环。切换把 `input_phase` 写成 `Rtc` 之后，该条件为假，后续样本进入 `stt_buf` 并 `try_send` 到新的 STT。`PcmSender::phase("rtc")` 只写诊断相位，真正改道的是这个 `input_phase`。

`begin_timeout` 仍只在 FirstTurn、`first_turn_rtc`、ordered phase 为 Idle、且首帧已经超过 `ORDERED_BEGIN_TIMEOUT_MS`（默认 2500）时置位。v2 begin 先成功时，下一次循环已经离开 FirstTurn，这条超时不再接管。教学答案因此不必再等首句超时才进入连续 RTC。begin 到达之前已经取出的帧仍按旧规则丢弃；追补默认关闭，不会把它们补进新 STT。

若超时 tick 已经先把 pending 写成 `begin_timeout`，新的 begin 不会覆盖 reason，因为 `request_phase_switch` 在 pending 非空时直接返回。切换仍会发生，后续帧仍进 RTC，只是 `session.input_phase` 的 reason 保持 `begin_timeout`。

### 清退旧 ASR / 换上新 RTC

这是既有切换块，本增量没有改它：

- `drop` 旧 `stt_pcm_tx`，旧 ASR 发送端关闭。
- 新 STT 来自已有 `stt2`，否则当场 `spawn_stt`。预连接失败会走既有 `exit_error` 收摊，与 `begin_timeout` 相同。
- 新发送端留在 `stt_pcm_tx`，事件通道换成新 STT。旧任务放进 `stt_tasks_done`，其关闭事件不再进入主循环。
- `input_phase = Rtc`。
- ordered 若尚未 Terminal，调用 `fail(Timeout)`，再 `apply_ordered_actions`。
- 随后把 `pending_phase_switch` 和 `ordered_end_stream_pending` 都清掉。切换只做一次，EndStream 不会再把新 STT 的发送端 `take` 掉。

### `apply_ordered_actions`

`fail(Timeout)` 产生两条既有动作：Publish 一条 `status=failed`、`reason=timeout`、`action=repeat_prompt`、`outcome=failed`、`next=rtc` 的 ordered result；若当时不在 Draining，再加 EndStream。Idle 代次的 `input_id` 为空。这与 `b25_late_begin_after_timeout_is_message_level_rejected` 锁住的 begin 超时终态相同。

`apply_ordered_actions` 只处理 EndStream、ReleaseBody、Publish。这条 fail 不产生 ReleaseBody。Publish 是 ordered topic 上的数据包。失败 result 会再调一次 `request_phase_switch("first_turn_failed:timeout")`，但此时 `input_phase` 已经是 Rtc，谓词失败，不会第二次切换。函数里没有 `start_turn`、`say_after_current` 或关房 `break`。EndStream 只把 `ordered_end_stream_pending` 置真，切换块随即把它清掉。

同一次 generation 变化里原有的 `hard_abort_current()` 会在存在 agent turn 时停掉当前播报并截断历史。它不新开 Say。这三行增量没有把它加进去。

`session.input_phase` 的 reason 在这条快路径上是 `voice_onboarding_v2`。ordered result 的 reason 仍是 `timeout`，因为复用的关闭动作就是 `fail(Timeout)`。合同写明客户端按既有 `session.input_phase` 处理，reason 为 `voice_onboarding_v2`。本仓库没有消费 `repeat_prompt` 的客户端代码。

### 回声 catchup

默认 `ordered_rtc_catchup_ms` 为 0。判断顺序是 `disabled`，然后 `not_complete`，然后 `local_audio_window`，否则才回灌。

`complete` 只有 `first_turn_committed` 与 `first_turn_no_task`。`voice_onboarding_v2` 两边都不是。

- 默认：`catchup_skipped = disabled`，喂入样本数为 0。环仍被 `drain`，不会留到以后。
- 若环境把追补毫秒开成正数：先落到 `not_complete`，仍不回灌。`local_audio_window` 到不了。

切换之后的实时上行是连续 RTC，会进入新 STT。既有 v2 `on_final` 在 `blocks_input` 或尚未 `speech_seen` 时丢弃，active 的 v2 答案进入 `answer()` 后返回，不进普通 turn、搜索、LLM、TTS。begin 当时 phase 为 `idle`，输入门是关的；要等到 `audio_complete` 把 phase 变成 `ready`，并且 VAD 见到语音，答案才会被收下。

### 旧 v1 与普通房间

- v1：`is_v2()` 为假，新行不执行。忙时 begin 仍走原来的 `onboarding_deferred`。
- 无 onboarding：可信来源检查失败，直接返回。
- 有 ordered 但不是 `first_turn_rtc`：`request_phase_switch` 的谓词失败。
- 已经是 Rtc：谓词失败，不会再切一次。
- `question_started`、`audio_complete`、`question_skipped`、`finish`、`cancel` 即使改变 generation，action 不是 begin，也不调用这次切换。
- 普通首句的 commit、no_task、失败和 begin 超时 reason 都没有改。

### 测试

未启动 cargo。既有 `ordered_pcm` 测试锁的是 `fail(Timeout)` 的出站和迟到 begin 的消息级拒绝，不构造 `Orchestrator`，也不会执行 `request_phase_switch("voice_onboarding_v2")`。pipeline 里的 STT handoff 测试覆盖预连接替换，不覆盖这个 reason。`cargo test --lib` 会写工作树内约 5.1G 且已被 gitignore 的 `rust-worker/target`，或者在外面再做一个完整 target。工作树当时已有其他写入。按不改共享工作树，没有跑这些测试。这是验证界限：主循环结论来自 `da3109f` 源码，不能把 ordered 测试写成这次 PASS。

未上生产。没有真人把本地教学题音频送进房间。源码上，begin 被接受后的后续 RTC 不再被首句 `begin_timeout` 窗口丢掉。

## 2. T5 `416a48985453937181fe47fedba01f4211cfdbcb`

工作树：`/Users/fu-121/.codex/worktrees/p003-prnas-storage-50-20261116`
父提交：`bbf40a4843d00579f6cfc5cfdcb14762c78ed373`
固定 HEAD：`416a48985453937181fe47fedba01f4211cfdbcb`
提交说明：`perf(p003): project only required columns during analytics rollup`
结论：这一行投影与 `Fact` 的实际读取一致，排序和类型没有漏。**这不是 T5 通过。** 不启动 T6。

相对父提交只有 `apps/server/src/analytics/rollup.ts` 的扫描句。WHERE、ORDER BY、索引、事务、预算、dirty、TTL 都没有改。

```sql
SELECT device_key,event_name,session_digest,clock_suspicious,semantic_json,received_at_ms
FROM analytics_rollup_fact
WHERE dimension=? AND day=?
ORDER BY device_key,received_at_ms,id_digest
```

`fact-layout.ts` 的九列是 `dimension, day, device_key, id_digest, event_name, session_digest, clock_suspicious INTEGER, semantic_json, received_at_ms INTEGER`，主键 `(dimension, day, device_key, received_at_ms, id_digest)`。投影去掉的是 `dimension`、`day`、`id_digest`。`summarizeFacts` / `addFact` 不读这三列。`id_digest` 仍留在 ORDER BY 里，SQLite 允许排序列不出现在 SELECT 中。

字段对应：

| 列 | 表类型 | 读取 |
| --- | --- | --- |
| device_key | TEXT NOT NULL | 换设备时收口，设备摘要的 key |
| event_name | TEXT NOT NULL | 计数、`app.session_started`、`g1.reward_granted`、`g1.command_failed` |
| session_digest | TEXT NOT NULL | 仅 session_started 进入每设备 Set |
| clock_suspicious | INTEGER NOT NULL | 累加 |
| semantic_json | TEXT NOT NULL | 每行 `JSON.parse` 一次；`gm_override`、`reward_instance_digest`、失败命令 |
| received_at_ms | INTEGER NOT NULL | `data_cutoff_ms` 取最大值 |

聚合对同一设备内的顺序可交换；设备分组依赖 `ORDER BY device_key`。失败命令的名次在聚合后按 count 和命令名排序，不依赖插入顺序。

当前 `rollup.ts` 的 SHA-256 是 `eb652974fa779a7463d61ea8e5cbc6dd6e5a45d427cb3259d45dccb31b5ea161`，父文件是 `e3f0e452f4c7fa799570fb9efed446559f36524a23305cda358e1eb162027be5`。二者分别等于私有证据 `EVIDENCE.json` 的 `source_after_sha256` 与 `source_before_sha256`。120 万 fact 的 A/B/B/A 摘要哈希 `7cf65c2c4c209ceb27ad0a93afcb5e741eefed0c3c9e40df64d29c404b0b336f` 仍只作为那份旧证据，本次没有重造夹具。约 12% 本机 CPU 初证不代表冷 I/O 已经解决。

本次只用 Node `v24.19.0`（`/Users/fu-121/.local/node-v24/bin/node`）对固定 HEAD 的真实 `rollupDirtyDaysWithStatus` 做了 5 行私有库。物理插入顺序故意和排序相反。实际读出顺序是设备 a 的 reward（t=100, digest aaa）、session s1（t=100, digest zzz）、session s2（t=150）、command（t=200），然后设备 b。这是 `device_key, received_at_ms, id_digest`。查询计划只有 `SEARCH analytics_rollup_fact USING INDEX sqlite_autoindex_analytics_rollup_fact_1 (dimension=? AND day=?)`，没有 TEMP B-TREE。`node:sqlite` 返回的整数是 number，文本是 string。结果：event_count 5，active_devices 2，sessions 3，设备 a 的 session_count 2，clock_suspicious_events 1，explicit_gm_events 1，reward 1，data_cutoff_ms 200，dirty 被清掉，partial false。日志在 `t5-mini/RESULT.json`。这只证明小库上的列、顺序和类型。没有跑 maintenance、fact-layout、ops 三脚本；那三次 PASS 按本次任务记录采用，不在这里重跑。

以下门槛保持原样，本次没有复测：

- ACK P95 仍是 525.924 ms，大于 500 ms。
- 实际冷首查询有 1 次大于 120 ms。
- 成熟库 41.79 GiB，40 GiB 盘放不下。
- 上限 14 不变。

不把这行优化称为 T5 通过，不启动 T6。
