# 小范围独立复核

结论：**PASS_SCOPED**

固定 HEAD：`1a0ed70330fce2ddfc95e0ec86083f4313f9cfb9`  
测试日志 SHA-256：`4690851dc38d6dc6870dfc6d5f712e5e7cd508df52253ae72a207d045d96d11e`  
P0：无。P1：无。

工作区干净，HEAD 等于上述提交（`test(p003): enforce cgroup headroom and record NAS restore`）。只审了 `apps/server/scripts/storage-load-resources.ts` 与同目录 `.test.ts`，并只比对下面四份证据。未改主源码，未 SSH，未重开代理，未把历史三次封装启动失败重新打开。

## 限制

- 资源门单测是加速计数器。日志原文写明 accelerated only, not 24h。本结论不包含 24 小时实机采样。
- 数据是已停写的合成导出：`export_mode=closed_synthetic_db_adoption`，事件行 600000，18 表合计 3009408 行。在线 BackupAPI、成熟混合负载、全 T5 不进入本结论。证据内 `full_t5_pass=false`。
- 证据自带字符串 `PASS_FINAL_600K_REAL_SSH_NAS_RESTORE`。本复核不以该字符串为结论。
- 真实 1 小时断线在 `outage-observation-01.json` 仍为运行中：`ActiveState=active`，`MainPID=2445221`，两轮，`accepted=100`，`last_ack_ms=null`。该文件只被用作源收据 ACK。其中 guard 的 `production_ready=true` 是磁盘探针字段，不构成断线通过。
- 归档正文未在本范围重算 SHA。七处记录的 SHA-256 与字节数一致。
- NAS 恢复 inode 不同，由独立 stdout 的 `distinct_inodes=true` 与 `NAS-FINAL-VERIFIED.json` 的同值标志互相绑定；四份文件没有两个 inode 数值，本复核没有重算不等式。
- 传输、校验、恢复只有一段 supervisor 墙钟。本地 `elapsed_s` 是另一段本地精确恢复。
- `source.json` 未打开。证据自己写明 `mtime_ns` 有 JS 舍入，权威校验是完整载荷哈希。
- 最终 supervisor `exit=0`、`timed_out=false`。更早的缺 nohup / Python argv / volume marker 启动失败不在本次判断内。

## 任务 A：cgroup 配额门

命令（cwd 为 `2-Projects/P003GameDemo20260513/apps/server`）：

`/Users/fu-121/.local/node-v24/bin/node --import tsx scripts/storage-load-resources.test.ts`

Node `v24.19.0`，退出码 0。stdout 209 字节，stderr 为空。日志 SHA-256 见上。stderr 空文件 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。

源文件 SHA-256：

- `storage-load-resources.ts`：`96ec2aa6853e899c42196e52a5b7f0e005c01bc97b6009021c7230e8dc0b09d1`（git blob `eaf368f62fc832ee03781dee8dd5847481989ff5`）
- `storage-load-resources.test.ts`：`dab3c7726f647af075692a864e1e8bf681e22c41c03a37fd975b7f0a9ebf4fab`（git blob `05cff486ea452dc491290dd6c4872e40f8c60138`）

相对父提交，原门保留：`requiredMs>=86400000`、`elapsed>=requiredMs`、`maxGap<=10000`、`unavailable===0`、`avg<70`、`minMemory>=0.2`、`minDisk>=4.5*1024**3`、OOM/OOM-kill 相对首样本上升即失败、身份字段仍含 `pid`（并保留 `boot_id` 与 `cgroup`）。新增项只加严。

整机 CPU 与单核占用都会放过小配额饱和。独立复算 `quota-cpu`：整机平均 10%，单核平均 40%，配额平均 80%，`complete_24h_evidence=true`，`local_resource_gate=false`。门使用 `cgroup_cpu_average_quota_percent`，分母是 `cgroup_cpu_quota_cores`。

| 场景 | 整机 CPU | 配额 CPU | 组内存峰值 | 身份变化 | groupMissing | 门 |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| quota-good | 10 | 20 | 0.8 | false | 0 | 通过 |
| quota-cpu | 10 | 80 | 0.4 | false | 0 | 关闭 |
| quota-cpu-boundary | 10 | 70 | 0.4 | false | 0 | 关闭 |
| quota-memory | 10 | 20 | 0.801 | false | 0 | 关闭 |
| quota-missing | 10 | null | null | false | 8641 | 关闭 |
| quota-zero | 10 | null | null | false | 8641 | 关闭 |
| quota-changed | 10 | 20 | 0.4 | true | 0 | 关闭 |
| memory-limit-changed | 10 | 20 | 0.4 | true | 0 | 关闭 |

