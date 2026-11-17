# 262 相对 85 的增量验收

审查身份：Grok 4.7（xAI）。这不是 Codex，也不是主13。
候选 `2620f3746f9b275a45eb0d8172adefb056c482aa`。对照 `85cbf6720932e1d65ab0011714e2475f0b66e1e0`。
日期 2026-11-17。Node `/Users/fu-121/.local/node-v24/bin/node` v24.19.0，SQLite 3.53.3。`PATH` 把该目录放在最前。没有使用 Node 26，也没有使用 `/usr/local/bin/node`（v22.14.0）。
范围：只验收这一对提交的服务端增量。没有改主树、生产、设备、共享记忆或依赖，没有 SSH，没有云端压测。产品实现保持原样。没有新的 `FINDING.md`。

## 结论

所要求的五项增量：**PASS**。

这不是完整 T5，也不是已部署。成熟 90 天净清理、50 身份矩阵、语音 AB、1 小时断线、24 小时和最终 NAS 还原都没有在这次跑。

会话 399 的固定报告还没有作为事实引用。`review-candidate/FINDING.md` 只提供了要复现的场景。下面 85 上的 4 写成 2，是这次在冻结归档上重新跑出来的。

## 固定物

| 项 | 值 |
| --- | --- |
| 候选 | `2620f3746f9b275a45eb0d8172adefb056c482aa` |
| 对照 | `85cbf6720932e1d65ab0011714e2475f0b66e1e0` |
| `git archive` | `review-pages/262-server-and-snapshot.tar.gz` |
| 归档 SHA-256 | `a5faeb28c63529ad88da26613e403e6e60b7cf9fbd6d56fc05af52a9f76e7db1`（2970866 字节） |
| 归档内容 | `2-Projects/P003GameDemo20260513/apps/server` 与 `docs/ark-brain-20261031/snapshot-v1.example.json` |
| snapshot SHA-256 | `8b6df8ded6b26098a4bd373b61df2abe83402759e82d0feeeea9c3cadf964417`（695 字节） |
| `node_modules` | 符号链接到本工作树的 `apps/server/node_modules`，解析到既有的 brain-search-tools 安装。没有安装或改写依赖 |
| 自写测试 | `grok-262-independent.test.ts`，SHA-256 `ccbbea5212a7d5c8b6b10ca5f2f91321ba2b76d3c27bc13ac8671bd04d68b84b` |
| 输入场景 | `review-candidate/FINDING.md`，SHA-256 `ea92a2904b7eb8d90d9c44d68d1c3610d7c55a877bbd6ea62f63fbcc2ec1a5c0` |

3306 在独立套件前后、官方测试前后都没有监听。这次跑的测试都不绑定 3306。

