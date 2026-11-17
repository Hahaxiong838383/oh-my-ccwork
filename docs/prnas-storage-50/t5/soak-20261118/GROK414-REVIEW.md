# 193bf990 同接收端混合查询失败审查

审查对象是 `193bf990b3d15192815254ebeb31375a87a7eb2b` 上一次真实同接收端混合查询。证据只有 `SHARED-ACTUAL-QUERY-FAILURES.json`（sha256 `73cd3de7286c5ad9cf9a41ad2937f8e5b2875c9f166e43787c41b630352a1ef8`，26739 字节）以及该提交里点名的源码。没有改源码，没有 SSH，没有碰生产，没有重跑负载，也没有打开本文件以外的运行日志。

配对数字和分类在同目录 `CHECKS.json`。整轮仍在跑。这里不给吞吐最终值，也不把 24h 门写成已开始或已通过。前两轮 100 条全过、P99 47ms / 67ms、第 3 轮 50 条里 27 条失败、资源信封 0.5 CPU / 768MiB，以及「快照上传 + 归档/日批重叠」，都是本轮任务陈述，不在这份 JSON 里。下面把它们标成「陈述」，和 JSON 里算出来的数分开。

## 结论

传输失败的分类机制已经能由配对时间戳闭合。27 条都是同一个 receiver pid `2467675` 的 `POST /internal/analytics/ark-summary`。客户端在约 120ms 处 abort，`status=null`、`body_complete=false`、三个 header 计时都是 null，于是被算作 `history_transport_failures`。服务器随后对这 27 条全部返回 HTTP 200。`correct=true` 只说明查询进程用 Ark 快照对上了币、卡和星尘；客户端没有读到 history 正文。

这 27 条不是 27 次各自独立、都超过 120ms 的 SQL：

- 26 条（query 0–25）在客户端已经结束之后，服务器才进入 fetch handler。
- 其中 23 条（query 2–5 和 7–25）的 handler 实测低于 100ms。它们失败是因为入口晚了。
- query 0、1、6 的 handler 自身也超过 120ms，而且入口同样晚于 abort。query 0 的 2545.86ms 发生在客户端失败之后，并占住主线程，使后面的入口继续后移。
- query 26 是唯一一条入口早于 abort 的失败：发送后 7ms 进入 handler，应用墙钟 120.80ms，服务器 `done_at_ms` 比客户端 `at_ms` 晚 6ms。query 25 的完成比 query 26 的发送早 72ms，这条队列当时已经排空。

还没有闭合的是两段墙钟的物理原因：handler 进入前那至少 123ms，以及进入之后那 2545.86ms。H1–H6 都是可证伪假设。测试路径的 64MiB `cache_size` 与生产 8MiB 的差异，以及同 cgroup 共租，都还不是已证明根因。

## 已成立的机制

客户端判定在 `src/ark/runtime.ts` 第 29–36 行。`facts()` 在身份和 `grant()` 之后把剩余时间设为 `max(1, 120 - 已用)`，到点 `AbortController.abort()`。`Promise.race` 在 abort 时解析成 `unknownHistory()`。只有整段仍落在 125ms 内才采纳结果。`scripts/storage-shared-query-service.ts` 第 23–24 行把 transport 成功定义成 `status===200 && body_complete && receiver_pid===config.receiver_pid`。这 27 条三个条件全假，所以计入 transport failure。`pending<8` 不是这一轮的限制：查询进程对设备是串行的，中间还有 50ms 间隔。

资产仍可判对，因为 `resolveArkFacts`（`src/ark/context.ts` 第 4–16 行）在 history 不是 `available` 时走快照。abort 路径放进 `unknownHistory()`，快照仍可让 `correct===true`。服务器 HTTP 200 只说明 `readArkHistory` 没有抛错。响应体不在本证据里，不能据此说 history 状态是 `available`。

服务器计时在 `scripts/storage-capacity-load.ts` 第 56–59 行的 listen 包装，不在 `readArkHistory` 内部。`received_at_ms` 是 fetch 回调被调用时的 `Date.now()`，不是内核 accept 时刻。`ms` 是包住 `app.fetch` 的 `performance.now()` 差。query 0 的日期差是 2546ms，`ms` 是 2545.861547ms。`appendFileSync` 发生在 `done_at_ms` 之后，不在这 2545.86ms 里。

