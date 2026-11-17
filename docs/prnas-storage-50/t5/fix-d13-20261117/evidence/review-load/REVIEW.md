# P003 T5 负载独立验收（1e487）

验收时间 2026-11-17T21:07:00+08:00。只读本地提交、已有审查日志和 `D/cloud-full-evidence`。没有 SSH，没有改业务源码，没有部署，没有改设备或其他工作树，没有重跑已经通过的回归。`FULL-DOWNLOAD-VERIFIED.json` 里的 `verified: true` 只说明压缩包已落地，下面的数字是这次自己重算的。

固定提交 `1e4878f509840fb24007fdc561e5d69569d92363`，父提交 `07f8b55246d4767beb0af6244e9a7cc81eb26042`。运行目录是隔离合成夹具 `p003-t5-fix-50x12000-01`，50 个 `BJP003999999…` 身份，空库起算。它不是生产 3006，也不是 50 台真实设备。

## 四项判断

项目 1 恢复：沿用 Grok392 对 `61332160fe603b98a3b8cb3141b2ceab4a9db203` 的独立实测。`src/analytics/writer.ts`、`src/analytics/checkpointer.ts`、`scripts/analytics-recovery.test.ts`、`scripts/analytics-checkpoint-admission.test.ts` 的 git blob 在 613 与 1e487 上相同。本轮没有重跑这两份测试。

完整 60 万 ACK 门：通过。3000 个 HTTP 200 的单次请求时间，`floor(n*p)` 的 P95 是 204.03806099994108 ms，P99 是 506.5188049999997 ms。门槛是 500 ms 和 2000 ms。客户端耗时 1142477 ms，低于 2 小时。`completed.jsonl` 逐行对上 3000 批、600000 个唯一 ID。

项目 3 查询：通过。三组各 1000 条，失败 0，P99 为 26.407460000000356 / 24.970807000001514 / 25.262571000000207 ms，都低于 100 ms。首笔留在样本里。本轮没有重发 HTTP。

整体 T5：未通过。维护结束后 `dirty_days` 为 2，systemd `ExecMainStatus=1`。成熟库、语音 AB、24 小时资源观察都没有这次测量。ACK 通过不把整体 T5 写成通过。

## 1e487 只加了 batch_elapsed_ms

相对 07f8，唯一文件是 `apps/server/scripts/storage-capacity-load.ts`，3 行增、1 行删。相对 `afc2bec31d73656c27df552278c4057c85e5de7e`，`apps/server/src` 无差异；另外只多了 07f8 的 `scripts/ark-history.test.ts`。工作区里这两个路径是干净的。

客户端在每个 batch 的第一次请求前记 `performance.now()`，每次尝试结束再记一次。`ms` 仍是这一次 HTTP 的耗时。`batch_elapsed_ms` 是从该批第一次请求到这一次尝试结束的单调时钟，成功那一行包含前面的 Retry-After 睡眠。批与批之间的 2 秒间隔在成功记录之后，不进 `batch_elapsed_ms`。本地 Node v24.19.0 上 `performance.now()` 随 `hrtime` 前进。云端 RESULT 的 node 也是 v24.19.0。

`FULL-SOURCE-VERIFIED.json` 列出 216 个 `src` 文件的 SHA256。与本地 1e487 逐文件比对，216/216 一致。这份清单声称云端运行树与它相同；我没有 SSH 去重读云端目录。云端 `requests.jsonl` 的 10299 行都有 `batch_elapsed_ms`，且每行都 `batch_elapsed_ms >= ms >= 0`，说明写出账本的客户端带有这个字段。

## 本地 smoke

`evidence/elapsed-smoke-validation.json` 的 `results` 与 `p003-t5-elapsed-smoke/requests.jsonl` 逐字段相同。SHA256 `c1187348beece9da273101566702870b8b9b6096051ffb806d556943de72b0d0`。`test_sha` 为 1e487。

5 行请求：503 一次，200 四次。四个成功批是 actor/offset `(0,0) (0,200) (1,0) (1,200)`。503 是 actor 1、offset 0、attempt 0，`ms` 28.571291999999858，`retry_ms` 5000，`error` `ANALYTICS_OVERLOADED`。同批 attempt 1 成功，单次 `ms` 80.14425000000028，`batch_elapsed_ms` 5111.552167。两次记录之间扣掉成功请求本身后的间隔是 5002.827292 ms，对应 5000 ms Retry-After 加上定时器余量。

