# T5 A01–A15 只读证据矩阵

本轮是只读核对。没有改业务源码，没有部署，没有 SSH 加压，没有动其它工作树、生产或设备。没有把 T5 写成通过，没有把 50 档写成已验证，没有上线。

已验证档仍是 14。规划配额默认 50。50×6000 覆盖索引轮只是日批子项。T5 整体未过。

## 审计边界

| 项 | 值 |
|---|---|
| 开始 | 2026-11-17T03:02:29Z |
| 开始 HEAD | `b6facc1b315b76852d1ee93b120ab2d1e30a5a50` |
| 开始工作区 | 干净 |
| 结束 HEAD | 见文末。写本报告时提交未动 |
| 本轮执行的测试 | 无 |

`d6b875db..HEAD` 的 `apps/server/src` 与 `apps/web` diff 为空。因此 T4 候选上的配额、Ark、裁剪源码 blob 与当前提交相同。T5 之后新增的是负载脚本和文档，不是这些门禁的业务实现。

审计进行中，工作区出现了别人正在改的三个路径。本审计没有写它们，也不把未提交内容当成证据：

- `scripts/storage-capacity-load.ts`（已修改）
- `scripts/storage-load-ledger.ts`（未跟踪）
- `scripts/storage-load-ledger.test.ts`（未跟踪）

上次准备审计把 A01–A05 写成「无」。那个「无」只表示当时的 T5 矩阵没有重跑，不抹掉 T1–T4。主 13 在 `t5/grok-soak-review/ROOT-REVIEW.md` 第 4 条已经收过这个口径。本矩阵按「已有隔离证据 / T5 仍须重绑」分开写。

## 现在可以本地隔离回归

这些命令在 `2-Projects/P003GameDemo20260513/apps/server`，用临时库，不连生产，不 SSH。源码 blob 与已验候选相同，所以这是同一实现的重跑，用来把日志哈希绑到当前 HEAD。本轮没有跑。

| 门 | 命令 | 已有证据绑在 |
|---|---|---|
| A01 配额越界 | `npm run test:storage` | T4 `d6b875db`，日志 SHA-256 `d416615f2f1926d9e0ed6e25d4dce76d3eb0d507fbbfda4d3ef5cd03174f271b` |
| A02 合成 100 档 | 同上，核心是 `storage-policy.test.ts` | 同上。`evidence:SYNTHETIC-TEST-ONLY` 才放行 100；缺省验证档仍是 analytics 14 / ark 0 |
| A03 的已覆盖部分 | 同上，含 `storage-http.test.ts` 与 `storage-concurrency.test.ts` | 同上。独立连接按 revision 立即看见新配额；6 轮双进程竞态 |
| A04 的已覆盖部分 | `node --experimental-sqlite --import tsx scripts/ark-archive.test.ts` 然后 `npm run test:ark` | T3 `4ea6af5a`。`store.ts` blob `3970db47567a5319964f94acc9cd876963f637ec` 与 HEAD 相同 |
| A05 的检查点规则和本地 manifest 校验 | `npm run test:ark-archive` | 同上。`storage-ark-nas.test.mjs` 只用临时目录 |
| A08 的预算单测 | `analytics-maintenance.test.ts`、`analytics-t4.test.ts`、`analytics-t4-run-budget.test.ts`、`analytics-prune.test.ts` | T4 复跑于 `a3f2b982` 时这三项 exit 0。不代替 90 天净吞吐 |
| A09 的超时注入 | `ark-runtime.test.ts`（含在 `npm run test:ark`） | 挂起的响应体会变成「未知」。这不是 p99 余量 |
| A12 的缓冲/余量拒绝 | `ark-archive.test.ts` | 满缓冲与空闲空间预留下不提前提交 |
| A13 的进程中断与不复活授权 | `ark-archive.test.ts` 加 `analytics-load-accounting.test.ts` | SIGKILL 前后、换绑不恢复旧 grant |
| A15 的回归套件 | `test:analytics`、`test:analytics-capacity`、`test:analytics-control`、`test:analytics-v375`、`test:ark`、`test:device-config`、`test:storage`、`test:ark-archive` | T4 日志已过。全仓 typecheck 仍是与 T1 相同的 12 条旧错，日志 SHA-256 `4ab70e064cd2ef96dc8bea4b5e2f32dca1c83e2d1f5f52d013f3aa05b9f559f7` |

