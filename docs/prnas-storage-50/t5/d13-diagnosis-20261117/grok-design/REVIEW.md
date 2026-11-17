# T5 第1项与第3项：最小因果对照

只读核验。HEAD `ed5419a89708a62ac90b32d61a96b050e2ad8f64`。未 SSH、未跑负载、未改共享树。第2项 30 秒维护与第4项容量不在本建议内。门槛保持 500ms / 120ms / 零传输失败。错峰或安静对照通过，只说明该对照，不算原混合门通过。

测量源码自 `65c86916e1e6a64352ec75d3c2b6eebb364e649a` 至 HEAD，`storage-capacity-load.ts`、`storage-load-ledger.ts`、`storage-ark-query-load.ts`、`ark/runtime.ts`、`ark/http.ts` 无 diff。

## 已证实

第1项。`600K-COMPACT-RESULT.json`：3000 次 HTTP 200，p95=525.924ms，p99=1738.339ms，9839 次尝试含 6839 次 503，排空 1350168ms。账本只把 200 放进百分位（`storage-load-ledger.ts` 的 `latency` 表）。超标来自成功 ACK 本身。半量同配方 `LOAD-50x6000-COVER01.json` p95=395.002ms（1500 次 200、2770 次 503）。

上传窗 `started_ms=1794886291340`。维护重叠只在这五段（末段在客户端结束之后，不算 ACK 窗）：

| 段 | 起点相对上传 | 时长 | 结果 |
|---|---:|---:|---|
| 0 | +3.3s | 2.7s | ok |
| 1 | +301s | 43.2s | prune 失败，partial |
| 2 | +601s | 57.9s | partial |
| 3 | +901s | 61.1s | partial |
| 4 | +1201s | 61.4s | partial |

备份由启动器在 +5s 拉起，`backup_exit=0`，RESULT 无起止时间。检查点周期 10s，只留下最后一次 0.078ms、failures=0。`requests.jsonl` 记录无 `at_ms`，不能事后把 525ms 分到这些窗口。

启动器把整组放进 CPUQuota=50%、MemoryMax=768M、IOWeight=20、Nice=10。保存的 MemoryPeak=805416960，贴着 768MiB 上限。主机内存最低仍约 45.8%，不是整机 OOM。

第3项。`query-result.json`：1000 次，p95=34.873ms，p99=50.060ms，`invalid_facts=0`，`history_transport_failures=1`，`pass=false`。失败样本在 `query-failure-and-scan.json`：`query_id=0-0`，客户端 `ms=155.528`，`status/headers_ms/body_ms/service_ms` 全是 null，`body_complete=false`，`correct=true`。reader 另记 `status=200`、`ms=137.420`。客户端日志 `at_ms` 比 reader 早 73ms，客户端先返回。这次查询 cgroup 内存 51MB→288MB，未顶满 768MB；节流增量约 0.55s，摊到 1000 次不能解释这一次。该跑没有上传、维护、备份重叠。

## 测量偏差（代码，不是新负载）

第1项，这些不是 p95 的组成：503 的 Retry-After 睡眠、批次之间的 2s、`AbortSignal.timeout(20000)`。p99=1738ms，20s 中止没有裁掉尾部。成功请求的 `ms` 是单次 `fetch` 到 JSON 解析完。writer 忙时直接 503，所以 525ms 是抢到写锁的那次批次本身。

第1项，分不开的因素：维护子进程、+5s 备份子进程、每 10s 检查点子进程、768MiB/50% CPU 的 cgroup、库从空长到 600k。半量通过只说明同配方在更小库上 p95 更低，不能指出是哪一个因素。

第3项，137.420ms 在 reader 的 `app.fetch` 内。`/internal/analytics/ark-summary` 同步执行 `readArkHistory`（evidence、assets、按条件的 daily）后才 `c.json`。客户端中止不会截短这段同步 SQL。fork、tsx、`new AnalyticsStore`、listen 都在循环之前，不在这 137ms 里。

第3项，不要把 155.528−137.420 当成 18ms 开销。两个时钟重叠，客户端更早结束。`status=null` 表示 headers 到达前 `fetch` 已因 abort 失败。`facts()` 在本地 `grant()` 之后才把剩余时间设为 `max(1, 120-已用)`，并在总经过 ≤125ms 时才采纳 history。这次服务端 137ms 已经大于 120，所以不是“预算起跑点单独造成的假超时”。起跑点仍要记下来，因为下一次若 handler≤120 而 `facts()`>120，结论就不同。

