# 审查：10ms CPU 周期能否分开调度与 SQL/内存

审查范围是固定提交 `9e9b481908c1f62f8c25c95209e68d398f1057a4` 的诊断与 profile 代码，以及只读证据。没有 SSH，没有部署，没有改业务树，没有重跑负载。24h 未开始。这里不把生产问题写成已定位，也不把任何一轮写成验收通过。

主 13 在本目录留下的更新说：10ms 没有稳定收益，不采用；完整混合的 profile 重跑已启动。下面的数字是从证据和 `sql-diag-evidence-01-06.tar.gz`（sha256 `75f27c46ff5700fc36348f8a9738c9073d36717f0afa07cc011188457d97837b`，137 个成员加索引）重算的，用来核对那份结论，并给出还能证伪的下一步。

## 结论

10ms 周期实验做实了，而且不支持把它当作修复。它没有把「CFS 配额周期」和「同步调用内部的睡眠」分开，也没有碰到原来那次 `memory.max`。

已能肯定的只有这些：

- 原完整混合是另一套负荷。250 次查询里 29 次 history transport 失败，全组 P99 132.039ms；30 万条 ACK 齐、dirty 0；cgroup 工作集峰值 96.73%；`memory.events` 的 `max` 从 0 增到 8530。宿主可用内存最低仍有 47.5%，OOM 为 0。
- 派生拷贝上的 01–06 全部是 `memory.max` 事件 0。82.121ms 墙钟 / 13.059ms 线程 CPU 的那条历史查询，附近采样的 cgroup 内存约 222MB，不是 768MiB 顶格。
- `cpu.max` 在 10ms 那轮实测是 `5000 10000`，100ms 轮是 `50000 100000`。额度仍是 0.5 CPU。run03 有 1557 个周期里 1175 个被节流，`memory.pressure` 累计为 0。处理是真的，不是没生效。
- 同口径的暖缓存轮次里，10ms 没有稳定低于 100ms。run03 的 `diag-mixed-0` 单轮 P99 是 112.064ms，transport 失败为 0，仍然过不了 P99≤100 的门。
- 唯一的 transport 失败是 run02 的 `diag-mixed-0-31`：客户端 135.482ms，进入 handler 前 50ms，handler 91.076ms。失败在这一次同步调用本身跨过 120ms 预算，不是 2545ms 那种把后续入口全部推过 abort 的队列。

因此：不采用 10ms。也不把减 cache、拉长后台间隔或加大 CPU 当作下一步。下一步只做已经在写的 profile 配对，见文末。

## 两套负荷不能并成一个根因

| 来源 | 查询 | transport 失败 | 内存 | 与周期实验的关系 |
| --- | --- | --- | --- | --- |
| `SHARED-CADENCE-INDEPENDENT-FAILURE.json`，候选 `193bf990` | 250 | 29 | 工作集峰值 0.96726；`max` 事件 +8530；`memory.current` 顶到 805306368 | 周期实验没有重放这一套 |
| run01，100ms，统计缓存仍有效 | 200 | 0 | `max` 事件 0；schema 慢调用附近约 248MB | 单轮 P99 146.247ms，`pass=false` |
| run02，100ms，`mutation+1` 后第一次重建 | 750 | 1 | `max` 事件 0；电流峰值 764080128（94.9%）；按现行工作集公式峰值只有 0.406 | 82/13 出现在重建开始后约 1.7s |
| run03–06，10/100/10/100ms，页面已热 | 各 200 | 0 | `max` 事件 0；电流约 280–304MB | 只比较周期 |

原失败的资源行里没有 `throttled_usec`，也没有 `memory.pressure`。8530 次 `max` 说明 cgroup 反复触到上限，不能由此推出那 29 次超时的毫秒发生在回收里。拷贝侧则相反：慢调用时离上限还远。两边缺的是同一次调用上的节流增量和 `max` 增量。

原峰值那一笔（`resources.jsonl`，monotonic 约 354454ms）`inactive_file` 只有约 48MiB，其中脏页约 23MiB，减完可回收干净缓存后工作集仍是 96.73%。拷贝 run02 的高 `memory.current` 里有约 406MiB `inactive_file`，所以工作集只有 40.6%。文件页缓存和匿名工作集不是同一件事。

## 10ms 实验实际比较了什么

驱动在每一轮之前对拷贝执行 `UPDATE analytics_rollup_source SET mutation=mutation+1`（100 行），再跑 `storage-query-diagnostic.ts`。`CPUQuota=50%`、`MemoryMax=768M`、`T5_DIAG_CACHE_KIB=65536` 不变，只改 `CPUQuotaPeriodSec`。第一份驱动在 run03 之后因自己的 Python SQLite 连接没关闭，`fuser` 断言失败；V2 关掉连接后跑完 04–06。这是诊断脚本问题。

