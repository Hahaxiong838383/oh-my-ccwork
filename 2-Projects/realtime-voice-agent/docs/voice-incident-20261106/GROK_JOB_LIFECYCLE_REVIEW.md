# P003 固定候选只读复审

结论：**PASS**。本结论只覆盖下面这个已提交树的源码行为。没有跑 cargo，没有看到这次 HEAD 的测试输出，没有连接生产，没有启动探针，也不能把生产或 20 秒关房断言写成已通过。

## 审查快照

| 项 | 值 |
|---|---|
| 工作区 | `/Users/fu-121/.codex/worktrees/p003-voice-transport-fix-20261105` |
| 候选 HEAD | `f0f113bfccd60d4331c647b692b763b78bb01d44`（`git rev-parse HEAD`；提交说明 `fix(voice): close completed pipeline jobs and trace output subscriptions`） |
| 比较范围 | `013ef77cd45739f3f8353a8400394c24f63be226..HEAD`。父提交就是这个基线，中间只有这一笔 |
| 工作区状态 | `git status --porcelain` 为空，审的是该提交本身 |
| diff | 只改 `2-Projects/realtime-voice-agent/rust-worker/src/job.rs` 与 `pipeline.rs`。`control.rs` 差异为 0 字节 |

上轮方案里的一处事实需要按当前源码改正：主树 STT 句柄已经是 `OwnedTask<()>`。`pipeline.rs` 的 `SttPre.task`（约 651–654 行）和 `spawn_stt`（约 717 行）都把它包进 `owned_task::OwnedTask`。`OwnedTask::drop` 调用 `abort()`。因此旧的 fatal 提前 `return Err` 在丢弃局部变量时会 abort STT，不会把裸 `JoinHandle` detach 掉。这次 fatal 改为 `break` 后走统一收尾，修的是收尾本身：`hard_abort_current`、ordered `RoomClosed`、`search.close()`、最多 3 秒等待、`pipeline closed`，然后再把原来的 `Err` 交回去。

## gate.rs 原字节

`2-Projects/realtime-voice-agent/rust-worker/src/gate.rs` 在基线提交、HEAD 树对象、当前工作区三处的 blob 都是 `38d19a1c6cdd856538d4b9dee0281ae21635ddc6`。`git diff` 对该路径无输出。`OutputGate::new` 仍是 `Duration::from_secs(5)`（`gate.rs` 72–74 行）。fail-closed 文案和 5 秒常数都不在这笔 diff 里。

## 选择器

`next_job_wake`（`job.rs` 85–104 行）是 `biased`，顺序为 pipeline join、watchdog tick、`room_event`。

- pipeline 为 `None` 时，该分支停在 `std::future::pending()`，不会凭空完成。
- pipeline 的 `JoinHandle` 在分支里被 `await` 到完成，随后 `pipeline.take()`。尾巴只在 `pipeline_task` 仍为 `Some` 时调用 `close_pipeline`（507–508 行）。完成路径不会把同一句柄再 poll 一次。
- 四种 join 结果都 `break`（219–225 行），循环内没有第二条 `tokio::spawn(run_pipeline)`。`Ok(())` 记 `pipeline ended → closing job`；`Err` 记 `pipeline failed → closing job` 且 `error = %e`；panic / cancelled 记 `pipeline join failed → closing job`，并带 `panic` 与 `cancelled` 字段。后两类不会走正常结束那一行。
- `Room::connect` 在 livekit 0.8.3 返回 `mpsc::UnboundedReceiver<RoomEvent>`（crate 源码 `room/mod.rs` 的 `connect`，约 571–575 行）。`recv` 只有在 poll 返回 Ready 时才取出消息。`biased` 在更前的分支已经 Ready 时不会 poll 房间分支，排队的 `RoomEvent` 留在通道里。健康 pending 任务不会被完成分支抢走：完成分支不 Ready，watchdog 未到期时才会落到房间事件。
- watchdog 使用已有的 `MissedTickBehavior::Delay`。tick 到期时先于房间事件返回，处理函数不 `break` 就 `continue`。下一 tick 按一个周期排开，订阅事件被推迟的是这一轮 watchdog 检查，不是 5 秒输出门。输出门仍从首段待播 PCM 起算，时钟在 `gate.rs`，这笔 diff 没有改它。

