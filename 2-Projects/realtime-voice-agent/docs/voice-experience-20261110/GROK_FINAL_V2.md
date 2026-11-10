# Grok 最终窄复核 v2

判定：**无 blocking。** 与设计评审三点一致。这不是生产通过，也不是真机通过。主 13 仍要另跑正式产物 RTC 后才发布。本轮只核两树相对各自父提交的 `src/playout.rs`，未改代码、未重跑、未扩大史料。

## 固定提交

| 池 | SHA | 父提交 | 相对父提交 |
|---|---|---|---|
| 主 | `1b1628649be24e13b248bea7fe91639de3a8879a` | `3600c699699072975e29077ed54b1fbc34fef006` | 仅 `rust-worker/src/playout.rs`，+65/−27 |
| 倾听 | `ac18707965623b85540408fc1d989eacb04ce798` | `fc12b13ca65dee97bce8fad8c0ca01caf687ff7a` | 仅 `rust-worker/src/playout.rs`，+65/−27 |

两树工作区干净。主池 `playout.rs` sha256 `582011999359bae8582a0da38c651f3696063a05a03412de0335ebbac4853d3b`。倾听 `a6c7009e532bb80b2a062596708ad7078424da5c16da84fad1f0f0b22149cd29`。`worker-final-v2-full.log` 与 `worker-listening-final-v2-full.log` 的 playout / pipeline / business_runtime / job 四份哈希分别等于这两棵树的当前文件。`worker-coalesced-green.log` 的 playout 哈希等于主池终态。`worker-coalesced-red.log` 的 playout 是另一份 `f90cc4ec…`，其余三份仍相同。

## 与先前建议

一致，三点都落在这次 diff 里。

1. **合并成 pause=false 不清水位。** `pause_rx.borrow()` 为假时，select 分支不调用 `on_wait`，也不调用 `on_resume()`，并且不改 `wait_start`。`on_resume()` 只清 `play_deadline`，不回滚已记下的欠载；无条件清水位会让下一次 `on_wait` 因 deadline 为空直接返回，把已有供给缺口记成 0。红灯正是这条：`experience_coalesced_pause_does_not_erase_existing_supply_gap` 在 `playout.rs:553` 失败，断言文案为 `a real supply gap must survive a coalesced notification: 0`，`rc=101`，6 过 1 败。绿灯同一组 7 项 `rc=0`。
2. **收尾恢复单纯 220ms sleep。** 父提交里 abort 可以在已经 `SourceDrained` 之后把终态改成 `Aborted`。现在两树都只剩 `tokio::time::sleep(Duration::from_millis(220)).await`，睡眠本身不改出口原因。这是设计评审要求撤回的副作用，不是新分歧。
3. **真实供给缺口与 coalesced 反例都在。** 新增 `experience_coalesced_pause_does_not_erase_existing_supply_gap`（`pause();resume()` 之间无 await）和 `experience_supply_gap_without_pause_still_counts`。两条都要求 `completed` 且 `underrun_ms >= 150`。

## 本轮五点

**无 await 的 pause/resume 保持 wait_start。** 见上。通知被 watch 收成最终 false 时，内层循环继续等 PCM，随后的 `on_wait(wait_start, now)` 仍从原来的等待起点算。

**真正暂停只排除 hold。** `borrow()` 为真时，先 `on_wait(wait_start, now)` 结算暂停前的供给等待，再以 `already_observed_pause=true` 进入 `wait_for_playing`。该门在离开暂停时才 `on_resume()` 清水位，返回后把 `wait_start` 重置为当前时刻。hold 不进入下一次 `on_wait`。已提交的暂停前缺口还在，因为 `on_resume` 不减 `underrun_ms`。abort 在这道门里先于未暂停返回。

**abort 优先，残帧不漏。** PCM select 是 `biased`，`abort_rx.changed()` 在 pause 和 `recv` 之前。整帧残帧先过 `wait_for_playing` 再 drain / capture。短尾也先过这道门。`abort()` 仍是先 `abort_tx.send(true)` 再 `pause_tx.send(false)`；门每次醒来先看 abort。绿灯里原有的 `experience_abort_while_residual_paused_never_captures_old_frame` 与另外 5 条一起通过。睡眠前的检查后到 capture 前，仍有原先那一拍调度窗口；这次 diff 没有放宽它。

**AudioPermit 保留。** 只在倾听树。`spawn_playout` 仍接收 `Option<AudioPermit>` 并放进 `PlayoutControl`。`aborted()` 仍是 abort 或 permit 已撤销。整帧路径在 capture 前看 `ctl2.aborted()`。`capture_with_retry` 仍走 `capture_guarded`：先看 abort，再用 `begin_capture()` 拿票，撤销时清 buffer 并返回 false。本轮测试调用传 `None`。主池没有这条许可。

**drain 终态已恢复。** channel 关闭仍在 `on_wait` 之前记 `SourceDrained` 并离开 chunk 循环。残帧处理完后的 220ms 不再改写成 `Aborted`。因此这段睡眠里的 abort 不会把 `completed` 改成 false。残帧出口在睡眠之前。

## 证据

| 日志 | 结果 | 与固定树 |
|---|---|---|
| `worker-coalesced-red.log` | `rc=101`；coalesced 用例欠载 0ms 失败；其余 6 过 | playout 不是终态，作反例 |
| `worker-coalesced-green.log` | `rc=0`；7 passed | 四文件哈希等于 `1b162864` |
| `worker-final-v2-full.log` | `rc=0`；`575 passed; 0 failed; 1 ignored`，10.57s | 四文件哈希等于 `1b162864` |
| `worker-listening-final-v2-full.log` | 头 `rc=0`。本地 90 行是回写头加后段摘录，不是完整 cargo 抄本。可见 lib `661 passed; 2 ignored`，`listening_core` 30、`listening_runtime` 13、`listening_voice` 10，均 passed，无 FAILED | 四文件哈希等于 `ac187079` |

任务下达时倾听全测称为仍在跑。复核读到的头已经是 `rc=0`，摘录内没有失败行。未为等正式产物或补全抄本继续扩展。

## 发布边界

无 blocking，可以进入主 13 已安排的正式产物 RTC。本文件不表示生产或真机已经通过。
