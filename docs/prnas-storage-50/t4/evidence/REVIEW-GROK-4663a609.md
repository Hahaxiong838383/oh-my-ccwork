# T4 固定候选复验 4663a609

署名：Grok 4.7。时间：2026-11-16。只读审计。验证跑在 detached worktree，未改业务提交，未部署，未安装依赖。

审计开始时主工作树在 `4663a60996ca2a4f44631d36e16a36736a9a25f9`。审计过程中主工作树前进到 `d6b875db81d5f88a620db6fd13c0839fd1471d36`（`fix(p003): cap cold maintenance transactions and preserve upload latency`）。下面的命令全部跑在 `/tmp/p003-t4-review-4663`，`HEAD` 为 `4663a60996ca2a4f44631d36e16a36736a9a25f9`。`d6b875db` 不进入本结论。

Node：`/Users/fu-121/.local/node-v24/bin/node`，`v24.19.0`。`PATH` 前置该目录后 `npm` 为 `11.17.0`，与同一 Node 24 绑定。

## 结论

8bc 的两项阻断在 `4663a609` 上关闭。

1. 整轮 rollup 默认 `maxRunMs=180000`，日与日之间停止，单日仍最多 30 秒。外层包装仍是 240 秒。同一测试文件在 8bc 上失败（两个脏日都跑完），在 4663 上通过。
2. `analytics-policy.test.ts` 已改到 180 天、8GiB 全额预留、5 副本和精确空闲边界。本次退出码 0。`analytics-control-route.test.ts` 退出码 0。

这不等于成熟库维护通过，也不等于生产通过。`WIDE-CANDIDATE-3ed-RAW.json` 有完整 `result`，其中 50 次上传有 17 次 `503` / `ANALYTICS_STORAGE_UNAVAILABLE`，调度内的两个脏日维度都是 `budget_exceeded`。317MB、先 rollup 的云端结果不作为通过证据。验证档仍是 14，限制因素是 `not_validated`。

## 候选

| 项 | 值 |
|---|---|
| 候选 | `4663a60996ca2a4f44631d36e16a36736a9a25f9` |
| 说明 | `fix(p003): calibrate raw storage against measured mature indexes` |
| 父提交 | `3ed1e7715b1a4d9ce142e4423a7e55259c18432e` |
| 8bc | `8bc4254ef6ae1d0a22c4a97db7ade9379668d1a2`，是 4663 的祖先 |
| 中间提交 | `10b962665d3b89812fa8f12538dc3525a3926e09`、`6ab8b909c5e92f933b5c88d0c2d5409328846c29`、`3ed1e7715b1a4d9ce142e4423a7e55259c18432e` |

`8bc..4663` 只动 8 个文件：`capacity.ts`、`rollup.ts`、`package.json`、`analytics-t4.test.ts`、`analytics-t4-run-budget.test.ts`、`analytics-maintenance.test.ts`、`analytics-policy.test.ts`、`analytics-t4-benchmark.ts`。

`rollup.ts` 在 3ed 与 4663 上是同一 blob：`b84553a1e240f1ae11290b996ed4c3eb1dbd5e63`。4663 相对 3ed 的基准脚本只删了安静重试的 `quiet.partial===false` 断言。容量公式在 4663 才改成 2304。宽库证据覆盖的是这份 rollup/prune 代码，覆盖不到 2304 公式本身。

## 阻断 1：240 秒包装

`scripts/analytics-maintenance.mjs` 仍以 `timeout: 240000` 拉起 rollup。该文件 blob 与 8bc 相同：`17707b9a71583b999d49571bd30e0f1f9a9d3b53`。

4663 的 `rollupDirtyDaysWithStatus`：

- 默认 `budget.maxRunMs ?? 180_000`
- `runBudget > 180_000` 抛 `INVALID_ROLLUP_BUDGET`
- 每个脏日开始前若 `performance.now()-runStarted >= runBudget` 则 `break`
- 日预算默认 `maxDayMs=30_000`，上限也是 30 秒
- 循环结束后才写 `analytics_meta`（`last_rollup_status` 为 `partial` 或 `complete`）

