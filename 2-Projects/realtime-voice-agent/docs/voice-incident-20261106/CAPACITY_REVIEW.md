**PASS（静态复审）；实际容量 1 的恢复验收仍待完成。** 未发现该补丁相对 f0 引入阻断问题，与前序 job 生命周期修复组合安全。

固定版本已用 `git rev-parse` 核实：

- 候选：`991ee2a38694414b447d3db8ff29a8cda39aee5f`
- 基线：`f0f113bfccd60d4331c647b692b763b78bb01d44`
- 候选直接基于基线，仅修改 `worker.rs`，新增 21 行、删除 10 行。

| 核查项 | 依据与判断 |
|---|---|
| WS 顺序 | `worker.rs:161–173` 在同一 `tx` 上先 `send(out).await`，再读取计数、发送 `UpdateWorker`。当前分支执行期间，心跳和其他出站消息不会插入两次发送之间。 |
| 最新计数 | Assignment 先 `fetch_add`；`run_job().await` 返回后先 `fetch_sub`，再入队终态。发送端使用 `SeqCst` 重新读取，避免队列中的旧容量快照覆盖新状态。 |
| 快照边界 | 读取后其他 job 仍可能结束，因此不是零时间差快照；其后续终态消息会再次触发最新广告。新增 Assignment 由同一主循环处理，不会在两次发送之间增计数。 |
| 协议 | helper 完整保留原心跳的 `status/load/job_count` 语义，30 秒心跳保留。消息类型、字段符合 [LiveKit 协议定义](https://github.com/livekit/protocol/blob/main/protobufs/livekit_agent.proto)。 |
| 与 f0 组合 | pipeline 完成被 join 后进入 job 清理；worker 等 `run_job` 返回才释放计数。fatal 仍经过统一收尾，没有因容量广告提前绕过清理。 |
| 并发与门禁 | 未提高 `max_jobs`，未修改 `active < max_jobs && job_allowed(...)`，未删除输入、输出或 fail-closed 门。STT 确为 `OwnedTask`，超时丢弃会触发 abort；“裸 JoinHandle 脱管”的旧判断不成立。 |

两个非阻断边界需要保留：

- `msg_rx` 也承载 `AvailabilityResponse`，所以实际会在它之后追加容量广告，日志“after job status”不完全准确。原有“接受请求到 Assignment 之间没有容量预留”的窗口仍存在，不能据此宣称严格并发上限已得到证明。
- “即时”指终态发送后立即追加广告，不代表服务端已经处理。新房若抢在旧 job 返回、容量广告生效之前创建，能否恢复仍需实际容量 1 复测确认。

已只读核对既有容量测试日志：记录 **492 passed、0 failed**；测试清单中 worker/job/pipeline/OwnedTask 及 Cargo 文件的 SHA256 与候选一致。**本次未运行测试或探针**，该记录不能替代三代恢复验收。

历史 G2 订阅缺失与本次容量广告缺陷分别判断，不合并归因。源码、文档及生产均未修改，未委派。下一步由主13完成固定候选、`MAX_JOBS=1` 的三代反证复测。

署名：codex（OpenAI）| 2026-11-06 15:21 CST