因此：

- `received_at_ms - sent_at_ms` 包含客户端 `grant()`、请求写出，以及服务器主线程还没跑到这个回调的时间。
- `ms` 是该次 `app.fetch` 的墙钟，包含同步 SQL、await 期间主线程去做的别的工作，以及锁等待。它不等于单条 SQL 的 CPU 时间。

维护报告与查询名：

| 锚点 | 值 |
| --- | --- |
| 查询名 `mixed-query-1794941237266` | `1794941237266`，即 `maintain()` 里的 `start` |
| 子进程 `work_started_at_ms` | `1794941237672`，比查询名晚 406ms |
| `work_finished_at_ms` | `1794941298414`，工作窗 60742ms |
| rollup | `attempted_days=2`，`rebuilt_days=0`，`occurred/2026-11-18` 与 `received/2026-11-18` 都是 `budget_exceeded`，`remaining_dirty_days=2`，`partial=true` |
| prune | `chunks=1`，events/batches/facts 都是 0，`elapsed_ms=425.323473`，`max_transaction_ms=425.29488`，`budget_exhausted=false` |

`scripts/analytics-rollup.ts` 第 9–17 行先 `new AnalyticsStore`，再记 `work_started_at_ms`，再 `pruneAnalyticsCycle`，再 `rollupDirtyDaysWithStatus`。那 406ms 是 spawn 加上 store 构造；构造本身不在 60742ms 里面。两维 30s 预算来自 `rollup.ts` 的 `maxDayMs` 默认 30000。报告只有 `budget_exceeded`，没有每一维的实测耗时。`30s+30s+425.32ms` 与 60742ms 相差约 317ms。这个余量能装下预算检查的越过量和收尾事务，但不能单独证明每一维都刚好跑满 30s。

prune 的 425ms 对应用户说的 TTL。`analytics-rollup.ts` 的注释要求先提交有界短事务。实测这一次只跑了一个 chunk，删除计数是 0，`budget_exhausted=false`，所以 `PRUNE_CYCLE.maxMs` 的 30s 没有用完。这 425ms 是维护进程里的单次事务墙钟，不是接收端 handler 的数。

query 0 相对维护戳：

- 发送在 `work_started` 前 227ms，也在查询名后 179ms。
- 客户端 `at_ms` 在 `work_started` 前 105ms。120ms 预算在维护工作戳开始之前已经耗尽。
- `received_at_ms` 在 `work_started` 后 18ms，比客户端 `at_ms` 晚 123ms。请求在 abort 时已经发出，因为服务器后来按同一个 `query_id` 返回了 200。服务器侧至少有 123ms 还没进入 handler。
- handler 从 `1794941237690` 到 `1794941240236`。这 2546ms 覆盖 prune 事务的后段，然后进入 rollup。prune 只有 425ms，覆盖不了整段 2546ms。

query 1–25 的 `received - sent` 从 2640ms 严格降到 130ms。相邻 handler 的 `received[i] - done[i-1]` 在 2ms 到 99ms。这是单线程回调串行，中间夹着别的主线程工作。query 26 发送时，前一条已经结束 72ms，不再排在这条队列后面。

服务器 `ms` 超过 100ms 和超过 120ms 的都是这四条：query 0 为 2545.862ms，query 1 为 126.556ms，query 6 为 122.518ms，query 26 为 120.799ms。客户端 abort 相对发送是 120–122ms，query 19 是 132ms。query 19 说明客户端定时器被推迟了约 12ms，这个幅度产生不了这 27 条失败。

前一版额外 `newArkStore` 连接重建已经修掉。这一次对得上那个结论：查询进程在循环外只 `new ArkStore` 一次（`storage-shared-query-service.ts` 第 11 行）；27 条 receiver pid 相同；失败形态是 abort 之后的 HTTP 200。

## 可证伪假设

验证时一次只改一个因素。库用已停止合成库的派生拷贝。原失败 JSON 和原库文件只读。不启动 50×6000 生成器。

### H1. query 0 的 2545.86ms 是该次 handler 里不让出的同步工作