因此闸门口径是：已过去的时间不超过 180 秒，再加上已经开始的那一个最多 30 秒的日。prune 在 rollup 之前，周期闸门 `maxMs=10000`。`180+30+10=220` 秒，低于 240 秒包装。单条 SQL 事务没有单独截止时间；闸门在日与日、段与段之间。

子进程 `scripts/analytics-rollup.ts` 先 `pruneAnalyticsCycle`，再 `rollupDirtyDaysWithStatus`。调用处不传 `maxRunMs`，走函数默认 180 秒。`partial` 只写入返回 JSON，子进程在没有抛错时退出码 0。包装脚本只在子进程状态非 0 时抛 `ROLLUP_FAILED`。partial 会把库内 `last_rollup_status` 写成 `partial`。`capacityReader` 要求状态为 `complete` 且 30 分钟内有成功水位，partial 之后 `maintenance_ok` 为假，准入降到 0，直到后来的一轮写成 `complete`。

直接调用结果：

| `maxRunMs` | 结果 |
|---|---|
| `180001` | `INVALID_ROLLUP_BUDGET`，没有碰到数据库 |
| `180000` | 通过预算校验，随后落到数据库调用 |
| 省略 | 通过预算校验，随后落到数据库调用 |

RED / GREEN 用的是同一文件 `scripts/analytics-t4-run-budget.test.ts`。它包住真实的 `SELECT * FROM analytics_rollup_fact` iterator，在 `iterate()` 上 `Atomics.wait(..., 10)`，再以 `maxRunMs:1` 跑两个脏日。

| 树 | 退出码 | 结果 |
|---|---:|---|
| `/tmp/p003-t4-review-8bc-red`（`8bc4254e`，当时还没有 `maxRunMs`） | 1 | `AssertionError: whole-run budget must stop before the next day`，`2 !== 1` |
| `/tmp/p003-t4-review-4663` | 0 | `PASS whole-run budget stops between atomic days, preserves remaining dirty and resumes` |

8bc 把两个日都跑完。4663 在第一个日之后停下，剩下 1 个脏日，第二次不注入等待时能补完并写成非 partial。本次没有空等 240 秒去杀进程。

## 阻断 2：analytics-policy / control

命令在 4663 worktree 的 `apps/server`：

```text
node --experimental-sqlite --import tsx scripts/analytics-policy.test.ts
node --experimental-sqlite --import tsx scripts/analytics-control-route.test.ts
```

退出码都是 0。

policy 输出：`analytics policy: PASS (CAS, atomic rollback, defaults, hard validation, 180-day conservative capacity, exact disk boundary and verified scale)`。

control 输出：`analytics control HTTP: PASS (auth, limit, stop while offline, revision, duplicate validation)`。

旧断言 `max_enabled_devices===2`、`horizon_days===30` 已不在文件里。小盘样本 `free_bytes=10641600512`、`daily_peak=8205` 现在锁定 `max_enabled_devices===0`、`horizon_days===180`、`bytes_per_device===9722592005`。`reserve+wal+8GiB+5*bytes` 的空闲差 1 字节时准入 4，刚好达到时准入 5。`free_bytes=500GiB` 时准入等于 `validated_device_limit`。本次直接调用同一函数，得到 `daily=9000`、`bytes=9722592005`、`max=0`、`maintenance_limit=67`、`budget_bytes=0`、`validated=14`。

`9722592005` 来自 `Math.ceil(9000*196416*1.1)*5`。`9000*196416*1.1` 的浮点值是 `1944518400.0000002`，`ceil` 进 1，再乘 5 得到末尾 5。测试锁的是这个浮点边界。

## 容量：2304 / 1024 / 400，准入仍是 14

`capacityForecast` 在 `daily_peak=6000`、空闲 1TiB、维护健康时，本次调用结果：

| 窗口 | raw 天 | fact 天 | seen 天 | 每台字节 |
|---:|---:|---:|---:|---:|
| 30 | 14 | 30 | 30 | 2474208005 |
| 90 | 14 | 90 | 90 | 5293728005 |
| 180 | 14 | 90 | 180 | 6481728000 |

