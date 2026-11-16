# T4 窄范围复验 d6b875db

结论：**PASS_ISOLATED**。阻断：**无**。这是隔离云测与该差分的关键回归，**依然不是生产放量**，也不是 T5 的 50 台 / 24h。

审计范围只有 `4663a60996ca2a4f44631d36e16a36736a9a25f9..d6b875db81d5f88a620db6fd13c0839fd1471d36` 和 `FINAL-10ROW-RAW-POLL2.json`。HEAD 就是 `d6b875db81d5f88a620db6fd13c0839fd1471d36`，工作区对应源文件干净。未改代码，未改生产。未用此前 100 行失败或旧 8bc 结果充当这一次。

## 差分

中间只有一个提交：`fix(p003): cap cold maintenance transactions and preserve upload latency`。四个文件：

- `apps/server/src/analytics/rollup.ts`
- `apps/server/scripts/analytics-t4.test.ts`
- `apps/server/scripts/analytics-maintenance.test.ts`
- `apps/server/scripts/analytics-t4-benchmark.ts`

`capacity.ts` 与 `storage/policy.ts` 在这段范围内 diff 为空。HEAD 上容量常量仍是 raw 2304B、两维 fact 1024B、seen 400B、过渡期 5 份、180 天窗口、raw 保留 14 天，模型名 `20261116-v3-180d-migration-peak`。

`PRUNE_CYCLE` 现为 `{maxChunks:300, chunk:10, batchChunk:1, maxMs:30000, pauseMs:10}`。rollup 默认 `maxRunMs` 与上限都是 150000；单日 `maxDayMs` 默认与上限都是 30000。父进程仍是 `analytics-maintenance.mjs` 里未改动的 `spawnSync(..., {timeout:240000})`。生产 rollup 脚本不传入 `maxRunMs`，因此走 150 秒默认值。

210 秒是三段配置相加：TTL 周期 30 秒 + 整轮 150 秒 + 末日单日 30 秒。150+30+30=210，低于 240 秒父 deadline。停止点在段与段、日与日之间，飞行中的那一段可以越过名义边界；父超时仍会在 240 秒杀掉子进程。这次云测整段维护用了 40302.64 ms，远低于该和。

`capacity.ts` 文本没变，但 `maintenance_limit` 按 `PRUNE_CYCLE` 计算。日事件下限 6000 时，旧式 `floor(60*100*288/2*0.7/6000)=100`，新式 `floor(300*10*288/2*0.7/6000)=50`（精确值 50.4）。验证档默认仍是 `analytics_devices:14`。`analytics-t4.test.ts` 在 `daily_peak:6000` 样本上断言 `validated_device_limit===14`、`maintenance_limit>=50`、`max_enabled_devices===14`，这次测试通过。预算上限从 100 收到 50，绑定准入仍是 14。按本次复验口径，这是隔离预算收紧，不记为阻断。

测试同步为：每轮 fact 3000、chunks 300、旧 fact 余 4000，再一轮 3000，最后一轮 1000；maintenance 断言 batches 300、剩余 batch 701。benchmark 增加 `T4_RUN_ID`（默认 `first`，`^[a-z0-9-]{1,40}$`）、拒绝覆盖已有 `RESULT-<runId>.json`，并记录四表 `before`。事件 id 带 run id。

## 云端 FINAL-10ROW-RAW-POLL2.json

外层 `exit=0`，`stderr` 为空。`stdout` 再解析后有 `unit`、`log`、`result`；`log` 再解析与 `result` 全等。`synthetic=true`，`run_id=final-10row`，`host=linux`，`node=v24.19.0`。

| 项 | 结果 |
| --- | --- |
| HTTP | 50/50 accepted，`codes.200=50`，`errors={}` |
| p95 / p99 / max | 253.0589179999988 / 408.7477199999994 / 同 p99 ms |
| TTL | facts 3000、events 3000、batches 300、1 cycle、7424.408 ms |
| 事务 p95 / max | 21.614649 / 221.191486 ms |
| rollup | 2/2 完成，`failed_days=[]`，dirty 0，`partial=false`，32836.052 ms |
| 写耗时 | 10.55932、6.86553、1.46696 ms，最大 10.55932 ms |
| 事后 quiet | attempted 0，dirty 0，`partial=false` |
| 库 / RSS | 994037760 字节（994.038 MB）、RSS 231976960 字节 |

`before` → `rows` 的整数差额：

- seen：300083−300033 = **+50**
- facts：1191966−1194866 = **−2900** = +100−3000
- raw：291883−294833 = **−2950** = +50−3000
- settlement：229683−289633 = **−59950** = +50−60000

四条恒等式都成立。prune 对象没有单独的 settlement 删除计数；60000 来自「50 次接受 + 行差额」，与 300 批 × 每批 200 条结算一致。`before.facts` 是 1194866，说明这是已经承受过宽字段压力的库，本轮差额仍精确。

50 个样本的原始延迟不在文件里，p95/p99 是产物里已算好的值。按 benchmark 的 `floor(n*0.95)` / `floor(n*0.99)`，n=50 时 p99 下标是最后一项，所以 p99 等于 max。

`unit` 为 `ExecMainStatus=0`、`ActiveState=inactive`，`MemoryCurrent` 与 `CPUUsageNSec` 都是 `[not set]`。该文件没有测到 0.5 CPU / 768MiB 的 cgroup 配额；进程 RSS 为 221 MiB。所述包络按任务说明记录，本文件不能单独证明它。

## 本次测试

Node `v24.19.0`，PATH 前置 `/Users/fu-121/.local/node-v24/bin`。目录是 `apps/server`。

- `npm run test:analytics-t4` → exit 0。四行 PASS：并发写入与脏日、多段 TTL 与永久去重、30/90/180 与 5 份副本及验证档 14、整轮预算在日边界停下并保留剩余脏日。
- `node --experimental-sqlite --import tsx scripts/analytics-maintenance.test.ts` → exit 0。PASS：隔离预算失败、健康日继续、部分/致命 rollup 下 TTL 独立、水位诚实。

`test:analytics-t4` 自带 `analytics-t4-run-budget.test.ts`，这次跑过并且通过。它证明的是 `maxRunMs:1` 时在日与日之间停下。150000 这个新上限写在 `rollup.ts`，该测试没有把 150001 钉成必须抛错。Grok366 的 DEFERRED 快照、脏日、UI、备份，以及 Grok367 对 4663 两处旧阻断的单独复验，这次没有重做。

## 未做

整仓回归、UI、备份、生产查询、50 台 24 小时。更保守的维护计划上限不自动记成业务回归。