审查期间工作树 HEAD 从候选前进到 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1`（2026-11-17 23:25 +0800，writer contention）。那一笔不在本次验收内。归档按候选 SHA 取出，`rollup.ts` 的 git blob 是 `08fb26c473d69960f5d97c2240066ebf7e6e8300`。当前 HEAD 上同一路径已是另一个 blob。本审查没有改工作树。

## 1. 过期日分块清理 — PASS

探针用真正的 `pruneAnalytics(store, now, 2)`。先在该日仍有效时发布 4 条会话，再把时钟放到 180 天后。8 个更早的 `occurred` 脏日和公开行吃掉 chunk=2 的对应预算。事实表没有 occurred 行，所以同一 chunk 删掉 received 事实的一半，删除触发器把该日重新标脏。随后调用 `rollupDirtyDaysWithStatus`。同一次调用里还有一个窗口内的当天事实。

| | 85 冻结归档 | 262 冻结归档 |
| --- | --- | --- |
| 清理后 | 事实 2，脏 1，公开摘要仍是 4 | 事实 2，脏 1，公开摘要仍是 4 |
| 汇总后 | `rebuilt=8`，公开 `event_count` 变成 2 | `rebuilt=1`，公开摘要字符串和 `updated_at_ms` 仍是原来的 4 |
| 当天 | 发布为 1 | 发布为 1 |
| 日 / 截止 | `2026-05-21` / `2026-08-19` | 同一天 |

85 的 `rebuilt=8` 是剩下的 6 个 occurred 压舱日、被改写的目标日，加上当天。399 记录里的 `rebuilt=7` 没有这个当天行。方向相同：公开摘要从 4 写成 2。262 只重建当天，目标日的 `analytics_day` 和 `analytics_device_day` 原文不动，该日 dirty 和 retry 被清掉。

262 这次通过之后，再用 `pruneAnalytics(..., 5000)` 清完过期行，然后再次汇总。过期公开行消失，当天仍是 1，汇总没有把剩下的事实写回去。

生产入口也跑了。库里先有已发布的 20 条 received 过期日，2990 条 occurred 事实和 3000 行 occurred 脏/公开/设备日压舱，再加一条当天事实。然后直接执行冻结树里的 `scripts/analytics-rollup.ts`（先 `pruneAnalyticsCycle`，再 `rollupDirtyDaysWithStatus`，时钟是 `Date.now()`）。

- 进程 5171 ms，清理本身 4737.9995 ms，300 chunk，删除事实 3000，`budget_exhausted=true`，单次事务最长 34.789542 ms
- 过期 received 事实剩 10，公开摘要仍是原来的 20，设备日摘要原文不变
- 当天发布为 1，dirty 为 0，`rebuilt_days=1`，`attempted_days=3`，`partial=false`

因此这一轮维护报告里的 `ok:true` 只表示脏标记已清、当天已发布。它同时留下了“公开 20、事实 10”的过期日，直到以后的清理 chunk 轮到 `analytics_day` 那一行。这是“不把残缺事实重新发布”的结果，不是成熟库 90 天净清理已经测完。

官方 `analytics-rollup-page.test.ts` 的过期断言在同一次 `pruneAnalytics(..., 10)` 里会把仅有的公开行也删掉，所以它单独不能证明“已经发布的摘要没被残缺覆盖”。上面的探针补的是这一段。

边界日 `2026-08-19`（正好 90 天）仍会汇总成 1。前一天 `2026-08-18` 的已发布摘要在同一次汇总后保持原文。

## 2. 分页、恢复、去重、旧摘要 — PASS

索引安装后，同一设备 513 行：第一页提交后 stage `revision=-1`，没有公开行；放宽单日事实上限后的下一次得到 513，revision 不再是 -1。正好 512 行一次发布，revision 不是 -1。

跨进程：设备 `a` 先发布 2 条。再写入 `b` 的 600 行和 `c` 的 2 行。子进程用 `maxFactsPerDay=514` 跑完就退出。父进程重开后：

- 公开摘要原文和 `updated_at_ms` 仍是设备 `a` 的那一版
- `b` 的 stage 是 `revision=-1`、`folded_rowid=514`、已折叠事实 512
- `c` 还没有 stage
- 下一次汇总不再解析带 `marker:folded` 的事实（0 次），解析 88 条尾巴
- 最终 `event_count=604`、`sessions=3`、`unique_reward_instances=2`、`reward_grant_events=3`、`explicit_gm_events=1`、`clock_suspicious_events=1`、`active_devices=3`、`data_cutoff_ms` 取最大接收时间而不是最后的 rowid
- distinct 为 session 3 行、reward 2 行。同一设备跨页重复的 `s1`/`r1` 只计一次；另一设备的相同 digest 再计一次

页间由第二条连接写入，再由新进程接着汇总：

- INSERT 一条重复 session：521 条事实，session 仍是 1，期间没有公开行
- DELETE 已折叠的唯一 session：519 条事实，session 为 0
- UPDATE 清掉已折叠奖励的 digest 和 `gm_override`：520 条事实，奖励实例 0，GM 0，奖励事件名仍计 1

失败键：第一页一个命令，第二页同一命令 3 次。发布后的全局第一名是尾巴上的命令，第一页的命令仍在列表里。

无索引时，先插入较晚的接收时间、再插入更早的接收时间，3 条事实都进入公开摘要，`data_cutoff_ms` 是较晚的那个时间，SQL 不带 `INDEXED BY`。重开已有数据的库也不会自己建索引。

## 3. 索引 — PASS

启动和再次打开有数据的库都没有 `analytics_rollup_device_rowid`。`installRollupPrefixIndex` 第一次 `changed:true`，第二次 `changed:false`。安装后 `PRAGMA synchronous` 仍是 2（FULL）。

真实执行到的 SQL 是带 `INDEXED BY analytics_rollup_device_rowid`、`ORDER BY rowid LIMIT 513` 的那条。`EXPLAIN QUERY PLAN`：

`SEARCH analytics_rollup_fact USING INDEX analytics_rollup_device_rowid (dimension=? AND day=? AND device_key=? AND rowid>?)`

`EXPLAIN` 含 `SeekGT` 和 `IdxGT`，没有 `Sort`、`SorterSort` 或 `SorterOpen`，计划文本里没有 `TEMP B-TREE`。`PRAGMA index_xinfo` 的前三列是 `dimension`、`day`、`device_key`，均为 `key=1`、`desc=0`、`BINARY`；随后是 `cid=-1`、`key=0` 的隐式 rowid。

同名错误索引会拒绝安装，而且 `sqlite_schema.sql` 不变。拒绝后的汇总仍数对两台设备，并且不走 `INDEXED BY`。覆盖的形状：缺 `device_key`、`device_key DESC`、`NOCASE`、部分索引 `WHERE device_key='a'`、列顺序颠倒、多一列 `received_at_ms`。已处于事务中时，安装函数抛出 `ROLLUP_INDEX_REQUIRES_OWN_TRANSACTION` 并且不建索引。经 `AnalyticsStore.transaction` 调用时，原有包装把它记成 `ANALYTICS_STORAGE_UNAVAILABLE`，索引仍然不出现。SQLite 3.53.3 不允许把 `rowid` 写成普通索引列，所以没有把这种 DDL 算进产品拒绝路径。

`scripts/analytics-rollup-index.ts`：相对路径失败；`--check` 只读，库文件大小和 mtime 不变，结果 `available:false`；`--offline-reviewed` 返回 `changed:true`，之后 `--check` 为 `available:true`。

## 4. 原门槛没有放宽 — PASS

候选相对 85 只改了 7 个路径：

- `src/analytics/rollup.ts`
- `src/analytics/rollup-index.ts`（新）
- `scripts/analytics-rollup-index.ts`（新）
- `scripts/analytics-rollup-page.test.ts`（新）
- `scripts/storage-capacity-load.ts`
- `package.json`（`test:analytics` 加入 page 测试）
- `docs/prnas-storage-50/t5/convergence-20261117/DESIGN.md`

以下文件的 git blob 在两个提交上相同，冻结归档的字节也算出同一 blob：

| 文件 | blob |
| --- | --- |
| `src/analytics/sqlite-policy.mjs` | `aca73594312fd85229a3662e2b0aa733567e3d4e` |
| `src/analytics/writer.ts` | `90d14c0096f0c07cb90a73356440a68d55db4546` |
| `src/analytics/writer-thread.ts` | `21a73258866e32a93da4edd2d3d4039d11c67412` |
| `src/analytics/index.ts` | `baf5a8fff6f5a9ac3887963860fd5a96ddbcbdc7` |
| `src/ark/runtime.ts` | `9cee37b22aecf3ea0f56935b566be0b2a522ac61` |
| `scripts/analytics-rollup.ts` | `4710f91b4a5695e0e14fca1f9bf2b327e8820305` |

行为上重新执行的部分：`maxDayMs=30001` 和 `maxRunMs=150001` 抛出 `INVALID_ROLLUP_BUDGET`；`30000` 与 `150000` 可以调用。新库 `synchronous=2`。`AnalyticsWriter` 的 `jobTimeoutMs=8001` 抛出 `INVALID_ANALYTICS_WRITER_TIMEOUT`；`8000` 能构造并关闭。负载脚本两个版本都只有一处 `new AnalyticsWriter(`，都保留 `p95<=500`、`p99<=2000` 和 `assert.equal(dirty,0)`。262 只增加显式 `T5_ROLLUP_PREFIX_INDEX=1` 才安装前缀索引。`runtime.ts` 仍是剩余预算 `120`、采纳 `<=125`。这次没有重跑语音 AB，也没有重跑 ACK 负载。

## 5. 官方测试 — PASS

都在 262 冻结树、上述 Node 下执行，退出码 0。

| 日志 | 退出 | SHA-256 |
| --- | --- | --- |
| `logs/page.log` | 0 | `c0ecb80101abf7ad0a773e78a92cb5580b0f92d16bcc0d2a7504fa2d6bbabd85` |
| `logs/resume.log` | 0 | `0c654d36b628b9387b8a5bb1c9a8e6862fb2aa979d6ae75615db42e2031778af` |
| `logs/t4.log` | 0 | `338693b8229f811f2a9779bb3c68820adbdf337e066603e1154fc673491e6b73` |
| `logs/t4-run-budget.log` | 0 | `fe0db08d47ca66e36e02417229308b8604529d7757f650215e2701c2543e204d` |
| `logs/calibrate.log` | 0 | `f93ed2b4348ab7e2c50b8479090e6b3fd181034149c5dd4215d895bf8e623553` |
| `logs/candidate.log` | 0 | `1bafbef2d41629c495f03536c30874e4515cb5c93881ddc8784f7ab350d22c31` |

page 打出离线索引、rowid 范围、单设备分页重启，以及过期脏日不重建。resume 打出重启续跑、迟到写入、更新/删除、子进程退出、全局失败键和 90 天私有 TTL。T4 打出并发写入不丢脏日、多 chunk TTL、容量模型未改。run-budget 打出 150 秒级运行预算在日与日之间停下并保留剩余脏日。

## 未纳入本次 PASS 的范围

- 成熟库 90 天净清理的容量和耗时。上面只证明小库里的分块行为。
- 50 身份矩阵、语音 AB、1 小时断线、24 小时、最终 NAS 还原。
- 新的 50×12000 完整混合。来信里的云端数只当作主13的陈述：85 两次维护 60.065 s partial 与 15.183 s 后 dirty 0、两维各 600k/100 设备、262 冷读 100k 尾巴 10.4526 s、索引增加 114442240 字节、22 个生产 ready 守护。本审查没有复测，也不把它们写成自己的证据。
- 原失败 600k 库、生产库、PM2、3006、设备。生产未改这一句也是来信陈述；我没有连接生产，不能从这边证明生产机器的状态。
- 审查期间新出现的 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1`。
- 任何占用 3306 的官方测试（checkpoint、recovery、ark-warmup 等）这次故意没跑。

## 命令

工作树只用于 `git archive` 和只读 `git` 查询。测试的 cwd 是对应冻结树的 `apps/server`。`TMPDIR` 和 `XDG_CACHE_HOME` 指向 `review-pages`。

```
git -C <worktree> archive --format=tar.gz -o review-pages/262-server-and-snapshot.tar.gz \
  2620f3746f9b275a45eb0d8172adefb056c482aa \
  2-Projects/P003GameDemo20260513/apps/server \
  2-Projects/P003GameDemo20260513/docs/ark-brain-20261031/snapshot-v1.example.json
```

```
PATH=/Users/fu-121/.local/node-v24/bin:$PATH
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx \
  review-pages/grok-262-independent.test.ts candidate
```

退出码 0。`SERVER_ROOT` 指向 262 归档。85 校准把 `SERVER_ROOT` 换成 `review-candidate/archive` 下的同一相对路径，退出码 0。

```
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/analytics-rollup-page.test.ts
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/analytics-rollup-resume.test.ts
/Users/fu-121/.local/node-v24/bin/node --import tsx scripts/analytics-t4.test.ts
/Users/fu-121/.local/node-v24/bin/node --import tsx scripts/analytics-t4-run-budget.test.ts
```

四个退出码都是 0。

署名：Grok 4.7（xAI）| 2026-11-17
