# History 冷查询：覆盖索引成立，秒级墙钟是页等待

审查 `history-cold-9e9-63de-20261118`，2026-11-18T04:04:55+0800。只读。未改业务源码，未 SSH，未重跑负载，未启动其它智能体，未购买，未部署，未动 360/373。

被测历史 SQL 来自 `9e9b481908c1f62f8c25c95209e68d398f1057a4`，与 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1`、`63de5fcf28fa7e5bb65cf3bae709b67d901679b9` 的 `history.ts` / `history-indexes.ts` 相同。落笔时工作树 HEAD 是 `7bf7fcfb7851ad0dbaa092a7a6dcfbc3ba1c5b7b`。交付前 HEAD 变为 `10d0dc5514671c85c9224d84eff224700172c2cc`，只在测试里记录 Ark `accept` 的 SQLite 错误码，`T5_DIAGNOSTIC_WAL_RECLAIM` 那几行未改。`3b09cde5`、`7bf7fcfb`、`10d0dc55` 都晚于被测运行，本审查没有产生这些提交。

## 结论

两条被 `INDEXED BY` 强制走覆盖索引的查询实际是覆盖读。SQLite 3.53.3 的计划是 `USING COVERING INDEX`，字节码各只有一次 `OpenRead`（`k(10,,,-,-,,,,,,)`），没有 `DeferredSeek`。证据查询有 14 次 `Function`，对应残留的 `json_extract` / `GLOB`。资产查询没有 `Function`。计划见 `HISTORY-SQL-EXPLAIN.json`。

两条都有隐式排序：`USE TEMP B-TREE FOR ORDER BY`，字节码有 `Sort`。索引序是 `(device_key, event_name, received_at_ms DESC, ...)`。证据 SQL 的 `ORDER BY received_at_ms` 跨 6 个 `event_name` 合并不满足索引序；资产 SQL 的 `ORDER BY occurred_at_ms, received_at_ms` 与索引的 received-then-occurred 不一致。这个排序落在线程 CPU 里。9e9 最慢证据 `all()` 墙钟 1485.047ms、线程 CPU 6.067ms；最慢资产 `all()` 939.694ms、CPU 3.138ms。同一次请求墙钟 2495.843ms、主线程 CPU 14.657ms，SQL 占请求墙钟 0.971965。本地 6 万行实验里只重排索引，证据页 398→394，VM 约 67900→63600，结果 SHA 不变。排序解释不了秒级墙钟。

没有扫描巨大 `properties_json`。目录 `eventCount` 57，整条事件上限 `maxEventBytes` 8192。63de 同哈希证据 `all()` 的最慢一次从存储层读了 208896 字节、93 次 `read`（`/proc/self/task/<pid>/io` 的 `read_bytes` 与 `syscr`），线程 CPU 4.056ms，墙钟 921.433ms。同请求的资产 `all()` 是 29.103ms、86016 字节、CPU 1.521ms。250 次证据 `all()` 的墙钟最小/p50/p95/最大是 0.018/23.711/60.931/921.433ms。p50 约 24ms，最大那次的 CPU 与 p50 同级。

秒级墙钟是这条线程在两次 `all()` 里离开 CPU。9e9 与 63de 的慢证据调用都落在一次尚未结束的 `PASSIVE` checkpoint 内，WAL 文件停在门槛下方，所以没有 `TRUNCATE`：

| 运行 | 证据 `all()` | 最近 health | checkpoint | WAL | 结果 |
| --- | --- | --- | --- | --- | --- |
| 9e9 `mixed-query-1794943114841-0` | 1794943114947 起，1485.047ms | 1794943114873，dt −74ms，`sql_busy` 0 | `running=true`，worker 2475047，attempt 1794943113267 | 242532072 / max 268435456 | 已完成轮 duration 4337.921ms，26582/26582，`reclaimed=false`，`busy=0` |
| 63de `mixed-query-1794944395216-0` | 1794944395908 起，921.433ms，约结束于 1794944396829 | 1794944395250 时 `running=true`；1794944400250 时已结束 | attempt 1794944393235，completed 1794944396951 | 全程 241209552 | 本轮 duration 3373.827ms，20349/20349，`reclaimed=false` |

63de 的证据 `all()` 整个落在这轮 3374ms 的 checkpoint 里面。checkpoint 在 1794944396951 结束，资产 `all()` 从 1794944396830 开始，只搭上尾部约 121ms，墙钟 29.103ms。`busy_timeout=250` 且语句 `error=null`、health `sql_busy=0`。一次 921ms 或 1485ms 的成功调用对不上单次 SQLite busy 超时。

进行中的 3b09 原 64MiB 对照还没有收尾。它已经给出栈：`mixed-query-1794945449461-1` 在 1794945450873 开始，请求墙钟 820.139ms、主线程 CPU 6.288ms。证据 v2 `all()` 165.985ms、CPU 0.740ms、`read_bytes` 20480、`read_calls` 14。未改的资产 v1 `all()` 649.907ms、CPU 2.007ms、`read_bytes` 77824、`read_calls` 39。1794945450972 到 1794945451674 的八次采样里，接收方主线程状态是 `D`，`wchan` 都是 `folio_wait_bit_common`。线程在等页锁或写回。

最小且可证伪的代码候选是 checkpointer 的回收门槛。下一轮单独打开已经提交、尚未被上述运行使用的测试钩子：`T5_DIAGNOSTIC_WAL_RECLAIM=64MiB`。它只把 checkpointer 的 `walMaxBytes` 设为 64MiB。writer 硬上限保持 `256*1024*1024`。前台缓存保持 64MiB，CPU 0.5，内存 768MiB，50×6000、maintenance、backup、Ark 连续负载都保持。等正在跑的 V2 原 64MiB 混合结束之后再跑，不与 8MiB 对照并行。

这个候选针对「WAL 停在约 241MB、checkpoint 写回数秒、历史线程在 folio 上等待」。它不保证工作集低于 0.8，也不保证 P99≤100ms。

## 索引实验已经量过的部分

`ORDER-INDEX-COMPARISON.json`（本地 SQLite 3.45.1，6 万行，4 设备）只改排序后，证据页几乎不变。`FILTERED-INDEX-COMPARISON.json` 把 GM 谓词放进 partial index 并把列收窄后，证据索引 398 页→67 页，VM 约 67900→2600，263 行结果 SHA `ca3585330fce8261a2f0d1a7bee2b89701d7dfc32f9893aee4c7ab05626d3302` 不变，暖查询 7.458ms→1.261ms。这是页数优化，单位是毫秒级 CPU。

`3b09cde5` 已把证据索引做成 `analytics_ark_evidence_cover_v2`，资产索引没动。进行中的 Linux 对照里，证据语句变小（约 166ms / 20KiB），请求仍然慢，因为资产语句以 2.007ms CPU 读 77824 字节却等了 649.907ms。再改证据索引，或把 `IN` 拆成六条语句，都碰不到这 650ms。资产 `ORDER BY` 若在 `LIMIT 513` 之前改成索引序，行数超过 513 时会换掉留下的行。本审查保持现有 `ORDER BY` 与 `LIMIT`。

`PASSIVE` 会保存进度。63de 这轮结束时帧数是 20349，文件大小仍是 241209552。`scripts/analytics-checkpoint.ts` 只在 `bytes>=max && busy===0 && log===checkpointed` 时 `TRUNCATE`。241209552 < 268435456，所以 `reclaimed` 保持 false，约 225MB 的 WAL 文件继续占着 cgroup 文件缓存。读者要的索引页在 `memory.max` 下等待写回，线程进入 `folio_wait_bit_common`。9e9 的 guard 没有 `io.pressure`。63de 含这次查询的 5013ms 桶（1794944393664→1794944398677）里，`io.pressure` full total +2752835µs，memory.max 事件 3946→3975。9e9 对应 5016ms 桶 memory.max 3400→3557，CPU full +584381µs，memory full +235353µs，`throttled_usec` +1057523µs。这些 PSI `full` 计数小于 9e9 请求约 2481ms 的 off-CPU 缺口。`full` 只统计所有任务同时停住的时间，单线程等页时会被少计。

## 内存构成

门是 `memory.max` 805306368（768MiB）、CPU `50000 100000`。工作集 = `(current − reclaimable) / limit`，`reclaimable = max(0, min(current, inactive_file) − dirty − writeback)`。80% 门对应 644245094 字节。

9e9 峰值在 1794943169884：current 805060608，inactive_file 28463104，dirty 23949312，writeback 0，reclaimable 4513792，工作集字节 800546816，比例 0.9940897623697916。距离 80% 还差 156301722 字节（149.1MiB）。`memory.max` 事件 0→7540，oom 0。193 的 resources.jsonl 本轮只重算了文件 SHA；上轮记录的工作集峰值是 0.9672597249348959。

9e9 慢查询所在 guard 样本 1794943119124 的进程 RssAnon：接收方 230172kB，查询客户端 43928kB，子进程 106204kB 与 26940kB，两个 esbuild 合计 7096kB。进程 RSS 合计 658988kB，其中 anon 414340kB、file 244648kB。63de 慢查询之后的 1794944398677：接收方 anon 222268kB，esbuild 三个合计 12696kB，进程 RSS 合计 699716kB。64MiB 页缓存若全部驻留，也只在接收方 anon 里面。把它改成 8MiB 最多让出 56MiB。去掉 esbuild 再让出约 7–12MiB。两者加起来仍小于 149MiB 缺口，而且更小的 pager 会让这次冷读更容易缺页。本审查不把减页缓存或删测试 Node 进程当作过门手段。8MiB 只保留为已排期的单独对照。

V2 进行中的只读 mincore（`V2-RESIDENCY-1794945371703.json`，PROT_NONE，不读页）把文件缓存拆开了：`analytics.db` 526147584 字节中驻留 150786048；WAL 225755432 字节中驻留 154189824。两者之和 304975872，cgroup `file` 是 307486720。`memory.current` 785121280，anon 453095424，inactive_file 149487616，dirty 49152。按同一公式，这一瞬间工作集是 0.7894，因为有约 149MB inactive file。这不是该运行的峰值；V2 摘要里的 MemoryPeak 已是 805429248。`pgscan_direct` 188480，`pgmajfault` 在该瞬间为 0。文件缓存几乎就是数据库加 WAL。

若这 154189824 字节 WAL 驻留离开 cgroup，anon 453095424 加数据库驻留 150786048 加 kernel 24465408 加 pagetables 10878976 仍约 639225856 字节，大约是 768MiB 的 79.4%。提前 `TRUNCATE` 对准的是 folio 等待和 WAL 文件缓存。工作集门仍可能贴在 0.8 附近。门保持 0.8。

## 最小代码点

已在 `7bf7fcfb` 的 `scripts/storage-capacity-load.ts`。环境变量精确等于 `64MiB`，并且 `T5_PROFILE_SQL=1`、preflight 为真时才生效：

```ts
const earlyReclaim=process.env.T5_DIAGNOSTIC_WAL_RECLAIM==='64MiB';
Object.assign(config,{checkpoint_reclaim_target_bytes:earlyReclaim?64*1024**2:256*1024**2,writer_wal_hard_limit_bytes:256*1024**2});
const checkpointer=new AnalyticsCheckpointer(path,{runExclusive:run=>writer.withCheckpoint(run),...(earlyReclaim?{walMaxBytes:64*1024**2}:{})});
```

`scripts/analytics-checkpoint.ts` 的判定保持原样：`PASSIVE` 之后，仅当 `bytes>=max && passive.busy===0 && passive.log===passive.checkpointed` 才 `wal_checkpoint(TRUNCATE)`。脚本自身 `busy_timeout=0`。writer 的 `withCheckpoint` 会挡住新的写入准入，历史读连接不在这把锁里。`ANALYTICS_WAL_MAX_BYTES`、`synchronous=FULL`、`wal_autocheckpoint=0`、10s/30s 调度、GM / owner / notBefore / null / `LIMIT 513` / rollup 预算都保持。

9e9、63de、进行中的 V2 都没有打开这个变量。WAL 才会停在 241–242MB。

## 可证伪预测

下一轮只加 `T5_DIAGNOSTIC_WAL_RECLAIM=64MiB`，其余与 63de 相同（64MiB 前台、0.5 CPU、768MiB、300k 混合）。

- 成立时：health 里至少一次 `last_result.reclaimed=true`，其后 `wal_bytes` 回到 64MiB 附近；证据与资产 `all()` 的最大墙钟都降到 100ms 以下，同时 `thread_read_bytes` 仍小于 1MiB；慢调用期间不再采到持续的 `folio_wait_bit_common`。
- 推翻时：WAL 已经小于等于 67108864 且 `reclaimed=true`，证据或资产 `all()` 仍有一次墙钟大于 500ms，并且 `read_bytes` 小于 1MiB。等待就不来自这块未截断的 WAL 文件。
- 另一条推翻：`all()` 出现 busy 错误，或该轮 `sql_busy` 升高。那是 `TRUNCATE` 的排他锁撞上了历史快照。门槛应停在这里。下一步是历史快照开着时不做 `TRUNCATE`，那是另一张补丁。
- `read_bytes` 大于 8MiB 而 CPU 仍只有数毫秒时，本审查「一次调用只读数十到二百 KiB」的描述不成立，要重新量访问的页。

进行中的 V2 已经说明证据 v2 缩小了证据语句，同时资产语句仍以 folio 等待撑到 649.907ms。V2 可以留下，作为更少证据页的索引。它不替代上面这一轮。

## 保持不动的门

10ms CPU 周期保持上轮结论。120/125/100ms、0.5 CPU、768MiB 都保持。maintenance 重叠保持。历史读仍以事件表为准。`wal_autocheckpoint` 保持 0。writer 的 256MiB 准入保持。查询客户端 HTTP 503 与入库 ACK 是两套计数：9e9 与 63de 都是 300000 条事件全部 ACK，`dirty_rows` 为 0。9e9 的 maintenance 另有 `remaining_dirty_days: 2`，那是 rollup 预算，不是入库脏行。

## 证据 SHA-256

| 文件 | SHA-256 | 字节 |
| --- | --- | --- |
| PROFILE-MIXED-INDEPENDENT.json | `fdf08baf6ac97a06408e77447979419f56c5e114d89d2de1118a18c5f3435f22` | 6576 |
| profile-cadence-evidence-9e9b4819/RESULT.json | `f00285ae3905611379408337025e2446ab8547d7a4797b6839969188ee3c8d96` | 243634 |
| profile-cadence-evidence-9e9b4819/FAILURE.json | `7f2d81efed3dda660037eb60a36d1e664152a5a27e1d217bdb734b694c4563cf` | 135 |
| profile-cadence-evidence-9e9b4819/sql-query-profile.jsonl | `2a308fe53bc559edd8368cbdf3d6e1029d13f771ebd04a3561e77e495d85ca07` | 1116545 |
| profile-cadence-evidence-9e9b4819/resources.jsonl | `a53ab91f24a34f36acbba95c7e9afce91513a78b76db0ee93a1ca0ce2d7454de` | 80090 |
| profile-cadence-evidence-9e9b4819/health.jsonl | `33fcfc5adb34b60713bd262a7c433f05a184d543d3f6a48ecbfea9dd98787798` | 162156 |
| profile-cadence-evidence-9e9b4819/control/profile-cadence-guard.jsonl | `1e739f3045c47ca94da689a4f8073fd7bb25366ca4544805b669432e1ff0962d` | 193481 |
| profile-cadence-evidence-9e9b4819/maintenance-1794943114841.stdout | `08b9ac24c848916e305798f17b143721d7eec7f321cd11f3f6ab68a4c4fcf2da` | 505 |
| IO-MIXED-INDEPENDENT.json | `9cba92ca1c5631c4669e0ebf4873f223b23ca515061421574be5edc0b7d49d8c` | 8132 |
| io-cadence-evidence-63de5fcf/sql-query-profile.jsonl | `102ffea8f349e967dcd212f8f3017f8cf019e2ab567a4adede8d08ddac4abcc5` | 1272457 |
| io-cadence-evidence-63de5fcf/health.jsonl | `ad0377f29c42fe6c2345cfbab8757a666750b7f3c9be3da9e54082a973cb19c0` | 164750 |
| io-cadence-evidence-63de5fcf/resources.jsonl | `aa8ded04bc8624ad5aa9aa263f778967e4909ccfb06e6f02d423ae8ee3ae3dfd` | 80721 |
| io-cadence-evidence-63de5fcf/control/io-cadence-guard.jsonl | `d776b170bec02fc9a5769bd9526242911e79a95f9b434d3b7c51e274aac5111b` | 235355 |
| HISTORY-SQL-EXPLAIN.json | `e3628290946207a730fe609f6e7fd89648e6207b1fb78c38a9f5c91c64c34370` | 43031 |
| ORDER-INDEX-COMPARISON.json | `6b081277ef58f1b77a8586807f8cde6d9e1aa7b32359b7475517d80af0347247` | 2589 |
| FILTERED-INDEX-COMPARISON.json | `cd312c16d9e5f94ba3979c8bc907d5d20436f36d8c2c43dc18c4e4ecfdda1370` | 1857 |
| V2-LATEST-SUMMARY.json | `9e5610dd9912f6d356f09ca3ce5ee89357e1b7bc60441b4465ae6da7f3fa458c` | 11150 |
| V2-WAIT-QUERY-CORRELATION.json | `7e62c95b219dbc0c6eb82dca45a8ce5a1ec312e710d19584dcad2eab82e22c3f` | 6485 |
| V2-RESIDENCY-1794945371703.json | `9fbb4f68d127b55acb811f9cdbc66ea363a20ca148896faf1c232df6ee07d260` | 1342 |
| review-sql-cpu/REVIEW.md | `731685172c4ee7704a3437fe4ef48e2c4d528192f8b48bd4867c7da9abdca627` | 15713 |
| shared-cadence-evidence-193bf990/resources.jsonl | `6716da992edf0470b8dfd25f07c6848c9a547ecbb75d9a22e13653a39dfee47e` | 81758 |

V2 三个文件是进行中快照。`V2-LATEST-SUMMARY.json` 的 `at_ms` 是 1794945505606，第三轮 17 次 history 失败，运行尚未结束。63de 最终是 `FAIL_COMPLETE_MIX`：300000 ACK，dirty 0，250 次查询里 21 次 history 失败，query P99 161.288ms，工作集峰值 0.9997100830078125。9e9 是 `FAIL_MIXED_QUERY_AND_MEMORY`：30 次 history 失败，工作集峰值 0.9940897623697916。