配额 CPU 是严格 `<70`：闭式结果 70，`70<70` 为 false。组内存是 `<=0.8`：`800/1000===0.8` 通过，`801/1000=0.801` 关闭。配额 `null` 或 `0` 使 `groupValid` 失败并令 `groupAvg=null`。配额或内存上限相对首样本变化令 `identity_changed=true`，`complete_24h_evidence=false`。

配额变化后的百分比仍用第一份 `cgroup_cpu_quota_cores` 做分母，所以 `quota-changed` 的配额平均仍显示 20；门由身份变化关闭。

指定测试同时锁住原失败类：`oom`、`restart`、`low-memory`、`high-cpu`、`disk-low`、`missing`、`group-missing`、`gap`、`short` 的 `local_resource_gate` 均为 false，只有 `good` 为 true。`summary(3600000)` 的 `complete_24h_evidence` 为 false。

## 任务 B：四份证据

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `NAS-FINAL-INDEPENDENT.json` | 2468 | `6d67d7037f6eefbabc09423a600b73846c00f8116e1a42704d85e72480073e29` |
| `NAS-FINAL-VERIFIED.json` | 1437 | `8e9aaf8db79e4ba523cbb943f34640a117e0fbe73db893f73d5986797d64f0ae` |
| `outage-observation-01.json` | 1376 | `678a106a23898a0175c3c00f4943b69022d8b3202959c0f31d8268599e1f3fc7` |
| `LOCAL-FINAL-RESTORE.json` | 8530 | `b90c4a5cfc32bdb513cb8ecfc1188eea5e4b63af691d4c0df04f4c91c72e644d` |

`proof_sha256` 等于 `NAS-FINAL-INDEPENDENT.json` 的文件 SHA-256。

载荷 SHA-256 七处相同：`e9b94f0bcb9609247176f6ac4a8ca26ccbccbcc358c3e43d0b8e520be9615154`（本地 `source_sha256`、VERIFIED、manifest、manifest 内收据、restore、`independent_restore_sha256`、断线观察里的源收据）。字节数七处都是 `2124611584`。

archive id 五处相同：`831209708dec4da38494638fde3416fc`。runtime/candidate 三处相同：`b1ce23aecf2a699c55f81942c76ee05ca48fa5f1`。

源收据与断线观察收据逐字段相同：`verified_at_ms=1794932739348`，`record_count=3009408`。restore `integrity_check=ok`。本地 `integrity_check=ok`（SQLite 3.53.3），scope 为 `LOCAL_EXACT_RESTORE_NOT_NAS_PRODUCT_FLOW`。

18 表在本地 counts、VERIFIED tables、manifest `source_range.tables`、`independent_counts` 中键集合相同、逐表相等、无缺表无多余表。合计 3009408，与 manifest、收据、restore、断线收据的 `record_count` 相同。`events=600000` 只等于 `analytics_event`。

| 表 | count |
| --- | ---: |
| analytics_batch | 3000 |
| analytics_day | 2 |
| analytics_device_day | 100 |
| analytics_diagnostic_usage | 0 |
| analytics_dirty_day | 0 |
| analytics_event | 600000 |
| analytics_event_seen | 600000 |
| analytics_meta | 6 |
| analytics_rollup_device_stage | 100 |
| analytics_rollup_distinct | 200 |
| analytics_rollup_fact | 1200000 |
| analytics_rollup_retry | 0 |
| analytics_rollup_source | 100 |
| analytics_settlement | 600000 |
| analytics_tier_day | 2850 |
| analytics_tier_event | 0 |
| analytics_transport | 3000 |
| analytics_transport_day | 50 |

NAS supervisor：`started_at_ms=1794932531583`，`finished_at_ms=1794932906934`，差 `375351` ms，等于 `transport_verify_restore_elapsed_ms`。外层 `exit=0`，内层 `supervisor.exit=0`，`timed_out=false`。stderr 只有 Node SQLite ExperimentalWarning。收据时间落在该窗口内（开始后 207765 ms，结束前 167586 ms）；证据没有把这两段命名为传输和恢复。本地恢复耗时 `153.45480108261108` s。

断线观察 `at_ms=1794932967117`，在 supervisor 结束后 60183 ms。单位仍是 `ActiveState=active`。