预测：在同类请求的 `app.fetch` 内，`prepare/get/all/exec` 的同步耗时之和接近 2545.86ms；`readBoundedJson` 前后的墙钟差接近 0。同步段期间，事件循环延迟探针会被同样拖住。下一条 ark-summary 的 `received_at_ms` 不早于上一条 `done_at_ms`。

证伪：同步 SQL 之和远小于 2545.86ms，缺口落在 `readBoundedJson` 或别的 await 上。那样这 2546ms 是 handler 让出之后，主线程在做别的同步工作，墙钟被算进了这次 `app.fetch`。

H1 解释得了随后的排队，解释不了 query 0 在进入前就已经失败。入口前的 123ms 交给 H2–H4。

### H2. 入口延迟的尾巴与维护子进程打开库对齐

`work_started_at_ms` 打在 `new AnalyticsStore` 返回之后。handler 入口在这个戳之后 18ms。构造函数会跑 `configureAnalyticsWriter`（含 `journal_mode=WAL` 和 `busy_timeout=250`）、`cache_size=-65536`，以及一系列 `CREATE TABLE IF NOT EXISTS` 和迁移探测。这些发生在 60742ms 工作窗之前，和 query 0 的在途请求重叠。

预测：把构造函数单独打点之后，父进程在入口前的不可运行时间覆盖构造函数，并在构造函数返回后约 18ms 内进入 query 0 的 fetch 回调。若父进程当时卡在另一次同步 SQLite 调用上，该调用的返回也落在这个窗口。

证伪：spawn 到构造函数入口已经接近 406ms，构造函数本身只有几毫秒，而且父进程在这 406ms 里没有同步 SQLite，也没有事件循环滞后。那样 18ms 对齐只是时间靠近。

H2 即使成立，也只覆盖入口前的相位，不覆盖随后 2546ms。

### H3. 同一 Node 主线程上的其他同步段挡住了回调

测试接收端是 `createAnalyticsApp` 加本进程里的 `/t5/ark` 路由，没有走 `startAnalyticsServer`。`produceArk()` 在父进程里逐个 `await fetch` 写快照。日批客户端是另一个进程，请求进同一个 HTTP 服务器。`node:sqlite` 的 `DatabaseSync` 在调用它的线程上同步执行。快照写入、`/ready` 的 `health()`、日批处理在 `await` 之前的同步段，都会让 ark-summary 的 fetch 回调排不进来。writer 在 `worker_threads` 里，它的 SQL 不直接冻住主线程；它仍占用同一 cgroup 的 CPU，并和主线程抢 SQLite 锁。

预测：入口前的滞后与一次主线程同步调用重合，且那次调用不是 `readArkHistory`。派生拷贝上如果只跑维护进程和一条 history 查询，入口延迟消失；把父进程内的快照循环加回来，延迟重新出现。

证伪：去掉快照生产者和日批客户端之后，入口前滞后仍在，并且父进程探针显示当时没有别的同步调用。

JSON 里没有快照日志或日批日志，所以 H3 现在没有被这份配对数据证实，也没有被否定。

### H4. 同 cgroup 共租把墙钟拉长；生产的进程隔离与此不同

代码里的共租是实的。父进程同时承担 HTTP、Ark 路由和 writer 线程，并拉起 checkpointer、维护、归档/备份 Python、日批客户端和 Brain 查询进程。`storage-soak-schedule.ts` 把非 smoke 的维护间隔定成 300000ms。查询周期在 `maintain()` 里和维护子进程并行（`storage-capacity-load.ts` 第 69–73 行）。日批开始后还有一次 `Promise.all([maintain(), archiveCycle()])`（第 122 行）。陈述中的信封是 0.5 CPU / 768MiB。这份 JSON 没有 `cpu.max`、`memory.max` 或 `cpu.stat`，所以 0.5 和 768 不能从本文件复核。

生产 `startAnalyticsServer` 把查询连接和 writer 放进 analytics 进程。游戏快照、Brain、日批生成器和归档 Python 不在这个测试父进程的同一条事件循环上。这次失败不能直接外推成生产在同样 SQL 上也会失败。隔离不同，也不能用来宣布这次失败只属于测试拓扑、生产已经没问题。

