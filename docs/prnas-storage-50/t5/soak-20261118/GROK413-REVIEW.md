# 固定候选 193bf990 本地增量验收

验收对象是 `193bf990b3d15192815254ebeb31375a87a7eb2b`，对照 `b5bb1cbf562aad44b46fed9753541c3f73f9c3a4`。运行和哈希来自私有归档 `review-shared-final/archive`。归档在开跑前逐文件 `git hash-object` 与该提交一致，542 个文件，差异 0。跑完后主工作树出现未提交的 `storage-capacity-load.ts` SQL profiler 编辑和未跟踪的 `storage-sql-profile.ts`；那两份没有进入本次进程。工作树 HEAD 仍是 `193bf990`。未改这份归档，未 SSH，未动生产。

本轮本地 smoke 退出 0。400 条查询按落盘字段重算为 0 错，P99 为 26.860000000000582 ms。ACK 成功样本 P95 102.68245799999931 ms、P99 346.759125 ms，落在既有 500/2000 ms 门内。`analytics_dirty_day` 为 0。`full_t5_pass` 为 false。这不是 Linux 300k，也不是 24h。

## 归档

Node `/Users/fu-121/.local/node-v24/bin/node` v24.19.0。Python 来自 `/usr/local/bin/python3` 3.11.9，SQLite 3.45.1。`node_modules` 只链到既有 server 模块，目标是 `p003-brain-search-tools-20261021` 的 server `node_modules`。快照 `snapshot_id` 为 `synthetic-example-1`。

| 树或文件 | git 对象 | 相对 b5bb1cbf / b1ce23 |
| --- | --- | --- |
| `apps/server/src` | `6c4da74257c63aa9797501024822c251de1e0fc8` | 与 b5、b1ce23 相同 |
| `apps/server/scripts` | `0b15db5bfb340a2de8afe5b78d7709efde443930` | 与 b5 `738b9998`、b1 `52d1afef` 都不同 |
| `apps/server/deploy` | `669a210db9fd2783fd35268b14d675ee2e6a53eb` | 与 b5、b1 相同 |
| `package.json` | `fb5ac668426bcce9b09b6e24de3b840f76968414` | 相同 |
| `pnpm-lock.yaml` | `1435807ffce00d35c81daca5a7c22e99a14c87c2` | 相同 |
| `tsconfig.json` | `7445e35495e49605023008f3d58d131f6a29c22f` | 相同 |
| `docs/ark-brain-20261031/snapshot-v1.example.json` | `35f65e578e8d68671cb4590fe68ae49106a85f8c` | 相同 |

文件数：`src` 218、`scripts` 286、`deploy` 34，加上上述三个清单文件和快照，共 542。生产 `src` 树仍等于 b1ce23。后台导出脚本和 `analytics-rollup.ts` 已离开 b1ce23，不能把全部运行文件说成未改。

相对 b5 的 server 脚本差集就是这 7 个文件：

| 文件 | 193 blob |
| --- | --- |
| `scripts/analytics-rollup.ts` | `29f52dd47e87588c52daaf9fd6457c8f728f630b` |
| `scripts/storage-ark-export.py` | `51ba31ed764d56e99c4c047e4b20e4a4402edc49` |
| `scripts/storage-ark-export.test.py` | `76cc51d17c892b3df0b6f63331b654efaf892773` |
| `scripts/storage-capacity-load.ts` | `c556d922423b59e680f7d9057e79f77aab4346f8` |
| `scripts/storage-shared-query-client.ts` | `309e4c93055f4543b896f54a60091c8ca5254511` |
| `scripts/storage-shared-query-service.ts` | `02dccad1036d3ab5d088c3fbda07ed1f86ad95c8` |
| `scripts/storage-shared-query-client.test.ts` | `1d182167afe83db5e46c2f1ff1e9c86c8e73a182` |

冷启动脚本 `storage-ark-query-load.ts` 仍是 `657eef6ee25aa8437eee939010f5faceb4c78bd3`，与 b5 相同。`storage-soak-schedule.ts` 仍是 `ab41d7412203dcb3adefb1db1d8013f54581ef78`。

## 代码里这 7 个文件做了什么

`storage-ark-export.py` 把 BUSY 重试放在连接的 `execute` 和 `commit` 上。共享预算 `BUSY_RETRY_SECONDS=1.0`，失败语句耗时和最多 25 ms 的退避都从这一秒里扣。连接参数仍是 `timeout=.1`，`MAX_BATCHES` 仍是 20。失败后不重跑整个 `cycle`。写 `last_error` 的第二次 SQLite 错误被接住，原始异常继续抛出；CLI 追加 `sqlite_errorname`。