180 天那一行是准入用的 `bytes_per_device`。`backup_peak_copies=5`。`archive_enabled:true` 不改变副本数，也不改变每台字节。`reserve_bytes=4294967296`（4GiB），`wal_reserve_bytes=536870912`（512MiB），合计 `4831838208`。`ark_spool_reserve_bytes=8589934592`（8GiB）。`seen_daily_growth_bytes_per_device=13200000`（`ceil(6000*400*1.1)*5`）。`validated_device_limit=14`，`maintenance_limit=100`，`max_enabled_devices=14`，`limiting_factors=["not_validated"]`，`model=20261116-v3-180d-migration-peak`。

`maintenance_limit=floor(60*100*288/2*0.7/6000)=floor(100.8)=100`。`60*100` 保持了原先 `12*500` 的每轮行数，所以 100 这个规划值没变。它仍是公式值。994MB 那一轮实际只删了 5200 行，见下。

相对 8bc 的 1280 口径，180 天每台字节从 `6008640000` 变为 `6481728000`。差额 `473088000=(2304-1280)*14*6000*1.1*5`。30/90 天各有浮点 `ceil` 造成的末尾 5；180 天整除，没有这 1 字节。

实测与常数：

| 量 | 实测字节/事件 | 常数 | 常数/实测 | 再乘公式 1.1 |
|---|---:|---:|---:|---:|
| raw+settlement，含索引 | 2093.8937295238097 | 2304 | 1.10034 | 1.21038 |
| 两个 fact 维度 | 961.8468408888889 | 1024 | 1.06462 | 1.17108 |
| seen | 373.9728402962963 | 400 | 1.06960 | 1.17656 |

1024 比实测高 6.46%，400 比实测高 6.96%。公式里的 `*1.1` 使这两项的规划值高于实测 17% 左右。2304 本身已经是实测的 1.10034 倍，公式再乘 1.1，raw 规划值比实测高约 21%。方向是多留空间。1TiB 样本上存储上限仍高于 14，准入停在验证档 14。

`scripts/analytics-t4.test.ts` 退出码 0，其中包含：`facts===6000`、`chunks===60`、`budget_exhausted===true`，第二轮再删剩余 1000；`backup_peak_copies===5`，`ark_spool_reserve_bytes===8GiB`，`validated_device_limit===14`，`max_enabled_devices===14`。`analytics-maintenance.test.ts` 退出码 0，其中 1001 条过期 raw 得到 `events===1001`、`batches===60`、`chunks===60`，文案已改为每事务 1 批。`analytics-prune.test.ts` 与 `storage-policy.test.ts` 退出码 0。

`storage-policy.test.ts` 第 27 行写明合成画像 `analytics_devices:100` 不是 100 台负载验证。默认 `readVerifiedProfile(null).analytics_devices` 为 14。同一测试在合成画像下要求 `max_enabled_devices===maintenance_limit`，并通过，因此该样本上的维护公式值至少为 100。

prune 形状在 `rollup.ts`：`PRUNE_CYCLE={maxChunks:60,chunk:100,batchChunk:1,maxMs:10000,pauseMs:10}`。每个事务最多 100 条 fact、100 条 raw，以及 1 个 batch。该 batch 的 settlement 按 `attempt_id` 整批删除。夹具里每个 batch 写 200 条 settlement，与上传合同 `max_events:200` 一致。60 段满额是 6000 行；段间 10ms；周期时间闸门 10 秒，检查发生在下一段开始之前。

## dbstat 独立核算

输入：`/Users/fu-121/.local/state/p003-prnas-t4-20261116/DBSTAT.json`，SHA-256 `c8feb75ef77dc62b020dde41af316370f9d1ed19da1189a5bcd34d30f2c5d7fe`。

`page_size=4096`，`page_count=10954924`，`10954924*4096=44871368704`。对象页数合计 `10954923`，再加未归属的 1 页：`10954923*4096+4096=44871368704`。

`aggregate=TRUE` 的 `pgsize` 在 5 个对象上相对 `pages*4096` 少了 `2^32` 的整数倍，本次核算丢弃 `bytes` 和 `payload_bytes`：

| 对象 | 报告 bytes 与 pages*4096 的差 |
|---|---:|
| `analytics_event` | `-1 * 2^32` |
| `analytics_event_seen` | `-1 * 2^32` |
| `sqlite_autoindex_analytics_event_seen_1` | `-1 * 2^32` |
| `analytics_rollup_fact` | `-4 * 2^32` |
| `sqlite_autoindex_analytics_rollup_fact_1` | `-2 * 2^32` |

