# T5 第1项最终只读复核

定位证据。不宣布第1项或第3项通过，不宣布生产已修好。本轮未 SSH、未加负载、未改业务、未改产品时钟、未动失败库。工作树 HEAD `ed5419a89708a62ac90b32d61a96b050e2ad8f64`，工作树干净。只复算了上传与查询阶段的指定原始行，以及本树入口。生产进程的 SHA 由主13另核。

原门不放宽：上传成功 ACK p95 ≤500ms；查询内部中止预算 120ms，history 谓词 ≤125ms。诊断 harness 另有 `p99<=100` 且零传输失败，那是它自己的通过旗，不是放宽后的产品门。

## 结论

第1项这条短写对照没有过 500ms，也不是原 600k 混合门。ABA 只完成两臂，第三臂在一次 8 秒 writer settle 后停住，1536MiB 臂未跑。不能给出 CPU 独立收益百分比，也不能把内存或硬件写成已经排除。

失败机制在本树源码里是确定的：`AnalyticsWriter` 的 8 秒定时器把实例标成失败并排空，不再接受新批次，也不新建 writer。`startAnalyticsServer` 不因此退出。进程继续活着，`/ready` 变成 503，`storage_ready=false`。本树 PM2 文件只在进程退出或 RSS 越过 512MiB 时重启，没有 `/ready` 探针。最小下一步是沿现有排空和 PM2 重启恢复，不建新队列。这只恢复“超时后永久 503”，不把已经测到的 1.3–1.9 秒 p95 收进 500ms。

第3项补测给出直接钟差。`client_ms` 不是 125ms 谓词。`adopted=true` 只表示谓词当时的年龄 ≤125，abort 竞赛返回 `unknownHistory()` 时也能成立。有效采纳要同时看到 `response-schema` 的 parse、`body_complete` 和该布尔值。无 fadvise 的 6×50 不能说 warmup 根治。

## 支持

上传两只完整臂，原始 `requests.jsonl` 里 `status==200`，百分位为排序后 `floor(n*p)`：

| 臂 | 成功 / 尝试 | p95 ms | p99 ms | 库起点 → 增量 | 维护 / 备份 |
|---|---:|---:|---:|---|---|
| `a0-halfcore-1`，CPUQuota 50%，MemoryMax 768M | 500 / 2452 | 1946.974 | 4678.015 | 600000 + 100000，账本 complete | 都关 |
| `a1-onecore`，CPUQuota 100%，同内存 | 500 / 2274 | 1341.625 | 3681.506 | 同上 | 都关 |

503 不进百分位。两臂 10 万事件与 seen 都与 ACK 对齐。这是 50×2000、批 200、从 60 万库克隆后再写 10 万的短负载。

第三臂 `a0-halfcore-2` 复现了失败，证据在 `DIAGNOSTIC-WRITER-FAILURE.json` 和同目录 `health.jsonl`、`writer-diag.jsonl`：

- 成功 ACK 183 次。183×200=36600，与 `acknowledged_events` 一致。
- 只有一条 writer 样本 ≥8000ms：`load-t5-17-1794904732610-9-0-20`，8003.545ms。对应 HTTP 503 `ANALYTICS_STORAGE_UNAVAILABLE`，客户端 8015.770ms。
- 该批 `analytics_event` 与 `analytics_event_seen` 各 200。`database_run_events=36800`。多出的 200 已入库，ACK 没回到客户端。
- 其后 `health.jsonl` 连续 636 条 `storage_ready=false`、`ready=false`、`alive=true`、HTTP 503，跨度 635236ms，直到主13停止。`sql_busy` 最大为 0，`storage_failures` 停在 1。这段 checkpoint `failures=0`、`timeouts=0`、`last_error=null`，最后一次 `ok=true`、`busy=0`。
- 该样本 cgroup `oom` 与 `oom_kill` 增量为 0，`memory.events.max` 增量也为 0。`cpu.max` 为 `50000 100000`。
- 同窗 cgroup 增量：CPU 745.776ms，节流 433.826ms，`io.pressure` full stall 5758.728ms，约占这条 8003.545ms 墙钟的 72%。读写字节也来自该 cgroup 的 `io.stat`。这是整组计数，不是 writer 线程独占，三项也不能相加。
- `UPLOAD-STOPPED.json`：`complete=false`，失败夹具保留。`memory_arm` 为 `NOT_RUN`，原因是不完整克隆占着空间，1536MiB 没有跑。