因此选择器会把已结束的 pipeline 带进现有关房删房尾巴，也不会在 pipeline 仍 pending 时把健康通话判成结束。

## 资源清理

`close_pipeline`（547–556 行）与已上线灰度树里同名函数同形：有 shutdown 时先等 500 毫秒；然后 `abort()`，再等最多 500 毫秒。超时打 `pipeline abort acknowledgement timed out; proceeding with room cleanup`，随后照样关房。普通断连不再是 `abort()` 后立刻返回。这是为了让新的清理有界，diff 没有改 `delete_room` 的次数或超时。

任务若卡在非 await 点，500 毫秒后丢弃 `JoinHandle` 会 detach 这个仍在跑的 pipeline 任务；abort 标志已经置上，它要碰到下一个取消点才会跑析构。`job_lifecycle_uncooperative_abort_cannot_block_room_cleanup` 把这个上界写成了测试。这是有界清理的剩余面，不是这次「pipeline 已结束但 job 不醒」的路径：那条路径在 `take()` 之后不会再进 `close_pipeline`。

fatal 路径（`pipeline.rs` 1157–1159、1392–1407 行）现在先执行循环后的收尾，再 `Err(error)`。`stt_task` 的 3 秒 `timeout` 结束时，未完成的 `OwnedTask` 会在 Drop 里 abort。旧的提前返回也会在 Drop 里 abort；它跳过的是这段显式收尾和 `pipeline closed`。`exit_error` 只赋值、不清除，收尾里没有第二条 `return`。

## 关房

`close_room_and_delete`（560–568 行）先把 close future 限制在 3 秒。`Ok(Ok(()))` 才算关上；超时或 `Err` 都打 `room close failed or timed out; still attempting DeleteRoom`，然后仍 `delete.await`。调用点保留 `let _ = ...`，删房失败仍由原 `delete_room` 打 `room cleanup incomplete; client disconnect not confirmed`。`job closed` 出现不表示设备已经确认断连，原注释还在（520–521 行）。

livekit 0.8.3 的 `Room::close`（crate 源码约 1167–1189 行）会把会话 `Handle` 从 mutex 里 `take()` 出来，再 unpublish 并等待各任务。`Room` 没有 `Drop`。3 秒到点时若 future 已经 `take()` 过 Handle，这些 `JoinHandle` 会随 future 丢弃而 detach。job 任务本身继续去 `DeleteRoom`。灰度树的同名辅助函数是同一形状。这保证关房等待有上界；它不证明被中途丢掉的 RTC 任务已经退出。

`delete_room` 本体不在 diff 中。普通房仍是 1 次、5 秒；候选仍是现有 3 次。没有 `http1_only`，没有新的删房重试策略。

## 正常结束与 fail-closed

`run_pipeline` 的成功出口只有循环后的 `match exit_error`（1407 行）。循环内能把整个 pipeline 带出去的 `break` 是：

- shutdown oneshot。普通主池 `P003_SEARCH_RESUME_V1` 未设时，这个 future 固定 pending（1154 行）。oneshot 只在循环已经退出后的 `close_pipeline` 里发送，那次 `Ok(())` 由 `close_pipeline` 吃掉，不会记成 `pipeline ended`。
- `fatal_rx` 收到消息：先写入 `output gate fail-closed: {msg}`，再 `break`。join 得到 `Err`。job 打的是 `pipeline failed → closing job`，`error` 字段仍含 `output gate fail-closed` 和 `fail-closed`。
- 麦克风流 `None`（1169 行）。
- 非 ordered 首句的 STT `Closed` / `None`（1331–1333 行）。

ordered 首句的 STT 结束只把 `stt_closed` 置位并继续循环（1325–1330 行），注释仍写 job 不在此退出。单轮 `Final` 调用 `on_final` / `on_ordered_final_held`，不 `break`。多轮期间 `run_pipeline` 不返回，`JoinHandle` 保持 pending，`JobWake::Pipeline` 不会触发，job 不关。

因此「一轮话说完就删房」在这条控制流里不成立。麦克风结束或 STT 任务真正结束时返回 `Ok(())` 并删房，是把原先同样会留下的空 job 接上现有尾巴；日志与 fail-closed 的 `Err` 分开。