预测：同一派生库、同一条 history SQL，只留维护进程和一个查询客户端时，入口和 handler 都低于 100ms。把父进程内的快照循环、日批客户端和归档加回去，并且仍使用陈述中的 0.5 CPU / 768MiB 信封，墙钟才再次超过 120ms。

证伪：去掉共租之后，单次 history 仍出现 2546ms，或稳定出现 121ms。那样共租不是这次数的充分原因。若只有共租场景变慢，结论也只写到「这个 soak 拓扑会把查询顶过 120ms」。在生产形态的测量完成之前，不能写成「加上 CPU 或内存就已经解决」。

### H5. `busy_timeout=250` 的锁等待堆成了 2546ms

每个 `AnalyticsStore` 都执行 `PRAGMA busy_timeout=250`（`sqlite-policy.mjs` 第 14 行），包括 HTTP 读连接、writer 线程和维护进程。一次 statement 的忙等上限是 250ms，到点返回 `SQLITE_BUSY`。`readSnapshot` 不重试。单条 statement 不可能靠这个忙等停 2546ms。要用锁解释 2546ms，需要许多次连续、每次都几乎等到上限又刚好成功的 statement。`readArkHistory` 的 evidence、facts、若干 `analytics_batch` 点查和 daily 查询，数量上做得到。prune 的 `BEGIN IMMEDIATE` 只有 425ms；rollup 的长段主要是延迟读，WAL 读者之间通常不互斥。

预测：语句探针里的忙等累计接近 2545.86ms，并且和子进程的 `BEGIN IMMEDIATE` 重叠。

证伪：query 0 同类请求的忙等累计接近 0。那时应放弃「锁等待是 2546ms 的主体」。425ms 且删除计数为 0 的 prune 仍可以单独作为维护事务过长的问题，但它本身不是这 27 条的分类器。

### H6. 队列排空后，重叠期间的稳态已经贴着 120ms

query 26 在队列清空后仍以 120.80ms 的 handler 输掉 120ms abort，服务器完成只晚 6ms。陈述说这一轮还有 23 条成功。那些样本不在本 JSON 里，不能拿来算这一轮 P99，也不能假设它们都远低于 100ms。

预测：在 H1 的长 stall 被拿掉之后，重叠窗口里仍有一批 handler 落在 100–125ms，P99 仍过不了现有的 100ms 查询门。

证伪：派生拷贝上，同样的维护重叠里，串行查询的 handler P99 低于 100ms，query 26 这种 121ms 不再出现。那样 121ms 是这一次残留争用的单点，不是稳态。

## 不能写成已证明根因的配置差异

测试接收端走 `createAnalyticsApp`（`storage-capacity-load.ts` 第 54 行），没有走 `startAnalyticsServer`。后者在监听前执行 `PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA shrink_memory`（`src/analytics/index.ts` 第 163 行）。`AnalyticsStore` 构造函数把连接设成 `cache_size=-65536`（`store.ts` 第 39–40 行）。负值单位是 KiB：测试 HTTP 连接的 pager 预算是 64MiB，生产查询连接是 8MiB。注释写明这不是 RSS 上限。writer 线程也保留 store 的 64MiB pager 预算。

这 27 条失败发生在测试路径的 64MiB pager 预算之下。8MiB 不是这次失败的原因。生产更小的 cache 仍是外部有效性缺口：生产可能更慢，这次数据没有测量它。把测试改成 8MiB，或把生产改成 64MiB，都还不是针对已证明根因的修复。复现时要记下连接上的实际 `cache_size` 和 `query_only`，避免和这次结果混写。

同 cgroup 与生产隔离的差别见 H4。它必须写进复现条件，现在还不是已证实的根因。

## 明确不采用的动作

不放宽 `runtime.ts` 的 120ms abort 或 125ms 接受窗。23 条失败的服务器 handler 已经低于 100ms，放宽客户端期限只会把「入口迟到」记成成功。容量脚本里 ACK 的 p95 500ms 门（`storage-capacity-load.ts` 第 172 行）不是这 27 条的分类器；这次审查也不建议放宽它。

不把「加大 CPU / 内存」写成已经解决。H4 要求先在派生拷贝上分开测。不把 `cache_size` 对齐写成修复。不重新打开 `newArkStore` 连接重建。不在原库上复现。不宣称这一轮吞吐或 24h 结果。

## 最小验证

