# T5 第3项复审与第1项上传设计边界

只读复审。工作树 HEAD `ed5419a89708a62ac90b32d61a96b050e2ad8f64`，工作树干净。未 SSH、未加负载、未改共享树、未改产品时钟、未动正在跑的上传。查询数字由 `query-evidence/` 的 jsonl 重新连接计算，与 `QUERY-ANALYSIS.json` 的首尾样本一致。上传只审本地脚本和一个已经落盘的早期快照，不把它当结果。

第3项门仍然失败。冷页读取是 fadvise 臂里 evidence 语句的一个真实组成，不是传输失败的必要原因。上一轮「2/3 次 service_ms>120 且随后 ≤50ms」的预定规则没有触发，不能把失败命名为首次冷页。

## 可确认

固定脚本 `65c86916` 的 `d13-baseline-full`：1000 次，传输失败 2，`invalid_facts=0`，`pass=false`。独立重算 p95=35.164ms，p99=48.243ms。

| 查询 | 客户端 ms | reader `app.fetch` ms | 客户端 status | body | 客户端日志减 reader 日志 |
|---|---:|---:|---|---|---:|
| 0-0 | 144.872 | 124.917 | null | 否 | −119ms |
| 0-1 | 122.658 | 59.014 | null | 否 | −18ms |

第 6 次之后 995 次没有传输失败，客户端最大 93.03ms，没有一次超过 100ms。这轮进程的稳态在 120ms 以内。门失败是因为零失败规则，不是因为稳态 p95。`correct=true` 只核对快照余额；超时路径仍会带上 `store.current()`。它不能证明 history 到达。

进程内 cgroup 计数：`cpu.max=100000 100000`，`memory.max=805306368`，结束时 `memory.current=262307840`，`memory.events.max=0`。整轮 `throttled_usec` 只增加 0.478s。systemd 摘要里的 Memory peak 336K/520K 与这些计数矛盾，不能用。

诊断是 4 臂 × 3 个新进程 × 50 次，顺序固定为 cold → warmdb → warmhttp → cpu2，不能当成随机化实验。重复单位是进程。下面「首请求」都是 `0-0`。

fadvise 只对 `analytics.db` 调用 `POSIX_FADV_DONTNEED`，不含 `-wal`，也不含 `ark.db`。它不是空操作：9 个 fadvise 首请求的 `/proc/self/io` `read_bytes` 都是 1384448。3 个不做 fadvise 的 warmdb 首请求 `read_bytes` 都是 0，但 `rchar` 仍是 1034393。同一量级的逻辑读，一次落到盘，一次由页缓存满足。

| 臂 | 首请求客户端 / reader | 传输失败的查询 | 首请求 read_bytes | 首请求 evidence `all()` | 首请求 throttled_usec | 首请求客户端日志减 reader |
|---|---|---|---:|---:|---:|---:|
| cold-0 | 125.260 / 107.656 | 0-0 | 1384448 | 70.017 | 0 | 未单列 |
| cold-1 | 135.231 / 219.080 | 0-0、0-1；0-2 已完成但客户端 130.121 | 1384448 | 108.403 | 55070 | 未单列 |
| cold-2 | 144.984 / 112.585 | 0-0、0-1 | 1384448 | 73.084 | 0 | 未单列 |
| warmdb-0 | 158.605 / 43.953 | 0-0 | 0 | 6.438 | 0 | +41ms |
| warmdb-1 | 185.796 / 126.877 | 0-0 | 0 | 10.626 | 70362 | −11ms |
| warmdb-2 | 168.369 / 98.379 | 0-0 | 0 | 4.883 | 78568 | −7ms |
| warmhttp-0 | 142.746 / 98.279，body 完整 | 无 | 1384448 | 69.944 | 0 | +37ms |
| warmhttp-1 | 125.066 / 97.701，body 完整 | 无 | 1384448 | 69.155 | 0 | +22ms |
| warmhttp-2 | 120.928 / 96.675，body 完整 | 无 | 1384448 | 66.045 | 0 | +18ms |
| cpu2-0 | 125.491 / 102.682 | 0-0 | 1384448 | 67.889 | 0 | −47ms |
| cpu2-1 | 126.491 / 118.026 | 0-0 | 1384448 | 80.849 | 0 | −35ms |
| cpu2-2 | 124.336 / 102.087 | 0-0 | 1384448 | 69.885 | 0 | −23ms |

cold、cpu2、warmhttp 的首请求 evidence 墙钟约 66–108ms，对应 CPU 只有约 6–21ms。这和 1.38MB 的 `read_bytes` 一起，说明这条语句里有磁盘等待。warmdb 把同一条语句降到 4.9–10.6ms。页缓存解释的是这约 60ms，不是整次传输失败。

