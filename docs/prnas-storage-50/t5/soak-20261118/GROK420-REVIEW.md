# 有界根因审查 16716936

结论：混合仍是 FAIL，这不是上线验收，也不是 24h 验收。这次杀死进程的是第 302 次 Ark HTTP，状态 503，`ark_dependency_unavailable`。同一进程在这之前用 1117.7ms 读完一条历史查询，主线程 12 次采样里 11 次是 D 状态、`folio_wait_bit_common`。Analytics 摄入的 2185 次 503 全是 `ANALYTICS_OVERLOADED`，单独计数。

最小改动：只在 HTTP `accept` 上把 `busy_timeout` 瞬时设为 0，`finally` 恢复进入尝试前读到的值（构造时是 15），继续用现有 80ms 共享预算做异步让出。权限重检保持在每次重试之前。SLA 不放宽。这条改动去掉 SQLite 忙等回调里的同步睡眠。它盖不住这次 503，也盖不住 1117.7ms 的页等待。

不要把「每设备先读完所有 512 行页」改成「每设备一轮一页」当作这次的修复。不要加带 payload 的覆盖索引，也不要试图把 `rowid` 写进 `CREATE INDEX`。Nice 19 / ionice idle 不能当成磁盘等待已经消失。

候选仍按浸泡证据 `16716936d57315dc529d9aac25f3432cde3d1e0c`。相对基线 `5be3fb4b63ca96ccf7465217cd9582e10f56e7a5`。本审查只读，未改源码，未 SSH，未打云负载，未启其他代理。未重跑 53 步，未重跑 8 个合成 HTTP 测试。

审查开始时工作区 HEAD 是 16716936，工作区里有一份未提交差异：`attempt>=3`、让出 10/20/30ms、`tryAccept` 把 `busy_timeout` 设为 0 并在 `finally` 恢复。审查期间 HEAD 被别的提交推进到 `708a3149`（避免同步忙等）和 `9a5ac270`（前台/维护优先级试验）。`708a3149` 与 `9a5ac270` 的 Ark 三文件相同，但重试循环已变成固定 10ms、`attempt>=5`（最多六次），注释仍写 exponential。那不是下面评审的 10/20/30、四次尝试。浸泡和 Linux 持锁日志跑的是 16716936，不是这两个后继提交。

## 419 里继续有效的范围

`review-bounded-ark` 对 macOS Node 24.19.0 / SQLite 3.53.3 的忙等墙钟（`busy_timeout=15` 时 `BEGIN IMMEDIATE` 要 442–562ms）只说明那台 Mac。它不能外推这次 Linux。Linux 持锁证据已经补上，见下节。

419 里与墙钟无关、本轮不推翻的部分：非 BUSY 不重试、权限在再次 `accept` 前重读、已提交重放走同一快照、8 项合成 HTTP 测试本身不等待真实锁、维护缓存读回 8192 KiB 且不落盘。历史 SQL 不在 `5be3fb4b..16716936` 的修复范围内。

## Linux 持锁

`bounded-linux-evidence` 8 个文件的字节和 SHA256 与 `INDEX.json` 一致。`BOUNDED-PHYSICAL-V2-RESULT.json` 的 stdout：

| 持锁 | HTTP | 墙钟 | `sqlite_busy_attempts` | 断言后的记录序号 |
| --- | --- | --- | --- | --- |
| 250ms | 503 | 86.603812ms | 3 | 2 |
| 45ms | 200 | 50.742984ms | 1 | 3 |

Node `v24.19.0`，SQLite `3.53.3`。范围字符串是 `LINUX_SYNTHETIC_REAL_HTTP_AND_SQLITE_LOCKS_NOT_LOAD_PASS`。v1 物理脚本以 `1 !== 2` 退出，同目录 `prior_failure` 写明当时只改了 sequence，归档在 5 分钟内吞掉未变化的资产检查点；v2 改了 `family_coin` 并保留原断言。计时以 v2 为准。