`completed.jsonl` 四批按 actor 顺序衔接，accepted 402，duplicated 0，rejected 0，唯一 ID 402。只读打开 `analytics.db`：`analytics_event` / `analytics_event_seen` / `analytics_batch` 为 402 / 402 / 4，`PRAGMA quick_check` 为 `ok`。这是本机小样本，不是云端 60 万库。

## 已有审查，本轮未重跑

Grok392 `review-candidate` 固定 613。日志 SHA256 与 `REVIEW.json` 记录一致：

- `logs/analytics-recovery.log` `c7b9be8fec4d7a1f9bce15b849a7e38fcfc3e08c2e46840c07aa3919289d3ac0`，末行 `EXIT:0`，正文为 HTTP 503、迟到 durable commit、writer 退出、重启信号、重放去重、正常关闭。
- `logs/analytics-checkpoint-admission.log` `e8b88f0ce77a725cf8c01cf501c1cdd729f6eda7a45efaa00c2d00de51700fd2`，末行 `EXIT:0`，正文为排空当前写入、即时 503、checkpoint 不重叠、错误或 stop 后恢复。

Grok393 `review-final` 固定 07f8，运行时代码与 afc2 相同，1e487 未再改这两份源文件。

- `logs/ark-history.log` 与 `logs/ark-history-cover.log` 都是 pass 18、fail 0、`EXIT:0`。SHA256 `9f1f13824d47c7620c9e2b09e0c6d5edad2c7388388aa983522c779100c719c2`、`5844d7baf1cdbb518a8a1c4d110ef735bf768de5e19fc1d095357842ce17c513`。
- `logs/ark-warmup.log` `21a1fabe9672c903de91f68ce5903a7dd549d8f12181ef1b66db68622e710623`，三次 `first_ms` 为 27.012207999999987、27.940832999999998、30.11820799999998，`EXIT:0`。

`QUERY-VALIDATION.json` 记录的四份云端摘要 SHA256 与磁盘文件一致，包括 `QUERY-V2-RUNS.json` `27167fa0a4b90741833fd90d8d55f80b698e484846890015a945654c58ab197b`。`CANDIDATE-V2.json` 的候选是 afc2。

## 项目 3：三组 1000 查询

百分位与负载账本同一规则：全部样本升序，下标 `min(n-1, floor(n*p))`。这里 n=1000，样本包含失败行和第一行；这三组没有失败行。`ms` 与发布的 `v2-final-*.json` 逐位相同。

| 运行 | 行数 | 状态 | 失败 | 首笔 ms | P95 ms | P99 ms | 最大 ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| v2-final-0 | 1000 | 200 | 0 | 32.72323099999994 | 18.255162999997992 | 26.407460000000356 | 70.35997099999804 |
| v2-final-1 | 1000 | 200 | 0 | 82.96229600000015 | 17.93044199999713 | 24.970807000001514 | 82.96229600000015 |
| v2-final-2 | 1000 | 200 | 0 | 74.71096299999999 | 18.05416699999978 | 25.262571000000207 | 74.71096299999999 |

门槛是 P99 ≤ 100 ms 且失败数为 0。三组都满足。第一组的首笔是 32.7 ms；后两组的首笔就是该组最大值，仍低于 100 ms。拓扑是同机合成观察副本，1 CPU / 768 MiB 的查询 unit，不是这次 0.5 CPU 的 60 万负载，也不是生产。

## 云端包完整性

`evidence/full-evidence.tar.gz` 2335548 字节，SHA256 `072836f0113f3cd25d1dc081da1bf796e73c08108420e8b4119d3644a6980110`，与 marker 一致。

`cloud-full-evidence/d13-fix-20261117/FULL-EVIDENCE-MANIFEST.json` SHA256 `54237392ee4e7837796a20b04a29dde91a192897be4457c75ed0906bc5bf6db6`，与 marker 一致。manifest 内 28 个文件的字节数和 SHA256 与解包文件全部一致，缺文件 0。