daily 语句三次标签里都没有出现。每次 HTTP 只有 `other-select`、`evidence`、`assets`。`other-select` 不到 0.2ms。不要把时间记到 daily。

## 需要缩窄的说法

上一轮预定规则要求至少 2/3 个进程同时满足：首请求 `service_ms>120`，第 2 次和第 21 次 ≤50ms，且首请求 `read_bytes` 远大于后面几次。实际首请求 reader>120 的只有 baseline `0-0`（124.917）、cold-1（219.080）、warmdb-1（126.877）。cold 是 1/3，cpu2 和 warmhttp 是 0/3。规则没有触发。只碰到 1/3 就不要给原因命名。

「冷页是传输失败的原因」过宽。warmdb-0 的 reader 只有 43.953ms，`read_bytes=0`，`throttled_usec=0`，reader 日志还比客户端早 41ms，客户端仍然 `status=null`。服务器已经做完并记下 200，客户端没有看到 headers。这次失败没有盘读，也没有这次 `app.fetch` 内的配额节流。

三个 warmdb 首失败也不是同一件事。rep 0 是 44ms 且无节流；rep 1 和 rep 2 的 handler 里有 70ms 和 79ms 节流，客户端日志比 reader 早 11ms 和 7ms。节流是后两份样本的组成，不是三份的共同必要原因。

「只有第一次失败」过窄。baseline、cold-1、cold-2 的 `0-1` 也失败。baseline `0-1` 的 reader 只有 59.014ms。cold 的第二次仍读 1191936 字节，第 21 次仍读 274432 字节。不是一次缺页之后就安静。

「2 CPU 排除了配额」过宽。cpu2 的三个首请求确实都失败，而且这三次 handler 内 `throttled_usec=0`，reader 为 102.682、118.026、102.087。多给一个核没有拿掉这次中止。evidence 仍是单线程语句上的磁盘等待，第二个核本来就不会把它变快。另一些 1 CPU 样本的 handler 内有 55–79ms 节流，所以也不能说配额从未参与。

「HTTP 暖机已通过」不能成立。暖机路由是 `/t5/transport-warm`，三次 5.4–6.2ms，`sql_n=0`，`read_bytes=0`。它不跑 `readArkHistory`。随后的首个正式请求仍读 1384448 字节，evidence 仍要 66–70ms。变化只在竞态结果：body 三次都完整，harness 的 `history_transport_failures=0`，客户端总钟是 120.928、125.066、142.746。p99 仍大于 100，`pass=false`。

客户端 `ms` 不是产品接受 history 的那只钟。`facts()` 在第二次 `grant()` 和 `current()` 之前用 `performance.now()-started<=125` 决定是否留下 history。客户端 `ms` 包含这段之后的工作。body 完整且客户端 `ms>125`，不能推出 history 被丢掉；客户端 `ms` 略小于 125，也不能单独推出门已通过。harness 把传输失败定义成 `status===200 && body_complete`，与这个 125ms 谓词不是一回事。

`sql_ms` 只包住 `all`/`get`/`run`。`prepare()`、`readSnapshot` 的 `BEGIN`/`COMMIT`、语句返回后的 `JSON.parse` 都在 reader 墙钟里、不在 `sql_ms` 里。warmdb 首请求的未计入时间是 34.6、111.1、90.5ms，其中后两份含节流等待。不要把未计入时间写成某一条未测到的 SQL。

客户端和 reader 是 `fork` 的父子进程，共用这只 systemd 单元的 `CPUQuota`。1 CPU 时，reader 里的同步 SQLite 会让客户端的 abort 定时器得不到调度。这是测量边界，不是已经证明的原因。

## 第1项上传：只审设计

驱动已在跑。这里不新探、不改、不停。`upload_check.output.json` 是一份已经落盘的早期快照：`a0-halfcore-1` 还在跑，`requests` 尝试数仍是 0，clone 的 `analytics.db` 约 2.01GB；cgroup `memory.current=805007360`，`memory.events.max=15130`，`oom=0`，`io.pressure` some avg10=56.50，`throttled_usec=15.4s` 对 `usage_usec=23.6s`。这是 ACK 之前的启动压力，不是 p95，也不能外推到另外两臂。