因此 16716936 在这台 Linux 上，真实第二连接的 BUSY 能进入第 2、第 3 次尝试。250ms 持锁仍在约 86.6ms 处返回 503。45ms 持锁是一次 BUSY 之后 200。80ms 预算在 Linux 上够用到重试，不够把长于预算的持锁变成成功。

## 第 302 次才是 Ark HTTP 失败

`ark-continuous.jsonl` 共 302 行。前 301 行 HTTP 200 且 `body.status=accepted`。第 302 行（0-based index 301）是唯一的非 200：

- `at_ms=1794948684655`，`round=6`，`actor=1`，`snapshot_id=soak-1794948381779-1-6`
- HTTP 503，客户端墙钟 1605.217566ms
- body：`ok=false`，`error=ark_dependency_unavailable`
- 该行之后没有第 303 行。`assert.equal(r.status, 200)` 在 `storage-capacity-load.ts` 写完这一行后抛出，与 `FAILURE.json` 的 `503 !== 200` 是同一次断言。

`round` 的最大值是 6。0–5 轮各 50 次，第 6 轮只有 actor 0 和 actor 1。第 302 次是第 6 轮的第 2 个设备，不是 round 编号 302。

`ark-accept-errors.jsonl` 只有两行，都是 `ERR_SQLITE_ERROR`、`sqlite_code=5`：`1794948686186` 和 `1794948686257`。两次都落在这次请求的寿命里（起点 1794948684655，墙钟 1605ms，结束约 1794948686260）。文件里没有第三条 SQLite 错误。两次错误相距 71ms。16716936 的预算在第二次失败后若 `elapsed+20+15>80` 就抛出，不再做第三次 `accept`。这与「只记下两条 errcode 5，然后 HTTP 503」一致。

同轮 actor 0 是 HTTP 200，墙钟 569.777ms，起点 `1794948684056`。它结束在约 1794948684626，历史查询 0 的服务端起点是 `1794948684657`。这 570ms 成功的提交期间，主线程采样到 D 状态：`__wait_on_buffer`、`rq_qos_wait`、`jbd2_log_wait_commit`。这是提交/日志等待，不是 `busy_timeout` 回调。

导出周期 `archive-cycles.jsonl` 第三条：`began=1794948685845`，`backupStarted=1794948686400`，整轮 `done=1794948686673`。导出 stdout：`published=2`，`confirmed=0`，`busy_retries=0`，`sqlite_busy_timeout_ms=100`。两条 BUSY 都在导出开始之后、备份开始之前。`storage-ark-export.py` 用另一连接对 `ark.db` 做 `BEGIN IMMEDIATE`，HTTP `accept` 也是 `BEGIN IMMEDIATE`。时间重叠是日志里的事实。锁在这两次 BUSY 时由导出事务持有，是与代码和 `busy_retries=0` 相符的推断，不是 `pid` 级锁持有者转储。

## 150 次查询里的 13 次 transport

三份 `mixed-query-*.jsonl` 各 50 行，合计 150。transport 失败 13，全部在 `mixed-query-1794948683957` 的 actor 0–12。前两窗失败数是 0，p99 是 41.39ms 和 69.68ms。第三窗客户端 p99 是 164.62ms，`pass=false`。判定与 `storage-shared-query-service.ts` 相同：`status===200 && body_complete && receiver_pid===2495274`，并且结果文件还要求 p99≤100。

这 13 行的 `status` 都是 null，`body_complete=false`，`receiver_pid=null`，`correct=true`。客户端耗时 120.2–164.6ms。`ArkRuntime.facts` 把内部历史调用限制在剩余 120ms，超过约 125ms 就丢弃历史。`correct=true` 来自本地快照比对，不代表历史 HTTP 被客户端收完。