查询 6 个进程各 50 次，计划里 `cold=false`，驱动只在 `cold` 时对 `analytics.db` 调用 `posix_fadvise`。私有 runtime 只把原条件记下来：`adopted: age<=125`，然后仍是 `if(age<=125)history=result`。本树产品 `runtime.ts` 仍是未插桩的 `performance.now()-started<=125`。

`d13s-noevict-1` 的 `0-0`：HTTP 200，body 完整，有 `response-schema`，但 history-gate `age_ms=128.422`、`adopted=false`。reader 34.549ms，三段 SQL 合计 4.999ms，`/proc/self/io` 的 `read_bytes` 增量 0，`rchar` 增量 1034394，cgroup `throttled_usec` 增量 0。`fetch_entered_ms=0.919`。`headers_ms=116.417` 的起点是 fetch 进入，不是 facts() 起点；两者在同一客户端进程里相加约 117.3ms，仍远大于这段 SQL。这次不能只归冷 SQL。

`d13s-noevict-http` 三支首请求都是 parse + body 完整 + `adopted=true`。首请求客户端总钟 86.028 / 128.957 / 63.460。harness 通过旗只在 0 号和 2 号为真（p99 86.028 与 63.460）。1 号 p99 128.957，`pass=false`，但它的 gate 年龄是 122.018，谓词仍采纳。这是 `client_ms` 与 gate 钟不是同一只钟的直接行。

`d13s-noevict-0` 的 `0-1` 是布尔值不够用的直接行：gate 年龄 121.537，`adopted=true`，没有 `response-schema`，`status=null`，`body_complete=false`，`abort_phase=before-history-gate`。竞赛里的 abort 先 resolve 成 `unknownHistory()`，年龄仍 ≤125，所以布尔值为真。六臂里这种“adopted 真但传输无效”的行只有这一条；其余 `adopted=true` 都同时有 parse 和完整 body。

不暖 HTTP 的三支 harness：传输失败 2 / 0 / 1，p99 153.043 / 131.768 / 154.078，三支 `pass=false`。其中 1 号传输失败数是 0，失败来自 p99，且首请求谓词拒绝。

## 不支持

- 用两只完整臂的 p95 宣布原 600k 混合门通过，或给出 CPU 独立收益百分比。第三只 0.5 CPU 只有 183 次成功，它自己的 1495.932ms 只描述这 183 次，不能当 ABA 的第三点。
- 1536MiB 已跑过，或内存、磁盘、硬件已经被排除。失败样本本身没有新的 `memory.max` 命中，也没有 OOM；整段观察窗仍有 2230 次 `memory.max`。`disk_warning=true`（空闲约 6.5GB，警告线 8GiB，停止线 4GiB），503 码不是 `ANALYTICS_DISK_PRESSURE`。
- 最慢样本的 5758.728ms I/O stall 全部属于 writer 线程，或可以和 CPU、节流加总成墙钟。
- 数据丢失。多出的 200 行在 event 和 seen 里。丢失的是这次 ACK。writer 注释写明超时提交结果未知，不在类内重放。
- warmup 单独根治查询门。三支暖 HTTP 只有两支过 harness 的 p99≤100。这也不抵消此前固定脚本那 1000 次里的传输失败；那 1000 次本轮没有重算。
- 只看 `adopted` 布尔值，或用 `client_ms` 代替 125ms 谓词。HTTP 200 且 body 完整仍可以 `adopted=false`（noevict-1 首请求）。`adopted=true` 仍可以是 abort 赢下的 `unknownHistory()`（noevict-0 的 `0-1`）。
- 无 fadvise 等于页缓存已经热。驱动确实没调用 fadvise，但 `d13s-noevict-0` 首请求 `read_bytes` 仍是 1384448，SQL 79.772ms。三支不暖 HTTP 的首请求不是同一种失败：0 号有物理读，1 号是热页上的客户端晚到 headers，2 号 `read_bytes=0` 但节流增量 69252µs。
- 本树 writer 类没有自愈，就等于生产监督链已经核完。本轮只核本树入口。诊断单元是 systemd，不是这份 PM2 文件；它证明应用会活着 503，不证明线上 PM2 的实际参数。

## 本树入口与最小修复

`src/analytics/writer.ts`：`jobTimeoutMs` 默认 8000。到点且这笔仍是 `pending` 时，`failed=true`，`rejectPending(false)` 拒绝调用方并留着在途槽，然后 `close()`。注释写明不终止、不重放可能还在提交的事务。`ready` 要求未失败、未关闭、未退出。类内没有第二个 `Worker`。单测 `analytics-writer.test.ts` 把这个超时固定为：主线程先拒绝，`busy` 在迟到结果前仍为真，库里可以已经有那一行。