本地还差、但不需要云盘、24 小时或真人语音的最小步骤：

- A03：现有测试没有四个进程在 5 秒内同时读到新 revision。补一次本地多进程读：主服务、接收端、Ark 管理、事实代理。紧急关闭不看 NAS 健康这一点，`storage-http.test.ts` 里过期容量下的关闭 PUT 已经返回 200。
- A04：50 个 SN 的现有断言只核对了 `family_coin` 和 SN 唯一。GM、unknown、旧 epoch、换绑在别的用例里有，但不是这 50 行的币、卡、奖励、时间全字段矩阵。补在临时库上即可。COVER01 里 50 条 `source_mode:normal` 只是负载脚本自己的状态 POST。
- A15：还没看到「超过 32 个授权的隔离库上回滚，授权、快照、seen 都在，且不整库倒灌」的执行记录。可以在临时库做。会话 360 的后台合并属于 T6。

## 口径更正

### A09

通过线是：同设备同数据的本地查询 p99，比实际最短内部 deadline 至少低 20ms。

当前代码里最先中止查询的是 `src/ark/runtime.ts`：内部 `ark-summary` 的 abort 为 `max(1, 120-elapsed)` 毫秒，且只有总耗时 `<=125` 才保留 history。`src/ark/proxy.ts` 的读体、竞态和接受门槛都是 150ms。分析控制面的内部 fetch 是 2000ms。`IMPLEMENTATION.md` 写的 150ms 比这段 120ms abort 松。

所以按当前源码，最短 deadline 是 120ms，p99 要通过就要 `<=100ms`。这不是 p99<20ms。若以后实测到更短的内部 deadline，用那个数再减 20。

`ark-runtime.test.ts` 只证明超时后退成未知，并且耗时 `<250ms`。COVER01 没有 Brain 查询延迟。p99 必须在目标机的隔离负载上采。笔记本磁盘不能代替。这一项不靠成熟库、不靠 24 小时、不靠真人语音。

runtime/proxy blob 与 T3 `4ea6af5a` 相同：`9cee37b22aecf3ea0f56935b566be0b2a522ac61`、`de6ab0060ec04165fbe7c347fb2415ff92bdf34c`。

### A08

30 秒写在裁剪上。`PRUNE_CYCLE.maxMs` 是 30000。汇总另有单日 `maxDayMs=30000`、整轮 `maxRunMs=150000`，父进程超时 240000。T4 把 TTL 30 秒 + 汇总 150 秒 + 末日 30 秒收成 210 秒包络。

`analytics-rollup.ts` 先 `pruneAnalyticsCycle`，再 `rollupDirtyDaysWithStatus`。负载脚本只存这次子进程的 `{start,done,code}`，丢掉 stdout 里的 `pruned.elapsed_ms`。

COVER01 三次维护墙钟是 1897ms、44301ms、42854ms。后两次大于 30 秒，不能据此判定裁剪单轮违规，也不能据此判定裁剪通过。无覆盖索引的首轮失败是某个 occurred 日块超过汇总单日预算且 `dirty=1`，那是 `maxDayMs`，仍然不是裁剪耗时。

T4 云上 994MB 夹具：TTL 一轮 7424ms，事务 p95 21.6ms，事务最大值 221.2ms。最大值高于 100ms 锁门槛，而事务 p99 没有单独公布，所以这轮不能记成锁 p99 通过。它也不是 8944 万行的 90 天库。

主 13 下一改负载脚本时，应留下 `pruned.elapsed_ms`、`pruned.max_transaction_ms` 和汇总的日/轮字段。本审计没有改那个文件。