`shared-reader.jsonl` 150 行全部是服务端 HTTP 200，`receiver_pid=2495274`。第三窗 50 次也全部是 200。服务端处理时间：最小 5.5ms，中位 21.1ms，p95 84.1ms，最大 1090.4ms。服务端超过 120ms 的只有 query 0（1090.4ms）和 query 1（190.8ms）。其余 11 个客户端 transport 失败，是请求在 120ms 截止前没有把状态写回观察对象；服务端稍后仍返回 200。它们不是 HTTP 503。

## 1117.7ms 与主线程 wchan

`sql-query-profile.jsonl` 中 `mixed-query-1794948683957-0`：

- 请求墙钟 1117.713469ms，起点 `1794948684657`，终点 `1794948685775`
- `main_thread_cpu_during_request_ms=8.762`
- evidence 的 `all`：265.717560ms，`thread_read_bytes=24576`，`thread_cpu_ms=0.857`，`thread_read_calls=16`，索引 `analytics_ark_evidence_cover_v2`
- assets 的 `all`（语句含 `batch_attempt_id`，索引名在日志里被截成 `analytics_ark_as`）：819.494063ms，`thread_read_bytes=86016`，`thread_cpu_ms=2.32`，`thread_read_calls=38`

86016 字节是 86.016 KB。24576 字节是 24 KiB。两者与 819.5ms/86KB、265.7ms/24KB 一致。CPU 合计远小于墙钟。

`control/bounded-main-thread-wait.jsonl` 从 `1794948468653` 起每约 100ms 采样 pid `2495274`，标注 `read_only_100ms_outside_test_cgroup`。查询 0 的窗口内 12 个样本：1 次 R/`wchan=0`，10 次 D/`folio_wait_bit_common`，1 次 D/`do_get_write_access`。同一窗口 `read_bytes` 从 6373376 增到 6483968，差 110592。相邻样本每次增加 8192 或 12288 字节。这是页缓存未命中后的等待，发生在接收进程自己的 `SELECT` 上。

维护子进程的 `work_started_at_ms=1794948684996`，比这条查询的 D 状态晚约 339ms。查询剩余 779ms 与维护重叠。维护整段（到 `1794948745498`）接收进程 602 个样本里 564 个是 S/`ep_poll`，D 状态 19 个。接收进程没有被维护占满这 60 秒。

第三窗维护 stdout：`ok=false`，`partial=true`，两个维度都是 `budget_exceeded`，`rebuilt_days=0`，`cache_kib=8192`，prune 118ms，工作跨度约 60.5s。这是 30s 日预算用尽，不是这次进程断言的直接抛出处。

## Analytics 503 分开计

`requests.jsonl` 3685 行：HTTP 200 为 1500，HTTP 503 为 2185。2185 行的 `error` 全是 `ANALYTICS_OVERLOADED`。其中 HTTP 503 且错误不是该字符串的行数是 0。`client-result.json` 的 `attempts=3685`、`completed_batches=1500`、`failures=[]`。这组不加入 Ark 的 1 次 503，也不加入 13 次历史 transport。

## 翻页、索引、优先级

`rollup.ts` 的 `rebuildDay` 对每个 `device_key` 内层 `for(;;)`，`computed.more` 为真就继续同一设备。每页在 `buildDevice` 里最多 512 行（SQL `LIMIT 513`），然后单独 `readSnapshot` 和 `transaction` 提交 stage。页与页之间已经释放写事务。改成每设备一轮一页，改变的是页的顺序，不是把一个大事务拆开。

索引在 `rollup-index.ts`：`analytics_rollup_device_rowid` 只列出 `(dimension, day, device_key)`。`hasRollupPrefixIndex` 要求隐式 `rowid`（`cid=-1`）附在这三列之后。事实行按插入交织，同一设备的 `rowid` 在堆上不连续，薄索引命中后要回表。先扫完一个设备会按该设备的 `rowid` 从早到晚走一遍堆；50 个设备就是 50 遍。每设备一轮一页会让同一时间带的回表更靠近，在维护连接只有 8MiB page cache 时有可能提高命中。这是结构推断，本次日志没有维护进程的页故障计数，不能当成已测量的收益。第三窗慢的是历史 assets/evidence 索引读，不是这条 rollup `SELECT`。

