# T4 固定候选复验 8bc4254e

署名：Grok 4.7。时间：2026-11-16。只读审计加隔离测试。未改业务源码，未部署，未装依赖，未改 360。

审计期间原工作树已前进到 `10b962665d3b89812fa8f12538dc3525a3926e09`。本报告只覆盖钉死的 `8bc4254ef6ae1d0a22c4a97db7ade9379668d1a2`。测试在 `/tmp/p003-t4-review-8bc` 的 detached worktree 上跑，Node 为 `/Users/fu-121/.local/node-v24/bin/node`，版本 `v24.19.0`。该目录没有名为 `node24.19` 的文件。

## 结论

容量口径和短事务形状与已采纳决定一致，默认准入仍是 14。`8bc4254e` 仍有两处阻断，不能收口，也不能写成生产通过。

1. 维护整轮没有时间上限。外层 `spawnSync` 超时是 240 秒，rollup 仍一次最多取 16 个脏日、每日扫描预算 30 秒，循环中途不停止，水位写在循环之后。慢扫描会先被杀掉，本轮 meta 写不进去。
2. `scripts/analytics-policy.test.ts` 仍锁定旧的 30 天合同。在 8bc 上第一步就是 `max_enabled_devices` 实际 0、期望 2。`test:analytics-control` 因此失败。这个 0 来自已采纳的 8GiB 全额预留，不应把公式改回去。

云端 317MB HTTP、NAS 44.87GB dbstat、以及 120 万 facts 夹具，本审计都没有跑。没有这些结果，不宣布成熟库或生产通过。生产部署仍是 T6。

## 基线

| 项 | 值 |
|---|---|
| 候选 | `8bc4254ef6ae1d0a22c4a97db7ade9379668d1a2` |
| 比较基线 | `c1008e4fda7c565a089a8fa4aaca46a94271ad86`（祖先关系成立） |
| 中间提交 | `b2c6602462d4df5afaee71940be695a2713b34c8` |
| 候选之外、未纳入本结论 | `10b962665d3b89812fa8f12538dc3525a3926e09`（整轮 180 秒预算，以及基准脚本改为先 prune 再 rollup） |

`c1008e4f..8bc4254e` 只动 11 个文件：`capacity.ts`、`rollup.ts`、`analytics-rollup.ts`、`storage-backup-job.py`、两份 T4 测试、维护测试、storage-policy 测试、admin 页面、UI 测试、`package.json` 的 `test:analytics-t4`。

## 已采纳口径在 8bc 上的实测

`daily=6000`、默认策略、空闲 1TiB 时，`capacityForecast` 给出：

| 窗口 | raw | facts | seen | 每台字节 |
|---|---:|---:|---:|---:|
| 30 | 14 | 30 | 30 | 2001120005 |
| 90 | 14 | 90 | 90 | 4820640005 |
| 180 | 14 | 90 | 180 | 6008640000 |

准入 `bytes_per_device` 是 180 天那一行。5 副本把预审里 4 副本的 30/90 天进位（末尾 4 字节）乘成末尾 5。180 天整除，`6008640000`。seen 日增量为 `13200000` 字节/台（`6000*400*1.1*5`）。`backup_peak_copies` 固定 5，`archive_enabled: true` 不改变副本数和每台字节。`reserve_bytes+wal_reserve_bytes=4831838208`。`ark_spool_reserve_bytes=8589934592`，不看归档开关。

默认 `validated_device_limit=14`，`maintenance_limit=100`，`max_enabled_devices=14`，`target_devices_fit=false`，限制因素是 `not_validated`。100 只出现在规划字段里。同一函数在 `daily=9000`、空闲 500GiB 时，`maintenance_limit=67`，准入仍是 14。

预审里那份空闲 `10641600512` 的样本，现在 `budget_bytes=0`、`max_enabled_devices=0`、`bytes_per_device=9012960005`。4.5GiB+8GiB 大于这份约 9.91GiB 的空闲。这是全额预留的直接结果。

`storage-backup-job.run` 的默认 `reserve_bytes` 是 `4831838208`。备份测试 7 项通过，但用例自己传入 `reserve_bytes=0`，默认值是本审计另查签名得到的。

SQLite 为 WAL。第二连接在事实扫描期间提交后，短写升级抛出 `errcode=517`（`SQLITE_BUSY_SNAPSHOT`）。`517 & 255 === 5`，失败原因记为 `concurrent_write`。该日 `rebuilt_days=0`，dirty 仍在，旧 `analytics_day.event_count` 仍是 1。没有新版本表。官方 `analytics-t4.test.ts` 同样通过这条路径，并在下一轮把计数补到 3。

`pruneAnalyticsCycle` 为 12 段、每段 500 行、每段最多 5 个 batch、5 秒、段间 10ms。7000 条过期 fact 第一轮删 6000 且 `budget_exhausted=true`，第二轮删完剩余 1000。`analytics_event_seen` 不变。维护 CLI 对 1001 条过期 raw 给出 `events=1001`、`batches=60`、`chunks=12`，失败触发器回滚当前短事务。

生产 Vue 页面在 `ASSET_DIR=/Users/fu-121/.local/state/p003-prnas-t4-20261116/ui-assets` 下 58 项通过，包含未来 180 天、事实 90 天、30/90/180 规划行和最多 5 份。

