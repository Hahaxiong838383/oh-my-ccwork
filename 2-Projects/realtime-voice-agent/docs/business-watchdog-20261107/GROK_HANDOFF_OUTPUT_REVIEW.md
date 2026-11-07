# Grok 首句转场与输出预算复核

复核人：Grok 4.7。只读。未改业务源码，未部署，未 SSH，未重跑 532。

- 采集钟：`date +%Y-%m-%dT%H:%M:%S%z` → `2026-11-07T23:51:07+0800`
- 固定候选：`1f947fe4e226382615b147fd8e8bf6031c8d310d`（`git rev-parse 1f947fe4`；HEAD 同值；相对 `b12f7de2174f7353e989e0e291dee7c3b8fafdae` 是祖先）
- 工作区这 6 个源文件与该提交 `git diff --quiet` 一致
- 结论：**无阻断**。三条调用点按现码成立。不得据此声称真实 RTC 或生产通过。

## 结论

`1f947fe4` 在协议截止之外只加一次签发 idle，并把原 OutputGate 5 秒和绝对 local_receipt 算进回复截止。39 秒首块、门合法等到 44 秒、旧静态回复 40 秒先关房的反例，被 `turn_started+45s` 盖住。后续 10 秒只在样本数变化时前移。DeleteRoom 夹具证明按 name 删除，空回读仍可以是 Gone，不表示竞态已修。

## 证据

1. FirstTurn→RTC。`pipeline.rs` 的 50ms tick 在 `on_tick` 之后、`activity_until(Input)` 之前调用 `first_turn_to_rtc`（约 1408–1417 行）。`pending_phase_switch.take()` 和 `input_phase = Rtc` 在下一轮循环顶（约 1086、1099–1100 行）。模型侧 `business_watchdog.rs` 49–50 行：`ready && rtc_grace_at.is_none()` 才写入。`evaluate` 用 `last_progress.max(ready_at).max(rtc_grace_at)` 与签发 `idle_ms` 做严格 `<`（77–78 行）。未 ready 时调用被忽略，60 秒启动截止仍在（`missing_handoff_and_unknown_policy_cannot_be_extended_forever`）。重复调用不改锚。`input_transition_deadline` 只对固定绝对时刻加一次 `idle_ms`；同一时刻再次 `activity_until` 在 54 行直接返回。`ordered_pcm.rs` 的 `on_tick`（1133–1136 行，`>` `begin_to_end_timeout_ms`，默认 7000）和 begin 超时（`elapsed > ordered_begin_timeout_ms`，默认 2500）都不在这 6 文件的协议比较里被改写。Idle 等待用 `input_loop_started_at + begin_timeout`，Receiving/Ended 用一次设定的 `business_ordered_until`（1300 行，仅 Idle→Receiving）。都不是轮询时刻。

2. 输出预算。`REQUEST_TIMEOUT` 30 秒 + `CONNECT_TIMEOUT` 10 秒 = 40 秒。门未开时 `reply_startup_deadline` 再加 `OUTPUT_READY_TIMEOUT` 5 秒（`gate.rs` 70 行，与 `OutputGate::new` 同一常量）。`start_turn` 先把 `pending_local_receipt_deadline` 拷进 `business_until`，然后才 `take()`（3657–3667 行）。`Option<Instant>` 是 Copy，take 不会把已经写入的截止清掉。较晚值是 `receipt.max(output)`。绝对截止测试：receipt 在 t+50 秒，t+49 Keep，t+50 Close。门从首块 `pcm_rx.recv` 起等 5 秒（`gate.rs` 106–111 行）。首块 P ≤ turn+40 秒时，P+5 ≤ turn+45。39→44 落在里面，旧的 40 秒整房关闭不再先于这 5 秒。比较是 `now < until`，相等即 Close；job 层采样间隔 1 秒（`job.rs` 249–272 行），只会晚于截止观察到，不会更早。

3. 任务结束后的播放。`turn.task` 在 `playout_task.await`（含约 220ms 队列排空）之后才结束，然后才发 `PlayedOut`（3973–3976 行）。`PlayedOut` 才把 `agent_turn` 清掉（2899 行）。因此 `!task.is_finished()` 的回复截止在播放期间仍在。样本增加才 `progress`，并把 `reply_deadline` 设为 `initial.max(last_pcm + 10s)`。样本不变则截止不变；同一 Instant 重复提交不续期（`receipt_deadline_and_late_sentence_connection_are_bounded_without_poll_renewal`）。任务结束后没有还在 `await` 的播放。剩下的是末次真实 capture 起的签发 idle，下限 5 秒（`business_watchdog.rs` 32 行），盖得住 220ms 尾音。未结束任务本身不是截止。

4. DeleteRoom。`delete_inner` 的 POST 体是 `{"room": room}`，没有 SID（`room_verify.rs` 29–30 行）。夹具 `absent_readback_does_not_prove_a_racing_replacement_survived_name_delete`：预读 `RM_original`，DeleteRoom 内把绑定换成 `RM_new` 并记 `removed:RM_new`，之后列表为空，结果是 `Outcome::Gone`。`job.rs` 对 Gone/Superseded 打 `delete_scope=room_name, cas=false` 和 “readback complete”。这是回读观察，不是 CAS 修好。

## 边界

- 本轮没有重跑 Linux 532。`HANDOFF_OUTPUT_EVIDENCE.json` 自述 final 532 pass、`real_rtc_validated: false`、`production_changed: false`。本文件不把该计数当成我方复测。
- 首块若晚于 turn_started+40 秒才进入 `OutputGate::wrap`，门的 5 秒会超过 turn+45 秒的回复截止。`CONNECT_TIMEOUT` 只包握手，不包握手后的首包。现码没有一条必然在 +40 秒之后才送出首块的路径。39/44 反例不依赖这种首块。这不是阻断，也不要求改锚。
- 未做真实 RTC 音频、字幕、metrics，也未核现役二进制。原始输入故障和 12 张未匹配签票不在本候选范围。
- 无需要主 Codex 回复的分歧反例。

署名：Grok 4.7 | 2026-11-07T23:51:07+08:00