本机隔离探针（临时目录，已删除；二进制 `/Users/fu-121/.local/node-v24/bin/node`，v24.19.0，SQLite 3.53.3；路径 `.../bin/node24.19.0` 不存在，所以没有用那个文件名）：

- `CREATE INDEX ...(dimension,day,device_key)` 的 `index_xinfo` 在三列之后是 `cid=-1`。
- `CREATE INDEX ...(dimension,day,device_key,rowid)` 报 `no such column: rowid`。
- 加上 `semantic_json` 后，payload 列位于隐式 `rowid` 之前。`ORDER BY rowid` 不再紧跟等值列。

所以不加覆盖索引，也不把 `rowid` 写进索引定义。

测试单元是 `CPUQuota=50%`、`MemoryMax=768M`、`Nice=15`、`IOWeight=10`，整组包含接收进程。生产维护单元 `deploy/systemd/p003-analytics-rollup.service` 是独立 oneshot，`Nice=10`、`IOSchedulingClass=best-effort`、`IOSchedulingPriority=7`。两组调度不相同。固定 SLA（客户端 p99≤100，且 transport 为 0）不放宽。

慢查询窗口的线程在 D 状态等页，不在运行队列。Nice 只改变 CPU 可运行顺序，不缩短已经进入 `folio_wait_bit_common` 的等待。同一次成功的 Ark 提交还等到了 `jbd2_log_wait_commit` 和 `rq_qos_wait`。把维护单独降到 Nice 19 或 ionice idle，只可能减少它和这次读抢磁盘的部分；读者自己的缺页还在。值得做的是单变量 A/B，并且继续用现在这份 100ms wchan 采样对照。不能把 A/B 设计写成磁盘等待已被消除。

证据包内的 `resources.jsonl`、`health.jsonl`、`bounded-cadence-guard.jsonl` 没有 `mq-deadline`、`wbt_lat`、`rotational`、`vda` 原文。调度器名、`rotational=1`、`wbt_lat_usec=75000` 按主 13 的只读 sysfs 观察引用。若调度器确是 mq-deadline，cgroup `IOWeight` 不决定该调度器的请求顺序；这条没有附在证据包里的 sysfs 转储。wchan 结论不依赖它。

## 对这条最小设计的意见

同意只包 HTTP `accept`：`tryAccept` 读出当前 `busy_timeout`，设为 0，调用现有 `accept`，`finally` 写回读到的值。构造函数写的是 15，所以这条连接上恢复的就是 15，除非同连接上先有别的语句改过它。写回读到的整数，比在 `finally` 里写死 15 更不容易把非 15 的先前值覆盖掉。`previous` 需要是安全整数再拼进 `PRAGMA`，避免读到意外形状时执行 `busy_timeout=NaN`。

`accept` 在这条路径上是同步的，`finally` 会在同线程的下一次请求之前运行。管理员 `authorize` / `configure` 仍用原来的 `busy_timeout=15`，不在这次 HTTP 热路径上。

重试次数按你描述的四次尝试（初次加上 10/20/30ms 三次让出），上界 `attempt>=3`。80ms 含 15ms 操作余量时，第四次尝试只有在每次 `BEGIN IMMEDIATE` 立刻返回时才进得去：10+20+30=60，再加 15 的余量是 75。提交时的 fsync 算在同一次尝试里，余量会被吃掉，后面的让出可以不发生。注释里应保持「盖不住同步磁盘 IO 和调度暂停」。