只在测试接线里做，不改生产路径。库用已停止合成库的派生拷贝。原证据文件和原库保持不动。

用 `AsyncLocalStorage` 包住一次 history 请求，记录：

1. 客户端：`grant()` 结束、`fetch` 发出、abort。用来确认入口前的时间在哪一侧。
2. 服务器 fetch 回调入口，以及 `readBoundedJson` 进入和返回。
3. 该请求期间每一次 `prepare` / `get` / `all` / `exec`：SQL 文本的 hash、阶段名、同步墙钟、返回行数。参数只记 hash。不记 subject、账号、token、密钥或原始参数。
4. 一次约 50ms 的预期定时器的实际延迟，用来区分「主线程被同步调用占住」和「进程没被调度」。
5. 维护子进程：spawn 时刻、`AnalyticsStore` 构造入口和出口、prune 事务入口和出口。出口应与现有 `work_started_at_ms` 对齐。

判定：

- H1 成立，当第一条长请求的同步 SQL 之和覆盖 handler `ms`。
- H2 成立，当构造函数区间覆盖父进程入口前的滞后，并且父进程在构造函数返回后十几毫秒内进入回调。
- H3 成立，当滞后在「只留维护进程 + 查询客户端」时消失，并在把父进程快照循环加回来时重新出现。
- H4 成立，当同一拷贝在去掉共租后低于 100ms，只有把共租和陈述中的 0.5 CPU / 768MiB 信封加回来才超过 120ms。这个结果描述 soak 拓扑，不描述生产。
- H5 成立，仅当忙等累计接近整段 handler 墙钟。接近 0 则 H5 退出。
- H6 成立，当长 stall 消失后，重叠窗口的 handler P99 仍超过 100ms。

复现顺序保持最小：先维护进程加一条查询；再 50 条串行查询；最后才按需加回一个共租角色。

## 随验证结果而定的最小修复

在矩阵有结果之前不改查询语义，也不改期限。

- H1 且一条 statement 占满 2546ms：在派生拷贝上对那条 SQL 做 `EXPLAIN QUERY PLAN`，只改那条计划能避免的扫描。`readArkHistory` 的 evidence 语句带 `json_extract` 和 `GLOB`，覆盖索引不能自动证明它没有在过滤前读很多行。这是候选，不是已经定位的语句。
- H1 且时间分在多条短 statement 上：先看是不是每条都在等锁。是则转入 H5。不是则保留语句级证据，不先把读取搬出进程。
- H2 成立：不要在与第一条查询重叠的窗口里对已存在的库重复做重探测。先把探测移出这个窗口，再用同一探针确认入口前滞后消失。
- H3 成立：让探针点名的那一段主线程同步工作让出，或离开查询所用的事件循环。先动那一个调用。
- H5 成立：先缩短被点名的 `BEGIN IMMEDIATE` 事务。这次报告里的候选是 425ms 且删除计数为 0 的那次 prune。确认忙等消失后，再决定要不要动读者。
- H6 成立且 H1 不成立：稳态仍贴着 120ms。继续用语句探针找那约 20ms 余量，而不是放宽 120ms。
- 只有 H4 成立：把 soak 报告写成「共租拓扑下的失败」，并另做一次生产式进程隔离的测量。隔离测量完成之前，不宣布增加资源已解决，也不宣布生产已经失败。

## 未确定边界

- 本 JSON 只有 27 条失败配对和一份维护摘要。成功的 23 条、前两轮原始样本、资源采样、快照日志和日批日志都不在证据内。
- 两个 rollup 维各自的耗时不在报告里，只有 `budget_exceeded` 和总窗。
- HTTP 200 的响应体不在证据里。
- `received_at_ms` 不是内核 accept 时间。query 0 入口前至少 123ms 已经由「abort 之后才进入回调」证明在服务器侧；从 `sent_at_ms` 起算的 245ms 仍含客户端 `grant()` 到真正写出请求的时间。
- handler `ms` 还没有拆成同步 SQL、锁等待和事件循环间隙。
- 0.5 CPU / 768MiB 是陈述中的运行信封，本文件不能复核。
- 生产 8MiB `cache_size` 和 `query_only` 这次没有被跑到。
- 整轮未结束，吞吐和 24h 门无结果。