`requests.jsonl` SHA256 `dee7f5504c78ca81008bbd2a996d263dff4c608f3ce8f212cf9084386ffacf3d`。`completed.jsonl` SHA256 `bb0950f81891970f3329a1abf80d4e0c40466278cd93db8cb7ae87d89fe792b3`。

启动记录：2026-11-17T20:32:21.192+08:00 至 2026-11-17T20:53:36.256+08:00。命令为 `CPUQuota=50%`、`MemoryMax=768M`、`T5_DEVICES=50`、`T5_EVENTS=12000`、`T5_MAINTENANCE=1`、`T5_BACKUP=1`、`T5_COVERING_INDEX=1`、`T5_ARK_HISTORY_INDEXES=1`、`T5_DEADLINE_MS=7200000`。`candidate` 记为 afc2，`tested_final_sha` 记为 1e487。配置与此相符：`deadline_ms` 7200000，`synthetic` true，库从 0 事件开始。

## 60 万请求账本

`requests.jsonl` 10299 行，按 actor 的 offset 与 attempt 顺序检查，错序 0。50 个 actor 都停在 offset 12000，每个 actor 60 个成功批。

状态计数，一行不漏：

| 状态 | 行数 | 非 200 的 error |
| --- | ---: | --- |
| 200 | 3000 | |
| 503 | 7299 | `ANALYTICS_OVERLOADED` 6753，`ANALYTICS_WAL_PRESSURE` 546 |

文件第一行是 actor 2、offset 0、attempt 0 的 503，`ms` 1115.2242759999995，已计入 7299。200 的百分位使用全部 3000 个 `ms`，没有按首批、预热或 503 删除成功样本。503 的耗时不进入这 3000 个数，避免失败样本把 P95 拉低；它们留在上面的状态表里。

升序后下标 `floor(3000*0.95)=2850`、`floor(3000*0.99)=2970`：

| 时钟 | 是什么 | P95 | P99 | 最大 |
| --- | --- | ---: | ---: | ---: |
| 单次 HTTP 200 的 `ms` | ACK 门 | 204.03806099994108 ms | 506.5188049999997 ms | 1787.8877149999998 ms |
| 成功行的 `batch_elapsed_ms` | 该批第一次请求到最终成功，含重试睡眠 | 58974.329860000056 ms | 107906.81901699991 ms | 182574.5684 ms |
| `client-result.json` 的 `duration_ms` | 客户端墙钟，含重试睡眠和批间 2 秒 | | | 1142477 ms |

ACK 门用第一行。P95 低于 500 ms，P99 低于 2000 ms，最大一次 200 也低于 2000 ms。1173 批在 attempt 0 成功，1827 批至少重试一次，最大 attempt 序号 33。所以第二行的 P95 约 59.0 秒、P99 约 107.9 秒、最大约 182.6 秒，是含重试的批时间。它不参与 500/2000 的判定。

客户端墙钟 1142.477 秒，低于 7200 秒。驱动从启动到 `FULL-DONE` 是 1275.064 秒，里面还有客户端结束后的维护。资源采样窗口 `observed_ms` 是 1202992.2556。这三件事都不是单次 ACK 时间。

`completed.jsonl` 3000 行。每个 actor 的 offset 从 0 按批连续到 12000。每一批的 `accepted_event_ids` 与 `duplicated_event_ids` 拼起来，与 `load-t5-17-1794918745758-<actor>-<index>` 的规范集合相同，批内无重复，`rejected` 为空。跨批唯一 ID 600000，accepted 600000，duplicated 0，rejected 0。50 个 actor 全部到齐。客户端 `failures` 为空，50 个 Ark 快照都是 HTTP 200。RESULT 里 `integrity.complete` 为 true，`database_before` 为 0/0/0，`database_delta` 为 600000/600000/3000，与这条 ID 对账一致。这里用的是逐行 ID，不是 RESULT 里的汇总字段本身。

## 维护失败，unit 退出 1

`FAILURE.json` 的错误是 `2 !== 0`。这是负载脚本在 ACK 断言之后执行的 `assert.equal(dirty, 0)`。客户端退出码是 0。RESULT 已写出，`acks.p95/p99` 与上面的重算相同，`evidence_consistent` 为 true，Ark 50/50 `correct`。