pipeline 的 `select!` 没有 `biased`。麦克风 EOS 和 fatal 同时 Ready 时，可能先走到 EOS 的 `break`，`exit_error` 仍是 `None`，join 成为 `Ok(())`，日志是 `pipeline ended`。房间仍会关。事故那条路径是对端还连着、没有订阅：麦克风流不在这里结束，fatal 分支会留下 `Err`。这条并发只影响「流已经结束」和「门也失败了」叠在同一轮 select 上的文案，不把仍在循环里的通话报成结束。

## 订阅日志与历史 G2

SID 日志只在这笔主树 diff 里。`LocalTrackSubscribed`（349–371 行）：

- `track.sid() != agent_pub.sid()`，包括事件 SID 为空而当前 publication SID 非空：打 `decision = discard_sid_mismatch`，`continue`。此时还没调用 `gates.on_local_subscribed()`，也没有 `out_tx.send`。
- 相等且 `on_local_subscribed()` 为真：`accept`，`out_tx.send(true)`，并仍调用原来的 `control::output_ready(trace, unix_ms(), &room_name)`。`control.rs` 无差异，payload 没有新字段。
- 相等且已经开过：`discard_already_open`，不再发第二次 `output_ready`。

发布行补了 `job_id`、`room_sid`、`trace`、`agent_track_sid`。这些字段只能解释这笔二进制部署之后的新 journal。历史 G2 仍是安卓侧没有 publication SID、当时 Worker 也没有这条决策日志。本复审不把该事故写成已经定位，提交说明里也没有这句结论。

倾听工作区 `18048235` 已有同形的 `next_job_wake`、`close_pipeline` 500 毫秒和 `close_room_and_delete` 3 秒；源码里没有 `discard_sid_mismatch`。本复审没有改那棵树，也不把它的现有生命周期或二进制说成被这笔候选替换。

## 非阻断观察

下面这些不改变 PASS。它们要么是文案或测试强度，要么是已经接受的有界清理剩余面。

- 旧的 spawn 内日志 `pipeline exited with error` 已删除。新事件名是 `pipeline failed → closing job`，与灰度源码用词一致。`fail-closed` 仍在 `error` 字段里。只搜旧短语会把新失败看成没有发生。
- SID 不一致的消息是 `output subscription discarded`，接受和已开过仍用 `agent_track_subscribed_by_android`。决策字段能分开三类；只盯旧消息名会漏掉不一致。不一致那一行没有 `elapsed_ms`。启动前换轨那一行仍只有新的 `agent_track_sid`，没有上一份 publication SID。换轨条件没有改。
- 七个新测试覆盖正常结束、`Err`、panic、取消、abort 后 Drop、卡死的 close 仍 DeleteRoom、close 错误与删除失败的返回值、watchdog 优先于已就绪房间分支、完成优先于 watchdog。`Err` 用例的文本是合成的 `listening_session_paused_close_required`，没有锁住生产字符串 `output gate fail-closed`。完成优先的用例传入的是已经 Ready 的 `async { Some(19) }`，输掉的分支会把这个值一起丢掉；它锁住了 wake 种类和 `take()`，生产通道保全要靠 `UnboundedReceiver::recv` 的取消安全性，而不是靠这个 future。
- `close_pipeline` 上方注释仍写普通 job abort 后立即返回。实现已改为 abort 后再等最多 500 毫秒。
- fatal 现在会执行到循环后已有的 `search.close()` 和 ordered `RoomClosed`。这是原收尾被 fatal 提前返回跳过的部分，不是新的搜索恢复协议。diff 里没有新的控制类型，没有把 `session.output_ready` 加上 SID，也没有改 `delete_room` 重试。

## 本轮没有做的事

未修改审查树上的源码，未运行 cargo，未把用户提到的初版 492 次通过或正在重跑的 pipeline 收尾测试记成我的结果。未连接生产，未启动 A/B 或设备探针，未委派。外部只读材料是 crates.io 上的 livekit 0.8.3，用来核对 `Room::connect` 的接收端类型、`Room::close` 和 `Room` 没有 `Drop`。该核对不代表线上房间已经按新二进制关闭。

署名：Grok | 2026-11-06 | 固定候选 patch 复审，不是生产验收