设计与交代一致的部分：三臂都从 `p003-t5-50x12000-cover01` 独立 `copyFileSync`，50 身份 × 2000 事件，默认批 200，所以目标成功 ACK 是 500 次而不是原来的 3000 次。顺序是 CPUQuota 50% → 100% → 50%，MemoryMax 都是 768M，IOWeight 20，Nice 10。`T5_MAINTENANCE=0`，`T5_BACKUP=0`。`checkpointer.start()` 仍走产品路径，默认周期 10s。完整账本且 `integrity.complete` 之后，只删除该臂 clone 的 `analytics.db`、`-wal`、`-shm`。源 600k 不在删除列表里。业务源码包是 `e0931608`，harness sha256 `a4694049cf7e07a3725ce5cc6101e2b163cffd1d981701904f030ffc990c1fe7`，与 `UPLOAD-SOURCE.json` 一致。`e0931608` 相对 HEAD 只差 capacity-load 的 history-index 开关和维护错误记录，以及 resources 摘要字段。产品 `src` 没有被这只 harness 改写。

这不是 600k 混合验收。脚本自己的阶段名也是 `T5_INCREMENTAL_LOAD_NOT_FULL_ACCEPTANCE`。任一臂 p95≤500 或 503 变少，都不抵消原来的 50×12000、维护与备份重叠、成功 ACK p95≤500。

解释这三臂时先卡住这些边界：

- 两次 50% 臂的 p95 差若大于它们与 100% 臂的差，CPU 对照不稳定，不命名。
- 三臂都 >500：在这个较短写负载上，把配额从 0.5 核提到 1 核并没有落到 500 以下。768MiB 是共同条件。早期快照已经显示第一臂在 ACK 前顶到内存上限。
- 两只 50% 臂都 >500 且 100% 臂 ≤500：只说明这套 clone 写负载上配额能移动 p95。仍然不是原混合门。
- `copyFileSync` 发生在同一只 cgroup 里、客户端 ACK 之前。p95 不含复制时间，但继承它留下的内存和缓存。三臂程序相同，可以互比；不能把某一臂直接写成「原 525ms 去掉维护之后」。
- fadvise 在复制之后，是建议性的；随后 writer 和 checkpointer 会再打开库。不要把上传结果解释成冷页实验。
- 删除索引的谓词是 `t5_ark_%` 或 `analytics_ark_%cover%`。后者对得上 `analytics_ark_evidence_cover_v1`、`analytics_ark_assets_cover_v1`、`analytics_ark_daily_cover_v1`。`t5_experiment_cover` 对不上。驱动没有设置 `T5_ARK_HISTORY_INDEXES`，`e0931608` 的脚本也不会重建那三只索引。harness 不记录实际删了哪些名字。查询能跑完也不能证明覆盖索引存在，因为 `arkHistoryReadIndexes` 会回退到 `analytics_ark_device_event_received`。源库 schema 要等驱动结束再只读查看。驱动结束前不要扫这只正在被复制的源库。
- ACK 的 `ms` 仍是单次 `fetch` 到 JSON 完成。503 的睡眠、批间 2s、20s abort 不在 p95 里。新的 `start_ms`/`at_ms` 在 `requests.jsonl`。cgroup 原文在 `resources.jsonl` 的 `diag` 里；`e0931608` 的 `RESULT.resources` 摘要没有节流和 memory.max 事件。用 jsonl，不用那份摘要给 CPU 或内存定罪。

## 最小补测

现在不要开。上传驱动结束之前，不要再读或 fadvise 源 600k 库。不要加 fadvise 臂，不要再加 2 CPU 臂，不要改 `src`。

上传结束后，若还要给第3项命名，只改诊断 harness：3 个新进程，不做 fadvise，CPUQuota=100%，MemoryMax=768M，每进程前 3 次正式查询就够。在现有日志外记下 `grant` 结束、`fetch` 发出、headers、abort、125ms 谓词当时的钟、谓词之后的收尾，以及 evidence 的 `prepare` 与 `all` 分开的时间。预定裁决：

- `grant` 到发出前 >20ms，且 reader<80ms、`read_bytes≈0`：预算在 HTTP 前被吃掉。下一只单因素才是 `ark.db`，仍然不要 fadvise `analytics.db`。
- `grant`<5ms，reader<80ms、`read_bytes≈0`，reader 日志早于客户端中止超过 20ms，且 headers 仍是 null：响应已经完成，中止回调先赢。下一只单因素是父子进程分开 cgroup，只把 reader 的配额松开。
- `prepare`>30ms 且 `all`<15ms、`read_bytes≈0`：首份语句的计划成本。不是缺页。
- 三个进程对不上：保持「新鲜进程的前两次请求会撞上 120ms 中止」，不命名内部机制。

页缓存已经测完的部分不必重跑：fadvise 把 evidence 从约 5–11ms 抬到约 66–108ms，同时 `read_bytes` 固定为 1384448；没有 fadvise 时这项为 0，传输仍会失败。

方法说明：因果判断按必要原因与测量边界分开，不用单臂关联命名。