持续摄入若在本轮计数前又写入脏日，状态成为 `partial`，不把成功水位推进到这一轮。`docs/prnas-storage-50/t4/IMPLEMENTATION.md` 已把“上传间歇再收敛”写成选定行为。本审计不再按旧预审要求把它判失败。

## 阻断 1：整轮维护可以被 240 秒包装杀掉

`scripts/analytics-maintenance.mjs` 以 `timeout: 240000` 拉起 `scripts/analytics-rollup.ts`。8bc 的 `rollupDirtyDaysWithStatus` 没有 `maxRunMs`。它先取出最多 16 个脏日，再逐日扫描，每日默认 `maxDayMs=30000`，全部结束才写 `analytics_meta`。

16×30 秒 = 480 秒，大于 240 秒。prune 周期还在 rollup 之前，最多再占约 5 秒。超时后进程退出码非 0，包装脚本抛 `ROLLUP_FAILED` 并不改库。已经提交的短事务留着，本轮的 partial/complete 水位不写。上一轮若仍是 30 分钟内的 `complete`，准入会继续沿用旧水位。

本审计没有故意空等 240 秒去杀进程。阻断依据是上述常量和“水位在循环之后”的控制流。`10b96266` 给循环加了默认 180 秒、在日与日之间停止；该提交不在本候选内，本报告不把它算作 8bc 已修复，也没有跑它的测试。

## 阻断 2：analytics-policy 合同测试失败

命令与结果：

```text
cd /tmp/p003-t4-review-8bc/2-Projects/P003GameDemo20260513/apps/server
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/analytics-policy.test.ts
```

```text
AssertionError: Expected values to be strictly equal: 0 !== 2
at scripts/analytics-policy.test.ts:31
```

第 31 行仍是 `assert.equal(c.max_enabled_devices,2)`。同一文件后面还锁着 `horizon_days===30`、`bytes_per_device===2401344000`，以及大磁盘上 `max_enabled_devices===maintenance_limit`。8bc 上这份大磁盘样本的准入是 14，不是 67。测试在第一处断言就退出，后面几条没有执行到。

`storage-policy.test.ts` 通过，但它把 `validated_device_limit` 设成合成的 100，并允许 `target_devices_fit` 在 `max_enabled_devices>=100` 时为真。文件里写明这不是 100 台负载验证。默认画像不走这条路径。不能把这次通过读成 50 或 100 台已验证。

## 基准脚本

8bc 的 HTTP 模式是 50 次请求、每次间隔 100ms、控制文件 `0o600`、现有 `AnalyticsCheckpointer`、`cycles<1` 的单次 `pruneAnalyticsCycle`。这些与候选说明一致。

同一模式里，子进程先 `rollupDirtyDaysWithStatus` 再 `pruneAnalyticsCycle`。生产 `analytics-rollup.ts` 是先 prune 再 rollup。因此 8bc 这份基准即使跑完，也不能当作调度顺序下的持锁证据。本审计没有生成 120 万行夹具，也没有读云端或 NAS 的在途结果。

## 本审计跑过的命令

工作树：`git worktree add --detach /tmp/p003-t4-review-8bc 8bc4254ef6ae1d0a22c4a97db7ade9379668d1a2`。`PATH` 前置 `/Users/fu-121/.local/node-v24/bin`。服务器依赖使用原工作树 `node_modules` 的符号链接，没有安装。

| 命令 | 结果 |
|---|---|
| `node --import tsx scripts/analytics-t4.test.ts` | 通过。并发快照、12×500、永久 seen、180 天/5 副本/8GiB、准入 14 |
| `node --experimental-sqlite --import tsx scripts/analytics-maintenance.test.ts` | 通过 |
| `node --experimental-sqlite --import tsx scripts/analytics-prune.test.ts` | 通过 |
| `node --experimental-sqlite --import tsx scripts/storage-policy.test.ts` | 通过。合成画像 100，见上 |
| `node --experimental-sqlite --import tsx scripts/analytics-policy.test.ts` | 失败。`0 !== 2` |
| `node --experimental-sqlite --import tsx scripts/storage-http.test.ts` | 通过。夹具 HTTP，不是成熟库 |
| `node --experimental-sqlite --import tsx scripts/analytics-http.test.ts` | 通过。同上 |
| `node --experimental-sqlite --import tsx scripts/analytics-writer-http.test.ts` | 通过。同上 |
| `python3 scripts/storage-backup-job.test.py` | 7 项通过 |
| `ASSET_DIR=/Users/fu-121/.local/state/p003-prnas-t4-20261116/ui-assets node apps/web/scripts/test-analytics-admin-ui.cjs` | 58 项通过 |

## 留给 T5 和 T6

T5 仍包括：50 台混合负载、每小时 30 万或 60 万积压、语音 50 轮、ACK 分位门槛、连续稳定性。8bc 的 50 次 localhost 请求和单次维护周期都不是这些项。维护上限 100 和云端持锁仍待实测回执。

T6 仍包括：生产发布、替换 Analytics 备份 timer、证明旧 keep2 不再与新快照和新 ACK 包并存、然后才允许下调副本系数。本阶段不改设备开关、不改 23 点日批、不改 360。

## 未做

未登录主机。未跑 `analytics-t4-benchmark.ts` 的 prepare/http。未采信在途的云端 HTTP 或 NAS dbstat。未把 `10b96266` 当作候选复测。