五次维护进程的退出码都是 0。报告本身：

| 次序 | report.ok | 失败日 | 剩余 dirty |
| --- | --- | --- | --- |
| 1 | true | 无 | 0 |
| 2 | false | occurred 2026-11-17 `concurrent_write` | 1 |
| 3 | false | received 与 occurred 2026-11-17 `budget_exceeded` | 2 |
| 4 | false | occurred 与 received 2026-11-17 `budget_exceeded` | 2 |
| 5 | false | occurred 与 received 2026-11-17 `budget_exceeded` | 2 |

最终 `dirty_days` 为 2。脚本不把 `report.ok === false` 当成进程失败，脏日断言才让进程抛错。systemd 记录 `Result=exit-code`，`ExecMainStatus=1`，`ActiveState=failed`。`MemoryPeak=805376000`，`CPUUsageNSec=231178107000`。没有 OOM 标记。`guard_stop` 为空。

这是维护项失败。ACK 数字不改写这一项。

## 备份、数据库、guard、检查点

备份进程 `backup_exit` 为 0。`backup.stdout` 的清单时间是 2026-11-17T20:32:28.949+08:00，距配置写入约 6.2 秒。`record_count` 1067，其中 `analytics_event` 200、`analytics_event_seen` 200、`analytics_batch` 1、`analytics_dirty_day` 2、`analytics_rollup_fact` 400。这是开跑后的定时备份，不是 60 万事件落完后的全库备份。

只读数据库计数写在 manifest 里：`analytics_event` 600000，`analytics_event_seen` 600000，`analytics_batch` 3000，`analytics_dirty_day` 2，`analytics_rollup_fact` 1200000。`quick_check` 的记录是 `NOT_COMPLETED: auxiliary collector v1 hit 300s limit; no phase instrumentation in that attempt`。压缩包里没有 `analytics.db`，我不能在本地再跑一遍 `PRAGMA quick_check`。因此 quick_check 没有通过记录。事件 ID 对账覆盖的是账本，不代替这个 PRAGMA。

`full-guard.jsonl` 254 行，`production_ready` 全部为 true，`free_bytes` 最小 5741899776（约 5.348 GiB），没有低于 5 GiB（5368709120）的行。生产 3006 在采集 manifest 时 `ready` true，`storage_failures` 0，`sql_busy` 0，`disk_free_bytes` 5834543104。guard 没有因磁盘或生产健康停掉这次 unit。

夹具自己的 `health.jsonl` 1202 行：HTTP 200 共 1064，503 共 138；`ready` 非 true 138 次；`storage_failures` 最大 0；`sql_busy` 最大 0；`disk_warning` 1202 次全为 true，因为空闲低于 8 GiB 的警告线，同时仍高于 4 GiB 的服务停写线和 5 GiB 的本次 guard。`disk_free_min_bytes` 5741883392。`wal_peak_bytes` 271503912，高于 `wal_max` 268435456，差额 3068456。这与 546 次 `ANALYTICS_WAL_PRESSURE` 同向。结束时 checkpoint `failures` 0、`timeouts` 0、`last_error` null、最后一次结果 `ok` true，同时 `running` true、`stale` true。1202 个健康样本里 4 个 `stale` true。unit 的退出原因仍是脏日断言，不是 guard。

资源摘要：`cgroup_cpu_quota_cores` 0.5，`cgroup_cpu_average_one_core_percent` 18.148122399267752，`cgroup_memory_peak_fraction` 1，`oom_seen` false，`complete_24h_evidence` false，`required_ms` 86400000，`local_resource_gate` false。未覆盖项包括 NAS budget、voice A/B、maintenance backlog、external service restart counters。

## 整体 T5 还缺什么

这次测量覆盖的是空库上的 50×12000 合成负载、维护与一次早期备份、cover/v1 索引开关，以及此前已经落盘的 3×1000 查询。成熟大库、语音 AB、24 小时资源门没有新的测量。维护脏日没有清掉。`quick_check` 没有在 300 秒内完成。备份产物不是完成态的 60 万库。生产与真实设备没有进入这次运行。

所以项目 1 的恢复结论保持在已引用的 613 实测上，60 万 ACK 门通过，项目 3 的三组查询通过，整体 T5 未通过。