`708a3149` 已把循环改成固定 10ms、最多六次。注释写 exponential，代码却是常数 10。六次立刻返回的尝试仍落在 80ms 内，SLA 数字没有放大，但这不是 10/20/30 四次，也没有新的混合测量。本次意见不把 `708a3149` 或 `9a5ac270` 算作已验证修复。

权限重检保持现有分支：重试前再次核对凭据、identity、`grant_id`、ceiling。不要改比较对象，不要加队列。

这条设计做得到的事：Linux 上那几次十几到几十毫秒的同步忙等不再占着接收进程的事件循环。45ms 持锁那次，立刻返回 BUSY 再按 10/20/30 让出，锁在 45ms 释放后，第四次尝试仍可能在 80ms 内成功。250ms 持锁那次仍然 503。

这次浸泡做不到的事：第 302 次请求的两条 BUSY 在 `1794948686186` 和 `1794948686257`，导出写入周期至少延续到备份开始的 `1794948686400`。四次立刻返回的尝试从第一条 BUSY 起大约 60–75ms 就用完预算，仍早于 `1794948686400`。503 还在。请求前半段的 1117.7ms 是历史 `SELECT` 的 D 状态页等待，`busy_timeout` 不作用在那条 `SELECT` 上。同轮那次 570ms 的成功提交等在日志提交，设为 0 也不会把它变短。

因此它是忙等回调的最小正确改法，并且应该单独落地、单独测量。它不是这次混合 FAIL 的充分修复。翻页和 Nice/ionice 不要打进同一补丁。

## 可证与仍属假设

可证，来自原始日志或 16716936 源码：

- 34 个 cadence 文件与 `INDEX.json` 的字节和 SHA256 一致。Linux 8 个文件一致。整包 `bounded-cadence-evidence-16716936.tar.gz` 的 SHA256 是 `5f694656e28df84a059bd14e23037ee5acf40a54c573052e29e762029a2a1503`。
- Ark HTTP 302 次中 301 次 200，第 302 次 503；SQLite 错误文件恰好两条 errcode 5，时间落在这次请求内。
- 150 次混合查询、13 次客户端 transport；服务端 `shared-reader` 150 次都是 200。
- 查询 0 的 1117.713ms、assets 819.494063ms/86016 字节、evidence 265.717560ms/24576 字节、主线程 CPU 8.762ms，以及 11/12 次 D/`folio_wait_bit_common`。
- Analytics 2185 次 503 都是 `ANALYTICS_OVERLOADED`。
- Linux v2：250ms 持锁 3 次 BUSY 后 503、86.6ms；45ms 持锁 1 次 BUSY 后 200、50.74ms。
- 每设备页循环已经按页提交。本机 SQLite 3.53.3 拒绝显式索引 `rowid`，payload 列插在隐式 `rowid` 前。
- 测试 cgroup 与生产维护单元的 Nice/IO 设置不同。

仍是假设：

- 两条 BUSY 的写锁持有者就是导出进程的 `BEGIN IMMEDIATE`。时间重叠和代码路径支持它，没有锁属主采样。
- 导出锁是一段连续持有，还是若干短事务刚好两次都打中。短空隙能被 `busy_timeout=0` 钻过，这次日志区分不了。
- 每设备一轮一页能在 8MiB 缓存下减少回表缺页。没有维护进程的对照实验。
- 维护 IO 把查询 0 后 779ms 拖长了多少。D 状态在 `work_started` 之前已经开始。
- 主 13 所述的 mq-deadline / rotational / `wbt_lat_usec=75000`。证据包里没有 sysfs 原文。
- `708a3149` 的六次 10ms 轮询在真实导出重叠下的 HTTP 结果。没有新跑。

## 未做

未重跑混合、未重跑 8 项合成测试、未重算 547 个源码哈希（`INDEX.json` 记录 `candidate_files_verified_after=547`）。未改 16716936 之后那两个提交。未宣称生产同配置，未宣称整体验收。
