# 最终复审：PASS

候选 `e9806c7f97e98ade57204242058c02a74673f075`，基线 `e3522605`。工作区干净，祖先含 `fefbfdc9`。相对基线只有 `pipeline.rs`（+160/−1）。该文件 sha256 `1492e37df0076dfcb714f2d4f828a84715025c04ca4c49ace89bd03132388cd4` 与 `source-handoff-reviewed-full.json` 的 68 键清单一致；本轮只复核了这一条。`handoff-reviewed-full.log` sha256 `d6f3f979dbad4aa8bda6889e8db2f974138b311355b9f1d9881cbcc8dceb2b56` 与 `CANDIDATE.json` 一致。

无阻断，无越界业务改动，无新增连接泄漏。本结论不表示已部署或真机通过。未重跑测试，未连生产，未重算其余 67 个哈希。

## 终局与两个接管点

`take_stt_preconnect` 仅在 PCM 发送端已关闭、事件接收端已关闭，或快照中已有 `Closed` 时 `abort` 旧任务，并调用一次 `FnOnce` rebuild。`spawn_stt` 对 `ServerClosed` 只发送 `Interrupted` 后继续循环（约 723–725 行），通道保持打开，故存活重连沿用原任务和原 PCM 通道。函数内没有 5 秒或年龄条件。

初始接管（942 行）与 stt2 切相（1126 行）调用同一函数。stt2 只在 rebuild 闭包内把 `spawned_at` 改为当前时刻；保留原连接时不改，随后仍走原来的 `input_phase` 发布。stt2 的 abort 超时写入 `exit_error` 后 `break`，进入 1483 行原收尾（`hard_abort`、未终态代次 `RoomClosed`、abort 备用任务、等待主任务）。初始点超时用 `?` 返回：主循环尚未开始，失败任务在函数内 abort，`OwnedTask` 丢弃时再 abort，且不会 rebuild。

## 清事件时尚未提交 PCM

循环上界是进入时的 `ev_rx.len()`，只 `try_recv` 当时队列中的事件；非 `Closed` 一律丢弃，之后入队的留下。函数不向 `pcm_tx` 发送。初始调用位于主循环以及任何 `try_send` / `on_ordered_packet` 之前，预组装只 `spawn_stt`。stt2 在首条发送端 `drop` 之后另开通道；purge 之后才装入 `stt_pcm_tx`，追补只写入 `stt_buf`。两处 purge 时，该通道都还没有用户 PCM。函数内没有 PCM 计数器，保证来自调用顺序。

## 旧 ordered 代次

purge 不持有 `Session`，不调用 `on_stream_interrupted` 或 `fail`。活跃代次读第一条 `stt_ev_rx`；1357–1396 行的 Interim / Final / Interrupted / Closed 裁决未改。`fail` 会把包括 Idle 在内的非 Terminal 打成 Terminal，因此必须在新 Session 读到事件之前丢掉空闲 `Interrupted`。stt2 的空闲事件在另一条队列，不会回写已开始代次的相位、样本或已 hold 的 final。切相时若代次仍未终态而 `fail(Timeout)`，属于基线原逻辑。

## 测试证据（日志原文，未重跑）

`handoff-legacy-red.log`：旧接管下首包 `SendError`；真实 `ordered_pcm::Session` 由 Idle 变为 Terminal。`handoff-reconnect-red.log`：过度重建触发「必须保留原 PCM 通道」，另两则通过。`handoff-reviewed-full.log`：三则手测通过；全量 `555 passed; 0 failed; 1 ignored`。被忽略项是既有 `rtc_business_probe::actual_job_silence_and_first_turn_handoff`（真 RTC），不在本次差异里。手测使用生产 `spawn_stt` 与 `Session`，仅 localhost：关闭则换连且首段 PCM 到达新端；重连则 `same_channel` 且相位保持 Idle；健康连接不重建。

## 残余（不阻断）

快照之后才入队的事件按设计交给后续消费者。没有 5001ms、`spawned_at`、`run_pipeline` 集成或 abort 超时的测试。500ms 内任务未结束则整条 pipeline 失败并放弃本次重建。`CANDIDATE.json` 写明 `deployed: false`；`fefbfdc9` 仍是历史祖先，最终树已不再对存活重连 rebuild。正式构建与真机不在本评审范围。