按 4663 `store.ts` 的索引归属，用 `pages*4096` 求和：

| 组 | 组成 | 字节 | 除数 | 每事件 |
|---|---|---:|---:|---:|
| raw+settlement | `analytics_event` 及其 6 个索引，加 `analytics_settlement` 及其 2 个索引 | 8794353664 | 4200000 条 raw | 2093.8937295238097 |
| facts | `analytics_rollup_fact` + `sqlite_autoindex_analytics_rollup_fact_1` | 25969864704 | 27000000（54000000 行 / 2 个维度） | 961.8468408888889 |
| seen | `analytics_event_seen` + 其主键索引 | 10097266688 | 27000000 | 373.9728402962963 |

这三项与 `MATURE-CALIBRATION.json`（SHA-256 `bdaddd0062d65e797db1f3deb281ba0a5a2ff571fc5d04212fa8f1ce2fa73efe`）里的分组和 `bytes_per_event` 一致。event 表含索引 `7474315264`，settlement 含索引 `1320038400`。90 天外推等于文件总字节 `44871368704`。180 天外推 `54968635392` 等于 raw 全额 + fact 全额 + seen 按 54000000 行扩展 + 其余对象 `9883648`。

## 994MB 正式顺序

证据文件：

| 文件 | SHA-256 | 用法 |
|---|---|---|
| `WIDE-PAIR-RAW.json` | `a41eab18c1932e174f6080abcf9ba0017fe42c574e77eb798bd528512b86a51a` | 基线已结束；候选单元 `p003-t4-http-3ed1e771` 当时仍 `active`，log 为空 |
| `WIDE-CANDIDATE-3ed-RAW.json` | `eb86d50a153e091ccb0747ac4c29e72b546049d521684296000187a2766c36f6` | 候选结束记录，顶层 `exit=0`，内层 `result` 存在 |

候选文件的 `unit` 字段被写成了 systemd 状态串。结果主体可以和 pair 里的 `p003-t4-http-3ed1e771` 对上：prune 是 52 批、5200 行，写阶段样本 `2.495ms`，与基线的约 30 秒写样本、`max_transaction_ms=12258` 不同。本次没有把 pair 里的空 log 当成通过，也没有使用 317MB 历史结果。

候选 `result`：

- 数据库 `994037760` 字节。结束时 `facts=1194866`、`raw=294833`、`seen=300033`、`settlements=289633`。
- 与夹具初值对齐：`1200000-5200+33*2=1194866`，`300000-5200+33=294833`，`300000+33=300033`，`300000-52*200+33=289633`。33 是被接受的上传。这证实运行中的夹具是 120 万 facts、30 万 raw/seen/settlement，prune 为每段 100 行、每段 1 个 batch、每个 batch 200 条 settlement。
- 4663 夹具源码：device/id/seen digest 为 64 个字符，session 为 `'s'.repeat(32)`，semantic 为 `duration_ms=60000` 的合成 JSON。两个维度 `occurred`/`received`，另有一个过期日。prepare 声明 `facts:1200000,raw:300000,seen:300000,settlements:300000`。
- 维护：`prune` 在前，`elapsed_ms=11213.948399`，`facts=events=5200`，`batches=52`，`max_transaction_ms=3121.077606`，`p95_transaction_ms=423.32`。10 秒闸门在段间检查，最后一段把周期拖过 10 秒。随后 rollup `60052.235ms`，`attempted_days=2`，`rebuilt_days=0`，`occurred` 与 `received` 的 `2026-11-16` 都是 `budget_exceeded`，`partial=true`，`remaining_dirty_days=2`。总耗时 `71272ms`，进程正常结束。
- 上传：50 次，间隔 100ms，接受 33，`200` 为 33，`503` 为 17，错误只有 `ANALYTICS_STORAGE_UNAVAILABLE`。p95 `309.14ms`，p99/max `511.31ms`。
- 安静重试：`rebuilt_days=2`，`partial=false`。上传停止后，默认 30 秒日预算能把这两维补完。
- checkpoint：`busy=0`，`failures=0`，`stale=false`。RSS `230690816`。