90 天净处理需要成熟库和目标机 IO。成熟库 44,871,368,704 字节，约 41.79GiB，进不了 40GiB 根盘。这不是语音项，也不是 24 小时项。

## 真正要成熟云盘、长时间或真人语音的项

| 需要 | 门 | 原因 |
|---|---|---|
| 目标机 IO，不必先上成熟库 | A06 的 600k、A07 的成熟/600k 延迟、A09 的 p99 | 600k 要在代表规格上跑到 2 小时门槛内。事件上限 60000 允许每台 12000，50×12000 没被参数挡住，只是没跑。A07 的 84k RSS 与健康 P95 也不能打生产 `/health` |
| 成熟盘 + 目标机 IO | A06 的旧 raw/90 天重叠、A08 的净回收与锁 p99、A13 若要按现行 4.5GiB 预留重绑恢复 | 44.87GB / 89,442,002 行已在 NAS 夹具。T2 恢复仍有效，但 `storage-backup-job.py` 的默认预留已从 4GiB 改为 4GiB+512MiB，且该改动已在 `d6b875db` |
| NAS + 真实 1 小时断开 + 恢复后 24 小时排空 | A11 | 72 小时积压可以用加速模型估算。T2 的 100.91MiB 广域网包和软件故障不能代替这项。问答不等 NAS，不要求声学语音 |
| NAS 满额或等价配额盘 | A12 的 NAS 满额分支 | 本地 `freeBytes` 桩已经覆盖 Ark 预留拒绝 |
| 连续 24 小时墙钟 | A14 | `storage-load-health.test.ts` 灌了 86400 条样本，不是 86400 秒。已引用的 unit `RuntimeMaxSec=4200`。最长云样本约 544 秒。health-v2 的 2×601 本地冒烟不是耐久 |
| 真人语音 | A10 | 同机同语料，基线与候选各至少 50 轮。首声 p95 增量不超过 `max(100ms, 基线的 10%)`。本地阶段与供应商阶段分开。新增断连、无声、`begin_timeout` 为 0。SDK 自测不算。`/ready` 不算 |

## 已有子项，不能升格成 T5 通过

COVER01 固定在文档提交 `55df59fa`，工具提交按 `t5/STATUS.md` 为 `a3f2b982`。种子 17，50×6000，1500 批，300000 条全部入库，重复 0，墙钟 544.148 秒。成功 ACK p95/p99 为 395.00/1088.17ms，503 共 2770 次保留在状态直方图里。dirty 0，备份退出码 0。阶段字段写的是 `T5_INCREMENTAL_LOAD_NOT_FULL_ACCEPTANCE`。覆盖索引只在合成副本上，没有进生产 schema。

无覆盖索引的首轮 `084eee66` 入库后 dirty=1，仍然是失败。

分析库 checkpoint 的 failures/timeouts 为 0。那是 WAL checkpointer，不是 A05 的 Ark manifest。A05 已有的 manifest 是 T3 包 `ccf79ab0091241f88b61ab2f4b460ac6`，SHA-256 `23a16d81e8b87638b9a250ab4d0794421ef6a7d425280843375f2169e8822c9a`，50 行、41755 字节，`E2E-NAS.json` 记录 `ARCHIVE_VERIFIED`。

## 结束

结束时再次读取的 HEAD 写在下面。若与开始相同，表示本审计没有产生提交。未提交的负载脚本和流式对账文件保持原样。

## 结束戳

| 项 | 值 |
|---|---|
| 结束 | 2026-11-17T03:12:49Z |
| 结束 HEAD | `b6facc1b315b76852d1ee93b120ab2d1e30a5a50` |
| 与开始是否同一提交 | 是 |
| 结束工作区 | `storage-capacity-load.ts` 已修改；`storage-load-ledger.ts` 与 `storage-load-ledger.test.ts` 未跟踪。均非本审计所写 |

机器可读副本：同目录 `MATRIX.json`。