`analytics-rollup.ts` 只在原有 JSON 上增加 `work_started_at_ms` 和 `work_finished_at_ms`。起点在 `AnalyticsStore` 构造成功之后、prune 之前，终点在 `finally` 里关闭 store 之前。

查询改成一个常驻子进程。父进程在 `produceArk()` 之前 `await startSharedQuery`。子进程在发出 `boot` 之前构造一次 `ArkStore`。查询打到本轮 `createAnalyticsApp` 的 `/internal/analytics/ark-summary`。合成 reader 的 `arkDeviceKey` 是 `sha256`，`readArkAuthorization` 调用的 `ArkStore.grant` 是按 sn/account/epoch 的 SELECT。每条应答带接收进程 PID。父进程把 `receiver_pid !== process.pid` 算进 invalid，并要求 reader 行数等于样本数。预验和全日分支才断言 HTTP 区间与 `work_started_at_ms`/`work_finished_at_ms` 相交；smoke 分支只要求样本数大于 0 且 invalid 为 0。

`storage-shared-query-client.test.ts` 在查询进行中 SIGTERM 子进程，随后的 query 和 stop 都拒绝。

## 本机命令

都在归档的 `apps/server` 下执行，`PATH` 以 `/usr/local/bin` 开头。

| 运行 | exit | 证据 |
| --- | --- | --- |
| `storage-soak-schedule.test.ts` | 0 | stdout sha256 `dd4685fff95861073dadf1ef182704538821cfccd6a1cd90c660c3800d656bf0`，73 字节 |
| `storage-shared-query-client.test.ts` | 0 | stdout `bc0ac70b4860c266e0f26cb2f5f085ea2f404cdaaac7e33ea325e1b5764452d1`，60 字节。输出是 `shared query IPC: pending death and later calls fail closed` |
| `storage-ark-export.test.py` | 0 | 12 项，skipped=2。详细日志 sha256 `fac38126ff6143804ec19535c8549145584c1874144bd68c9f5cfdaf8df1670a` |
| smoke | 0 | stdout sha256 `599052aca9f19b5cbb7c1008051a0e04adb7b8febce89962f0d173e868a546f9`，403 字节；stderr 空 |

Mac 上跳过的两项是 `test_persistent_writer_lock_stops_bounded_and_preserves_pending` 和 `test_transient_writer_lock_exports_once_without_lengthening_sqlite_timeout`，原因都是 Linux 部署运行时。`test_non_busy_sqlite_error_is_not_retried` 在本机通过：缺表是 `SQLITE_ERROR`，`busy_retries` 保持 0。

Linux 证据沿用 `EXPORT-BUSY-LINUX-GREEN-02.json`。其中 `storage-ark-export.py` 的 sha256 `ba559a03ed1b7dcd15ec091b7d64045c7e765e39d2d848af59f9f99695ff7713` 和测试文件 `a564fd724e48958dbd5eae85cf9a7dd9fdab1968254e1d0fe3d69f032467bf1e` 与本提交字节一致。该记录是 Python 3.12.3、SQLite 3.45.1、12 项 OK、exit 0。本机没有重跑这 12 项，也没有用 Mac 时限代替它。`EXPORT-BUSY-LINUX-RED.json` 记录的是旧脚本：350 ms 写锁后，`last_error` 更新再次 `database is locked`，原始异常被替换。`EXPORT-BUSY-CANDIDATE.json` 里的 py sha256 `b8b3be4e…` 与本提交不一致，不能拿来代表 193。

Smoke 命令是 `T5_SOAK_SMOKE=1 T5_DEVICES=50 T5_EVENTS=200 T5_MAINTENANCE=1 T5_BACKUP=1 T5_ARK_HISTORY_INDEXES=1 T5_ROLLUP_PREFIX_INDEX=1`，目录 `review-shared-final/p003-t5-shared-fixed-smoke`。计划时长 17000 ms，墙钟约 30.478 s。`RESULT.json` sha256 `48a57ed8bf68e3264e21f900552609d47abc438c637e62f8d5e4906f39f76b28`，`SOAK-RESULT.json` `f3112965a6488718e1f02152d0bbbb91bdb3f6b2aac0c2bf8d45434b259cc124`，`SOAK-QUERY-RESULT.json` `f5c6e4404c68ebce13697d7f7141f7519dfbb6bcdd8911e7e885221b0f3747a1`。

## 重算

8 个 `mixed-query-*.jsonl` 各 50 行，actor 0 到 49 各一次，共 400。按 `floor(400*0.99)=396` 取到的 P99 是 26.860000000000582 ms，与 `SOAK-QUERY-RESULT` 相同。最大一笔 42.545500000000175 ms，超过 100 ms 的是 0。跨度 31276 ms，最大轮距 5003 ms。