run02 的维护窗是 40113ms，一个维度 `budget_exceeded`。run03 起两次维度都重建成功，维护窗约 9–10s。`rollup.ts` 在 `stage.mutation===source.mutation` 时走缓存，否则 `buildDevice`。第一次把 mutation 打穿会冷扫；后面几轮页已经在页缓存里。汇总里「不得把暖缓存改进都归于 CPU 周期」成立。

单轮门是 `storage-shared-query-service.ts` 的 `invalid===0 && transport===0 && p99<=100`。把多轮样本合成一个「全组 P99」会把失败轮藏起来：

| 轮 | 周期 | 不过门的单轮 | 该轮 P99 | transport | 该轮最慢样本：客户端 / 入口 / handler |
| --- | --- | --- | --- | --- | --- |
| 01 | 100ms | `diag-mixed-0` | 146.247 | 0 | 146.2 / 43 / 101.7，HTTP 200 |
| 02 | 100ms | `diag-mixed-0` | 135.482 | 1 | 135.5 / 50 / 91.1，status null |
| 03 | 10ms | `diag-mixed-0` | 112.064 | 0 | 112.1 / 20 / 80.1，HTTP 200 |
| 04 | 100ms | 无 | 最高 93.608 | 0 | 冷轮 93.6 / 4 / 69.3 |
| 05 | 10ms | 无 | 最高 81.191 | 0 | 81.2 / 8 / 49.7 |
| 06 | 100ms | 无 | 最高 98.323 | 0 | 98.3 / 5 / 14.3 |

04 和 06 是 100ms，05 是 10ms，三轮都是暖重建、零 transport 失败。10ms 的最大客户端时间落在两次 100ms 之间。run03 更慢，并且单轮 P99 仍过不了 100。没有稳定的 10ms 收益。

run06 最慢的客户端样本 handler 只有 14.3ms，入口 5ms，客户端比 handler 多出 84ms。run02 的 `diag-mixed-12` 同样：客户端 98.3ms，handler 19.7ms。`cycle()` 的 `ms` 包住整个 `preview()`：fetch 前的 `grant()` 和返回后的再次 `grant()` / `current()` 都算在里面。查询子进程和接收进程、rollup 子进程在同一个 systemd 单元里，共用 0.5 CPU。表上的 P99 因此同时含服务器 SQL、客户端 ArkStore，以及两者抢同一配额。它不能单独代表 SQL。

## 同步 SQL 与队列

`readArkHistory` 在 `POST /internal/analytics/ark-summary` 里于 `await readBoundedJson` 之后同步执行（`src/analytics/index.ts`）。`readSnapshot` 是 `BEGIN` 加整段回调再 `COMMIT`，中间没有让出事件循环。`arkHistoryReadIndexes` 每次读取都查 `sqlite_schema`。历史查询是同步 `all()`。这段墙钟有多长，主线程就被占多久；占住期间下一个 fetch 回调进不来。

客户端在 `facts()` 里把剩余时间设为 `max(1, 120-已用)` 后 abort，125ms 内才采纳 history（`src/ark/runtime.ts`）。查询循环是串行的：等 `preview()` 结束再睡 50ms。队列只会在「上一次同步段还没返回、下一次已经发出或已经 abort」时出现。

这次拷贝上的那一次失败对得上「单次同步段太长」，对不上「队列被放大」：

- `diag-mixed-0-31` 的入口延迟是 50ms。
- handler 91.184ms，其中一条 `all()` 82.121ms 墙钟、13.059ms 线程 CPU，语句哈希前缀 `e088d0955f78`，是 history 里那条带 `NULL AS client_json` 的证据查询。
- 50ms 入口加 91ms handler 超过 120ms 预算。客户端 abort 后服务器仍把这次调用跑完。

run01 的 146ms 样本是 HTTP 200：入口 43ms，handler 101.7ms，主导语句是 `sqlite_schema` 索引名查询，87.632ms 墙钟、10.391ms 线程 CPU。它发生在维护结束之后约 61ms，transport 仍成功，只是单轮 P99 过不了 100。

暖轮次里，墙钟约 35ms、线程 CPU 接近 0 的调用包括 `SELECT enabled,revision FROM ark_settings WHERE id=1` 的 prepare，以及 `SELECT sn FROM ark_grant`。这些语句没有 300k 行扫描。run04（100ms）和 run05（10ms）都有这种 25–40ms 的整段离 CPU。10ms 周期、50% 配额时，单次配额空隙最多约 5ms。一条应当是微秒级的语句出现 25ms 以上离 CPU，就不可能只是「差一个 10ms 周期的尾部」。剩余可能是：同 cgroup 的其他任务连续吃掉每个 5ms 时间片，本线程停在同步调用里跨过多个周期；或者锁/IO 睡眠。两种都表现为线程 CPU 低、墙钟高。周期实验没有在调用前后读 `throttled_usec`，所以这一步还分不开。