基线 pair 的接受数是 9/50、503 为 41。候选把长写从约 30 秒降到 2.5 毫秒样本，接受数升到 33。17 次 503 仍在。

调度进程写完 partial 后，`last_rollup_status` 变为 `partial`。在生产读取路径上，这会让 `maintenance_ok` 为假，直到下一轮无争用时写成 `complete`。安静重试只存在于基准脚本的父进程里，不在 `analytics-rollup.ts` 这一次调度里。

## 本次在 4663 上执行的命令

工作目录：`/tmp/p003-t4-review-4663/2-Projects/P003GameDemo20260513/apps/server`。`node_modules` 符号链接到原工作树，没有安装。

| 命令 | 退出码 | 末行 |
|---|---:|---|
| `node --experimental-sqlite --import tsx scripts/analytics-policy.test.ts` | 0 | policy PASS，180 天与精确边界 |
| `node --experimental-sqlite --import tsx scripts/analytics-control-route.test.ts` | 0 | control HTTP PASS |
| `node --import tsx scripts/analytics-t4.test.ts` | 0 | 并发、60×100、5 副本、8GiB、准入 14 |
| `node --import tsx scripts/analytics-t4-run-budget.test.ts` | 0 | 整轮预算在日与日之间停下 |
| `node --experimental-sqlite --import tsx scripts/analytics-maintenance.test.ts` | 0 | maintenance PASS，含 60 chunk / 1 batch |
| `node --experimental-sqlite --import tsx scripts/analytics-prune.test.ts` | 0 | prune PASS |
| `node --experimental-sqlite --import tsx scripts/storage-policy.test.ts` | 0 | storage policy PASS；合成 100 不是负载验证 |

8bc RED：同一 run-budget 文件，退出码 1，`2 !== 1`。

## 沿用的相同 blob

这些路径在 `8bc4254e` 与 `4663a609` 上 blob 相同。8bc 报告里的执行结果只说明当时这些源文件的行为；本次没有重跑 UI 和备份测试。

| 路径 | blob |
|---|---|
| `apps/server/scripts/analytics-maintenance.mjs` | `17707b9a71583b999d49571bd30e0f1f9a9d3b53` |
| `apps/server/scripts/storage-backup-job.py` | `7001c28fe68fd3d61f3ee1b3d4e328e06d7f6768` |
| `apps/server/scripts/storage-backup-job.test.py` | `2a06a3f865bb7eb871b7ae5f9bbf07a1173cd77b` |
| `apps/web/scripts/test-analytics-admin-ui.cjs` | `a31ebd8ce13d652588e4fafc436f51a63ddb4b02` |

`storage-policy.test.ts` blob 也与 8bc 相同（`17311b356615740467eaa701fee5e0d812456f6d`），但本次已在 4663 上重跑，因为它调用了已改过的 `capacityForecast`。`analytics-prune.test.ts` blob 相同，本次同样重跑并通过。

## 仍在的缺陷

994MB、先 prune 再 rollup、50 次并发上传这一轮：

1. 17/50 返回 `503`，`error_code=ANALYTICS_STORAGE_UNAVAILABLE`。接受 33。HTTP 记录里没有 SQLite errcode。
2. 调度内的 `occurred` / `received` 两维都在约 60.05 秒时 `budget_exceeded`，`rebuilt_days=0`，`partial=true`。安静重试在上传结束后补完。生产那一次 `analytics-rollup.ts` 调用不包含这次安静重试。
3. prune 周期 `elapsed_ms=11213.95`，超过 10 秒闸门；最长事务 `3121.08ms`。闸门不切断已经开始的事务。

`maintenance_limit=100` 假定每 5 分钟做完 60×100 行。这一轮在 11.2 秒里做了 52×100 行，随后 rollup 用约 60 秒失败。100 仍只是公式，不是这只夹具的实测吞吐。

## 未做

未登录主机，未重跑 994MB prepare/http，未把 `d6b875db` 当候选，未使用 317MB 历史结果，未改设备开关、日批或 360，未部署。生产发布、旧 keep2 退役、50 台混合负载仍不在本结论里。