落盘字段重算：金币值等于快照 `round+actor` 且时间对上 `expected_coins`，补勤卡等于 `actor%4`，星尘为 null，HTTP 200，`body_complete`，`receiver_pid` 等于父进程。这六项的失败数都是 0，子进程写入的 `correct` 也全是 true。

接收 PID 是 18981。它同时出现在 `config.json`、`shared-query.startup.json` 的 `receiver_pid`、400 条样本和 400 条 `shared-reader.jsonl`。查询子进程 PID 是 19120。两边 `query_id` 顺序一致。首条样本在 `mixed-query-1794941424375.jsonl` 第 1 行：actor 0，`query_id` `mixed-query-1794941424375-0`，`ms` 24.681458999999904，快照 `soak-1794941421347-0-0`，金币 0，`occurred_at_ms` 1794941422416。这个时间和第一条 `ark-continuous.jsonl` 的 `at_ms` 相同，并早于该查询的 `sent_at_ms` 1794941424384。暖机在 `shared-query.startup.json`，`status` ready，260.213125 ms，没有进样本 jsonl。`ark_grant` 行数 50。

请求窗口由 `requests.jsonl` 重算：`first_sent` 1794941424953，最后活动 1794941453422，与 `SOAK-RESULT` 一致。162 次尝试里 200 有 50 次、503 有 112 次。百分位只含 50 条成功 ACK，`floor(50*0.95)=47` 得 102.68245799999931 ms，`floor(50*0.99)=49` 得 346.759125 ms，与 `RESULT.json` 的 `acks` 相同。50 个 actor 都完成。既有门是成功 ACK 的 P95≤500 且 P99≤2000。

库内 `analytics_event` 与 `analytics_event_seen` 都是 10000，`analytics_dirty_day` 是 0。`ark_archive_stats.last_error` 为 null，`pending_records` 450。六次导出 stdout 都是 `sqlite_busy_timeout_ms` 100、`busy_retries` 0，没有导出 stderr。这次 smoke 没有碰到 BUSY。唯一的 stderr 是 `backup-1794941427522.stderr`，内容为 `{"phase": "copy", "remaining_pages": 0, "total_pages": 197}`，该次备份 exit 0。

唯一 `published` 备份的外层区间是 1794941427694 到 1794941427804，内部 `backup_started_at_ms` 1794941427774，落在请求窗口内。随后备份状态是 `waiting_for_nas`。用维护进程的 `start`/`rollup_done` 对请求窗口重算，6 个周期相交；第一轮 rollup 在首个请求之前结束，没有算进去。脚本写出的 `maintenance_overlapped_daily` 与 `backup_overlapped_daily` 都是 true。

实际工作区间对 `shared-reader.jsonl` 的相交如下。谓词是 `work_started_at_ms <= done_at_ms` 且 `work_finished_at_ms >= received_at_ms`。

| 维护 start | 实际工作 | 工作毫秒 | 相交请求 | 最大相交 |
| --- | --- | --- | --- | --- |
| 1794941424375 | 1794941424815–1794941424820 | 5 | 0 | 0 |
| 1794941427519 | 1794941427738–1794941427750 | 12 | 0 | 0 |
| 1794941432375 | 1794941432587–1794941432652 | 65 | 1 | 1 ms |
| 1794941437378 | 1794941437627–1794941437773 | 146 | 2 | 2 ms |
| 1794941442378 | 1794941442582–1794941442620 | 38 | 1 | 1 ms |
| 1794941447381 | 1794941447606–1794941447657 | 51 | 1 | 1 ms |
| 1794941452383 | 1794941452584–1794941452617 | 33 | 0 | 0 |
| 1794941455651 | 1794941455923–1794941455959 | 36 | 1 | 2 ms |

`.some` 为 true，与 `query_overlapped_maintenance` 一致。相交只有 1–2 ms，8 轮里有 3 轮没有相交。smoke 分支不断言这项。预验和全日才会要求它，这两条分支本轮没有执行。

## 本轮边界

- 本地 smoke、调度测试、IPC 失败关闭测试和 Mac 可运行的导出测试通过。
- Linux 上 1 秒 BUSY 预算的真实锁计时沿用已核对 sha256 的 GREEN-02，本机两项跳过。
- 预验重叠断言、Linux 300k、24h、NAS 回执、资源 cgroup 都没有在这轮执行。`resource_gate` 为 false，`full_t5_pass` 为 false。
- 主 13 工作树里那次 10k/400 查询记录没有当作本次通过证据。
- 跑完时主工作树已有无关的 profiler 脏文件；结论只覆盖归档里的 `193bf990`。