`busy_timeout=250`（`sqlite-policy.mjs`）长于 120ms 预算。锁等待算进墙钟，不算进 `threadCpuUsage`。上述慢语句的 `error` 都是 null，没有走到超时抛错，这不排除已经等过一段锁。

## threadCpuUsage 量的是什么，测量动了什么

`scripts/storage-sql-profile.ts` 在同步 `prepare/get/all/run/exec` 两侧调用 `process.threadCpuUsage()`。差值的 `user+system` 除以 1000 得到 `thread_cpu_ms`。Node 24 上这是当前线程的 `getrusage(RUSAGE_THREAD)`：只含线程真正在 CPU 上的用户态和内核态。

不计入：

- CFS 节流期间。线程可运行但没被放上 CPU。
- `busy_timeout` 里的可中断睡眠。
- 缺页或 IO 的不可中断等待。
- 同进程其他线程，以及同 cgroup 的客户端和 rollup。

所以 82ms 对 13ms 只说明这 69ms 该线程没在执行。它不标明是节流、锁还是 IO。

计时偏差：

- `threadCpuUsage` 在 `sha256` 之前取样，`wall_ms` 在对象字面量里、哈希之后才读 `performance.now()`。哈希和空白压缩算进墙钟，不算进线程 CPU。对 30–80ms 的缺口可以忽略；对亚毫秒语句会把离 CPU 比例夸大。
- 记录为 0 的 `thread_cpu_ms` 是差值为 0 微秒。不能把它读成亚毫秒调用「SQLite 没干活」。35ms 墙钟配 0 则是整段离 CPU。
- 请求级 `main_thread_cpu_during_request_ms` 包住整个 async 函数。函数在 `await` 上让出时，主线程去做的别的事也算进这个差。它不是这一次 SQL 的 CPU。语句级计时才是。
- profile 的 `appendFileSync` 在请求墙钟算完之后。诊断器 fetch 包装里对 `shared-reader.jsonl` 的 `appendFileSync` 仍在请求墙钟里面，不在单条语句里面。
- 诊断器每 500ms 在主线程同步读 cgroup 并追加 `resources.jsonl`。这点开销解释不了 35ms 的语句缺口，但它和 SQL 抢同一 0.5 CPU。
- 原 soak 的 `linuxResources` 不记 `cpu.stat` 的节流字段，也不记 pressure。只有诊断对照的 run03 控制行记下了 `cpu.max` 和 `cpu.stat`。

把同一 profiler 打开到完整混合上，只会在 ark-summary 的异步上下文里做哈希和 `threadCpuUsage`；没有这个上下文时 `prepare` 包装直接执行原调用。这仍然改变了被测路径。重跑延迟不能和未开 profile 的 29 次失败逐毫秒对比。

run03 的 `throttled_usec / nr_throttled` 约 6.85ms，大于 10ms 周期、50% 配额下单周期最多约 5ms 的空隙。这个比值是 cgroup 计数，不是某一条语句的停顿，不能从 82ms 里扣掉。

## 不把减 cache 或放慢后台当作下一步

生产监听在 `startAnalyticsServer` 里把前台连接设成 `query_only` 和 `cache_size=-8192`（8MiB），再 `shrink_memory`。`AnalyticsStore` 构造函数默认 `cache_size=-65536`（64MiB 页缓存预算，不是 RSS 上限）。`9e9b4819` 的 soak 接收端没有做这道生产设置；诊断器用环境变量保持 65536。当前树尖 `773c0f18` 只在 `storage-capacity-load.ts` 补了 8MiB 只读设置。周期实验走的是诊断器，仍是 64MiB。若完整混合重跑跑在 `773c0f18` 上，cache 就变成第二个因素，不能再和 `193bf990` 的失败比。

原峰值工作集 778940416 字节。即便 64MiB 预算全部驻留并且全部算在工作集里，改成 8MiB 最多去掉 56MiB，剩下约 720220160 字节，仍是限额的 89.4%。80% 门大约还要再去掉 72MiB 别的东西。拷贝上那条 82/13 发生时 cgroup 只有约 222MB 且 `max` 事件为 0，减 cache 对不上这一笔。