`src/analytics/index.ts` 的 `startAnalyticsServer` 只构造一个 writer。`SIGTERM`/`SIGINT` 才走 `stop()`：先 `writer.close()`，再 `process.exit`。writer 失败不会发这些信号。请求路径在 `!writer.ready` 时返回 503 `ANALYTICS_STORAGE_UNAVAILABLE`。`/ready` 因此 503，但 `alive` 恒为真；`/health` 仍是 `{ok:true,alive:true}`。checkpointer 独立，失败臂里它继续成功，与 health 记录一致。

`deploy/analytics-start.ts` 只调用上述入口，启动失败才 `exitCode=1`。`deploy/analytics.ecosystem.cjs` 的 `p003-analytics` 是单实例 fork，`max_memory_restart` 512M，`kill_timeout` 35000，`restart_delay` 2000。文件没有把 `autorestart` 关掉，也没有 ready URL。注释把 35 秒留给 writer 的 30 秒 close。这次失败臂 RSS 约 278–321MB，低于 512MiB，即便套用这个内存重启也不会被这条规则打死。诊断 cgroup 的 768MiB/0.5–1 CPU 与这份文件不是同一组限额；生产 cgroup 是否无限，仍由主13对线上 SHA 核对。

最小建议，只针对这种“8 秒到点、排空结束后仍 `ready=false`”的状态：

1. 在本树入口，等这次失败的 writer `busy===false`（在途槽已释放，迟到结果不再交给原来的 HTTP 承诺）再 `process.exit(1)`。
2. 让现有 PM2 按这份 ecosystem 拉起新进程，从而得到一个新的 writer。沿用已有的 30 秒排空和 35 秒 `kill_timeout`。
3. 不建队列服务，不在 writer 类里重放那一笔，不在 `busy===true` 时退出或再构造第二个 writer。8 秒拒绝和 30 秒 close 超时都还可能落在提交中途；这次事故是排空之后又空转了约 635 秒，退出点应落在空转，而不是 8 秒那一下。

这个退出不能当作第1项过门。两只完整臂没有掉进永久 503，p95 仍是 1946.974 和 1341.625。永久 503 和 500ms 门是两件事。

## 边界

- 百分位只含 HTTP 200。503 睡眠、批间等待、20 秒 abort 都不在 p95 里。
- 上传 p95 不含克隆耗时，但克隆发生在同一只 cgroup、ACK 之前。两只完整臂可以互比；都不能写成“原 525.924ms 去掉维护之后”。
- 查询重复单位是进程。顺序固定，先不暖再暖，各三次，没有随机化。
- harness 传输成功是 `status===200 && body_complete`。产品采纳是 125ms 谓词，而且值必须是 parse 出来的 history，不是 `unknownHistory()`。`correct=true` 只核对快照余额。
- `headers_ms` / `body_ms` 从 fetch 进入起算。`age_ms` 从 `facts()` 起算。`client_ms` 含谓词之后的 grant。reader 的 `ms` 是另一个进程里的 handler 时长。
- SQL 计时只包 `all`/`get`/`run`。prepare、snapshot 归约、schema parse 另记。
- 父子进程共用该 systemd 单元的 CPUQuota。本轮查询是 100% 与 MemoryMax 768M。共享调度仍是测量边界，不把 noevict-1 的剩余约 80ms 命名成单一原因。
- 未核生产进程是否加载了本树 `ed5419a` 的 `analytics-start.ts` 与 ecosystem。未改代码，失败库保持原样。

## 本轮复算所用对象

- `upload-evidence/p003-t5-d13-a0-halfcore-1/requests.jsonl`、`RESULT.json`
- `upload-evidence/p003-t5-d13-a1-onecore/requests.jsonl`、`RESULT.json`
- `upload-evidence/p003-t5-d13-a0-halfcore-2/requests.jsonl`、`writer-diag.jsonl`、`health.jsonl`、`DIAGNOSTIC-WRITER-FAILURE.json`
- `upload-evidence/UPLOAD-STOPPED.json`
- `query-stages-evidence/d13s-*.jsonl`、`d13s-*.reader.jsonl`、`d13s-*.json`
- 本树 `writer.ts`、`index.ts`、`deploy/analytics-start.ts`、`deploy/analytics.ecosystem.cjs`、`src/ark/runtime.ts`
- 诊断副本 `ark-runtime-observation.ts`、`storage-ark-query-stages.ts`、`query_stages_driver.py`
