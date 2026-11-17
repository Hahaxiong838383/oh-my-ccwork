# 候选 b1ce23ae 维护写锁重试隔离审查

审查身份：Grok（xAI）。只审 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1` 相对 `2620f3746f9b275a45eb0d8172adefb056c482aa` 的维护写锁重试和真实双进程测试。主树、生产、SSH、设备和 3306 都没有被本审查改动或占用。

## 结论

**PASS_ISOLATED**

在这份固定归档、Node v24.19.0 上，页循环和最终发布事务会在同一次日预算内对 SQLite BUSY/LOCKED 做短退避，并从最后一次已提交的 stage 重新读、算、写。已提交页的游标保持 512，公开计数没有把该页再加一次。失败的 COMMIT 回滚后，distinct 没有重复相加。普通存储错误和逻辑 CAS 冲突各只尝试一次。永久忙在约 1.16 秒时以 `budget_exceeded` 退出，公开摘要保持原样。HTTP 摄入在外部写锁仍被持有时返回 `ANALYTICS_STORAGE_UNAVAILABLE`，没有等到持锁结束。

这是隔离归档上的行为结论。本轮没有云端操作，没有新鲜 600k，没有长稳或生产放行。

## 身份

| 项 | 值 |
| --- | --- |
| 候选 | `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1` |
| 说明 | Rayman Chen，2026-11-17 23:25:27 +0800，`fix(p003): resume maintenance after transient writer contention within existing budget` |
| 父提交 | `2620f3746f9b275a45eb0d8172adefb056c482aa` |
| 取归档时 HEAD | 同一候选。`logs/identity.log` 当时工作树干净 |
| 审查结束时 HEAD | 仍是该候选。工作树随后出现其他会话的文档改动，本审查没有读、没有改 |
| Node | `/Users/fu-121/.local/node-v24/bin/node` v24.19.0。`PATH` 首项是该目录 |
| 归档 | `/Users/fu-121/.local/state/p003-t5-convergence-20261117/review-contention/archive` |
| 服务端差异 | 相对 262，`apps/server` 只有 `src/analytics/rollup.ts`、`scripts/analytics-rollup-contention.test.ts`、`package.json` 的 `test:analytics` 入口 |
| `rollup.ts` git blob | `17b54bd2e7f5c7d5be9d495bd453f02db20a978b`，与候选一致 |
| 官方测试 git blob | `a39dfea17082dc9ffe3e190b6d625c42209832e1`，与候选一致 |
| `rollup.ts` 内容 SHA256 | `96eb0e9787265f2e117c0ed7e46c8c241051660ec00b353972895a0b13e9683e` |
| Ark 示例 | 归档内 `docs/ark-brain-20261031/snapshot-v1.example.json`，内容 SHA256 `8b6df8ded6b26098a4bd373b61df2abe83402759e82d0feeeea9c3cadf964417` |
| 依赖 | 归档 `node_modules` 指向本工作树现有 `apps/server/node_modules`，后者再指向既有的 `p003-brain-search-tools-20261021` 依赖目录 |

未改动的源码 blob 也与候选一致：`store.ts` `e6a7d8bcbfe3e9e808f7310481ee7c084af081bc`，`ingest.ts` `de173731eb1a0610252b7be201333df5488e2e62`，`sqlite-policy.mjs` `aca73594312fd85229a3662e2b0aa733567e3d4e`，`scripts/analytics-rollup.ts` `4710f91b4a5695e0e14fca1f9bf2b327e8820305`。`busy_timeout=250`、`synchronous=FULL`、日预算默认 `30_000`、运行预算 `150_000` 仍在这些未改文件和 `rollup.ts` 的原校验里。

## 增量在做什么

`rollup.ts` 增加 `isBusy`、`waitForWriter`、`retryWriter`。`rebuildDay` 的页循环把读快照和页写入包在同一个 `try` 里。BUSY/LOCKED 时调用既有日预算检查，`Atomics.wait` 10 毫秒，再检查一次，然后重新从数据库读取 stage。失败 COMMIT 留下的内存 distinct 计数随这次 `computed` 丢弃。`store.transaction` 先 `ROLLBACK` 再抛错。最终发布事务只通过 `retryWriter` 重试。返回 `false` 的版本 CAS 不进入 `catch`。预算异常和其他错误由 `waitForWriter` 原样抛出。

`Atomics.wait` 在归档的 `rollup.ts` 里只出现一次。`index.ts`、`ingest.ts`、`writer.ts` 没有 `rollupDirtyDays`、`waitForWriter` 或 `Atomics.wait`。HTTP 进程会因容量常量加载 `rollup.ts`，请求路径调用的是 `settleAnalyticsBatch`。

## 已跑证据

工作目录是归档的 `apps/server`。临时库在审查目录的 `tmp`。两条测试日志的 `EXIT` 都是 0。

| 日志 | 命令 | exit | bytes | SHA256 | UTC |
| --- | --- | --- | --- | --- | --- |
| `logs/identity.log` | `/Users/fu-121/.local/node-v24/bin/node -v`，以及对该候选的 `git rev-parse` / `git status --porcelain` / `git hash-object` | 快照，无 EXIT | 672 | `354096f170beec766186a915e9550ff9c322851afae8b6418fbbd1a7f76d4e5d` | 15:45:01Z / 15:45:02Z |
| `logs/contention-official.log` | `/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/analytics-rollup-contention.test.ts` | 0 | 612 | `c370e4ecbf3eeffb8ce1a4729826820e4ef6f05e6cdad3a8111d7e17799ea15a` | 15:45:02Z / 15:45:06Z |
| `logs/contention-boundary.log` | `/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx /Users/fu-121/.local/state/p003-t5-convergence-20261117/review-contention/grok-contention-boundary.test.ts` | 0 | 5362 | `28bc56c816f2fcb37c79cd1e67a22661cf596c128b0b9a20f8b4e02e0fe9cc57` | 15:54:08Z / 15:54:17Z |

官方三条都通过：真实第二进程持写锁后，分页进度在原日预算内完成；COMMIT 忙回滚后 distinct 不双计；永久忙在现有日截止前停止，公开摘要不变。

独立探针 `grok-contention-boundary.test.ts` 内容 SHA256 `666a12227d9f34f632602fa0024cb9a5064c945176f586f5282128bde28342da`。它只存在于审查目录。

- 600 行、512 页。第二次写 COMMIT 注入一次 errcode 5。扫描游标是 `[0,512,512]`，0 只出现一次。公开 `event_count` 600、`sessions` 1、`unique_reward_instances` 1。stage `folded_rowid` 600、facts 600。digest `r1` 一行。
- 读路径 errcode 1：1 次尝试，2.075 毫秒，`storage_unavailable`，没有公开日。写 COMMIT errcode 1：1.513 毫秒，stage 仍为空。第二次 COMMIT 是失败日之后原有的 meta 记录，不是页重试。
- 写事务里把 stage 的 `folded_rowid` 读成 `-999`：stage 只读 2 次，2.260 毫秒，`concurrent_write`。公开和 stage 都停在 30。
- 事实查询持续 errcode 5，日预算 1000 毫秒：6 次尝试，1162.294 毫秒，`budget_exceeded`，`remaining_dirty_days` 1，没有公开日。
- 600 行已发布后追加 `r2`，只让发布 COMMIT 持续忙。stage 只写 1 次，发布尝试 6 次，1193.869 毫秒，`budget_exceeded`。公开保持 600 和 1 个 reward。stage 已是 601 行、2 个 reward。去掉注入后再跑，stage 写入 0 次，公开变为 601 和 2 个 reward。`r1`、`r2`、session `same` 各一行。
- 子进程持 `BEGIN IMMEDIATE` 12 秒。同一条已设置 `busy_timeout=250` 的连接上，`BEGIN IMMEDIATE` 的 errcode 是 5，耗时 2258.363 毫秒。紧接着 `settleAnalyticsBatch` 抛出 `ANALYTICS_STORAGE_UNAVAILABLE`，`busy` 为 true，耗时 2315.065 毫秒。此时 `released` 仍是 false，`analytics_event` 为 0。

## 记录在案、未升为缺陷

- 这台 Mac 上，名义 10 毫秒的 `Atomics.wait` 在 1162 毫秒预算窗口里只完成 6 次。等待仍被日截止切断。生产日预算仍是 30 秒。
- 同一台机器上，pragma `busy_timeout=250` 的一次 `BEGIN IMMEDIATE` 实际返回用了约 2.26 秒，错误码仍是 5，并且发生在持锁进程释放之前。摄入路径没有改。这个拉长属于本机休眠粒度，不能写成云主机的 250 毫秒测量。
- `store.transaction` 仍只把精确 errcode 5 和 6 标成 busy。写事务里的扩展 BUSY 码会变成 `busy:false`，新循环不会重试它。本轮真实跨进程锁返回的是 5。没有制造 517。
- 设备键的第一次 `readSnapshot`，以及整天结果出来之后的 meta 事务，不在新的重试范围内。

## 未验界限

- 没有打开保全库，没有启动或采集云端任务。新鲜 600k、dirty 0、混合负载和 24 小时都不在本结论里。
- 没有跑 `analytics-recovery.test.ts`，没有占用 3306。
- 没有重跑完整 analytics、T4 或 tsc。那些是主 13 已声明的回归，不是本轮独立日志。