后台节奏同样不是这一步。soak 日程的维护间隔是 300000ms，冒烟才是 5s。贵的是 mutation 对不上时的 `buildDevice`，单日墙钟预算 30000ms，而且和查询挤在同一个 0.5 CPU 里。run02 这种重叠造出了 82ms 级语句和 1 次 transport 失败。run01 的 87ms schema 查询发生在 131ms 的缓存维护结束之后，说明当时没有重建子进程也留得下几十毫秒离 CPU。把间隔再拉长只是少测重叠，不解释暖轮次里那些 35ms 的空查询。

不加 CPU 额度。0.5 CPU、768MiB、120/125ms、P99 100、ACK 门保持。

## 最小可证伪的下一步

完整混合 profile 若已按 `9e9b4819` 启动，就等它的日志，不要并行再开周期、cache 或节奏实验。对每一个 transport 失败和每一个 handler 超过 50ms 的样本，只用现有字段配对：

- `entry_ms` = 服务器 `received_at_ms` − 客户端 `sent_at_ms`
- `handler_ms` = 服务器 `ms`
- `gap_ms` = 该请求里墙钟最大的那条语句的 `wall_ms - thread_cpu_ms`

三条互相排斥的结果：

1. `entry_ms>120` 且该请求自己的 `gap_ms<20`。失败发生在它自己的 SQL 之前。再看上一条 `done_at_ms` 是否晚于这一条 `sent_at_ms`。若是，上一节同步工作挡住了入口；再看上一节的 `gap_ms` 落在语句上还是落在语句之外。这才是主线程同步段造成的队列放大。
2. `entry_ms<30` 且 `gap_ms>50`。时间在同步调用内部。10ms 实验已经表明，把周期从 100ms 改到 10ms 去不掉这种量级。下一次只加一个因素：在墙钟超过 20ms 的语句外侧各读一次 `cpu.stat` 的 `throttled_usec` 和 `memory.events` 的 `max`。节流增量接近 `gap_ms` 且 `max` 增量是 0，才是 CFS；`max` 或内存 pressure 在动而节流不动，才是回收；两个都不动，才是 sqlite 睡眠（锁或 IO）。额度、cache、门都不变。
3. 客户端 `ms` 比 `entry_ms+handler_ms` 大出 30ms 以上。多出来的是客户端自己的 ArkStore，和服务器 SQL 无关。这种样本不能用来宣布 SQL 或周期的效果。run06 的 98ms 就是这种。

在这三条有结果之前，不改 `CPUQuotaPeriodSec`，不改 `cache_size`，不改维护间隔，不加 CPU。

## 证据与代码

- 原失败：`SHARED-CADENCE-INDEPENDENT-FAILURE.json`，sha256 `2edd879b61ab521e31cb20059a236d3e836e344a55c9b8897e9f9f35059e92bb`。工作集与 8530 来自同目录 `shared-cadence-evidence-193bf990/resources.jsonl`，sha256 `6716da992edf0470b8dfd25f07c6848c9a547ecbb75d9a22e13653a39dfee47e`，132 行，`max` 0→8530。
- 01 汇总：`SQL-DIAG-01-EVIDENCE.json`。02 中途 cgroup：`SQL-DIAG-02-OBSERVED.json`（`cpu.max` 为 `50000 100000`，当时 `ActiveState=active`）。02 收尾：`SQL-DIAG-02-FINAL.json`，仅 `mixed-0` 的 exit 为 1。
- 周期：`SQL-PERIOD-COMPARISON.json`、`SQL-PERIOD-COMPARISON-V2.json`、`SQL-PERIOD-INDEPENDENT.json`，以及上面的 tar。run03 的 `cpu.max` 只在 COMPARISON 的 `last_control` 里。
- 语句与请求配对从 tar 内各轮 `sql-query-profile.jsonl`、`shared-reader.jsonl`、`diag-*.jsonl` 重算。
- 代码均在 `9e9b4819`：`scripts/storage-sql-profile.ts`、`scripts/storage-query-diagnostic.ts`、`scripts/storage-shared-query-service.ts`、`src/ark/history.ts`、`src/ark/runtime.ts`、`src/analytics/index.ts`、`src/analytics/store.ts`、`src/analytics/rollup.ts`、`src/analytics/sqlite-policy.mjs`。相对 `9e9b4819`，后来的 `773c0f18` 只动了 soak 接收端的只读 cache 设置，本审查不把它当成已验证的修复。

署名：独立审查｜2026-11-18

方法上使用了 Scientific Agent Skills 的证据评估流程（先固定问题与对照，先抽数再判断，把设计混杂和测量偏差分开）。Kassis, T., Agarwal, V., He, Y., Patel, D., & Brueckner, A. M. (2026). Scientific Agent Skills. arXiv:2609.00065. https://doi.org/10.48550/arXiv.2609.00065