`correct=true` 不能证明 history 到达。加载器只核对快照余额；超时路径仍会带上 `store.current()` 的快照。

冷条件不干净：`stage_fixed_query.py` 只对 `analytics.db` 做 `POSIX_FADV_DONTNEED`，不含 `-wal`，且是建议性的。reader 打开库时还会在计时前读页。连接复用解释不了 `service_ms`：该计时在 accept 之后。全机 `drop_caches` 不需要，也不要做。

组件探针 124.609ms 不是这一次完整 HTTP。

## 主13实施的对照

先第3项，只读现有 600k 库，不复制、不写事件。同一 SHA、同一查询 cgroup（CPUQuota=100%、MemoryMax=768M、IOWeight=20）。确认上传/维护/备份单位未在跑，生产 `:3006/ready` 仍 200。不要改产品时钟。

每个进程重复 3 次，顺序固定（冷在前是处理本身，不能随机化）：

1. 与失败跑相同的 fadvise，并写明动过哪些 inode。
2. 记 `read_bytes`：打开库之后、第 1 次 HTTP、第 2 次、第 21 次。
3. 同一次真实 HTTP 上拆开：`pre_http_ms`（`facts()` 起点到发出 fetch）、`remaining`、reader 内 evidence / assets / daily 三段、`service_ms`、客户端 `status` 与 `body_complete`。
4. 第 21 次之后用新连接再打 1 次。若只有客户端变慢、`service_ms` 仍低，连接建立与 137ms 无关，到此停。

裁决：

- 至少 2/3 次：第 1 次 `service_ms>120`，第 2 次和第 21 次 ≤50ms，且第 1 次 `read_bytes` 远大于后面几次。结论是 `app.fetch` 内的首次页读取。不是子进程，不是连接复用，也不是 abort 把短请求记成失败。门仍失败。
- `service_ms≤120` 但 body 未完整：才把原因记到 AbortSignal / 起跑点。再报 `facts()` 总时钟。产品时钟仍超过 120 则门失败。
- 第 1 次和后面几次都 >120：不是冷页。不要归因磁盘缓存。
- 只有 1/3 次超过：原失败保留，原因不稳定，不命名。

三次都完整且产品时钟 ≤120，只说明这次没复现。不能抵消已记录的那 1 次传输失败，也不能代替 1000 次零失败门。

第1项先不要新写入。若云端仍有该夹具的 `health.jsonl`，用每秒 `/ready` 的 `processing_p95_ms` 对照上面五段维护窗。这是关联，不是因果：库大小随时间增加。预先规则：窗外的服务器处理 p95 已经 >500，则维护不是必要原因；只有窗内超、窗外不超，维护才进入下一轮。备份仍缺起止时间，这一步不能给备份定罪或开脱。

只有这一步分不开时，才做短写入。从现有 600k 库出发，不重跑 50×12000。空间不够复制库就停，原因保持未分离。cgroup 与失败跑相同。每臂 50 身份 × 10 批 × 200 事件（500 次成功目标）。p95 仍只统计 200，503 照记。ABA 顺序：

- B0：不启维护、不启备份。检查点保持产品路径，这次记下每次耗时。
- B1：同样写入，但波次落在一次维护子进程之内。
- B0 再来一次。

两次 B0 的 p95 差若大于 B0 与 B1 的差，对照无效。两次 B0 都 ≤500 且 B1>500：维护重叠在这个库大小上足以把成功 ACK 顶过 500。三次都 >500：再加一臂 B2，备份在波次前 5 秒启动（对准原节奏）。B2>500 且 B0≤500：备份重叠足以解释。B0、B1、B2 都 >500：这一库上的写路径在无维护、无备份时已经超过 500；然后只再跑一次去掉 CPUQuota 和 MemoryMax 的 B0。去掉后 ≤500，超额来自测试 cgroup；仍 >500，cgroup 也不是必要原因。

任一臂 p95≤500 或 503 变少，都不算原混合门通过。原门仍是 50×12000、维护与备份按原节奏重叠、503 全保留、成功 ACK p95≤500。

## 不足以支持的说法

- 用窗外或错峰的通过，宣布第 1 项混合门通过。
- 删掉 503 或那 1 次超时后宣布通过。
- 用 p95=34.9ms、p99=50.1ms 或组件 124.6ms 代替首次完整 HTTP。
- 把 155 与 137 的差写成子进程或连接开销。
- 把半量 395ms 写成 600k 的原因。
- 在没有分段 `read_bytes` 时指定某一条 SQL 为那 17ms。
