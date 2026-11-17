# 调度修正复验 b3f77dbb1c62acbde8daa8ca10d827e6da252485

复验对象是 `b3f77dbb1c62acbde8daa8ca10d827e6da252485`（父提交 `ec6e3f7515fd54db17bff6959d710a594a33adf6`）。执行和哈希都来自私有归档 `review-scheduler-fixed/archive`，blob 与该提交一致。复验期间工作树 HEAD 变成了 `b5bb1cbf562aad44b46fed9753541c3f73f9c3a4`，那棵树没有参与运行，也没有拿它或 ec6 的 `26b7e92ee8812bc2e803e7deaf8616db2a5d9c5a` 做结论。

这次 Mac smoke 里，第一笔 `completed.jsonl` 真实 ACK 之后才出现唯一一份 `published` 分析备份。该备份的 `backupStarted`/`backupFinished`、作业自己的 `backup_started_at_ms`，以及紧随 ACK 的 `rollup_done`，都落在请求 `sent_at_ms`/`finished_at_ms` 窗口内。ACK 之前已经结束的那轮 rollup 没有被算进重叠。日批 1800 条接受、0 条重复、`dirty_days=0`。6 轮 × 3 设备 = 18 次设备查询，按 `floor(n*0.99)` 取到的 P99 就是最慢一笔 42.621ms，0 条事实或传输失败。Ark 接受 27 条，`pending_records=27`，`last_ack_ms` 与 `last_offsite_backup_ms` 都是 null，收据目录为空。`full_t5_pass` 为 false。

查询子进程在 `await` rollup 之前已经启动。这 6 轮的设备查询 HTTP 起始时刻都比同轮 `rollup_done` 晚 491–898ms，暖机的两条 reader 记录也晚于该轮 rollup 结束。进程启动是并行的，HTTP 与 rollup 同时占用在这轮没有出现。

生产 `src` 树哈希 `6c4da74257c63aa9797501024822c251de1e0fc8`，与 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1` 相同。`src/index.ts` 与 `src/ark/warmup.ts` 未改。暖机仍是现有 `AbortController` 1000ms 预算。本轮没有 SSH，没有生产操作，没有 Linux、24h、NAS 回执、语音或成熟库。

## 实跑

Node `/Users/fu-121/.local/node-v24/bin/node` v24.19.0。归档 541 个文件（`src` 218、`scripts` 285、`deploy` 34，加 `package.json`、`pnpm-lock.yaml`、`tsconfig.json` 和 `docs/ark-brain-20261031/snapshot-v1.example.json`）逐文件 `git hash-object` 与该提交一致，差异数 0。`node_modules` 只链到现有 server 模块。快照从归档脚本的 `../../../docs/ark-brain-20261031/snapshot-v1.example.json` 读到，`snapshot_id` 为 `synthetic-example-1`。

| 文件 | git blob |
| --- | --- |
| `scripts/storage-capacity-load.ts` | `6beb9dfcf9bce7c91c257870c6d576106e133f2a` |
| `scripts/storage-ark-query-load.ts` | `657eef6ee25aa8437eee939010f5faceb4c78bd3` |
| `scripts/storage-soak-schedule.ts` | `eda6141d44579f5e3d35a9fe5dfc948bc6bb189f`（与 ec6 相同） |
| `scripts/storage-soak-schedule.test.ts` | `10e28e6be80de3f66e2808547fb84c5125870bb5`（与 ec6 相同） |
| `src/index.ts` | `ad636858a13fd3d55322fe50fa50a0e0f08f8033` |
| `src/ark/warmup.ts` | `54365b3421da8c70cbbf668970cea0bd05ea6852` |
| `docs/ark-brain-20261031/snapshot-v1.example.json` | `35f65e578e8d68671cb4590fe68ae49106a85f8c` |

| 运行 | exit | 证据 sha256 |
| --- | --- | --- |
| `storage-soak-schedule.test.ts` | 0 | stdout `dd4685fff95861073dadf1ef182704538821cfccd6a1cd90c660c3800d656bf0`（73 字节） |
| `T5_SOAK=1` 且 `T5_DEVICES=3` 的形状守卫 | 1 | stderr `05465f09510b27b137fb2d1e4b302f5ed3dabbae1a9b18d24b914c12f9d6297c`（514 字节）。断言在归档脚本第 35 行，目录内 0 个文件，没有进入 24h 等待 |
| smoke：`T5_SOAK_SMOKE=1 T5_DEVICES=3 T5_EVENTS=600 T5_MAINTENANCE=1 T5_BACKUP=1 T5_ARK_HISTORY_INDEXES=1 T5_ROLLUP_PREFIX_INDEX=1` | 0 | stdout `717664980f8d08905f630cc6516af59b41ef6d588120248ee9a4b44a2ef3ad7a`（405 字节）；stderr 空。`RESULT.json` `90c95ecb22f58a07c97e24ae1981b4fcde584df15e78a4035cc3034e8beffa38`；`SOAK-RESULT.json` `0d18c69e2118fa0653ed4841115d6a05c3d93574ce10dcccfc2352f9769e2072`；`SOAK-QUERY-RESULT.json` `f005d617225873d7b509ca1f3d8d3a332f8b1e1dd328965f1fbd37813846a0ba` |

目录是 `review-scheduler-fixed/p003-t5-fixed-query-smoke`。`fullDay=false`，`durationMs=17000`。平台 darwin，资源样本 21 条，`supported` 为真的 0 条，`local_resource_gate=false`。

## 第一笔 ACK、锁和重叠

请求窗口由 `requests.jsonl` 重算：`first_request_ms=1794938932475`，`last_request_ms=1794938942126`，与 `SOAK-RESULT` 一致。`first_ack_ms=1794938932572`，落在这个窗口内。`completed.jsonl` 9 行，接受 id 1800，重复 id 0。库内 `analytics_event` 与 `analytics_event_seen` 都是 1800，`occurred_at_ms` 全部等于 `config.started_ms=1794938929781`。当前三份快照的 `captured_at_ms` 是 1794938946101 之后，晚于这个日批时间。

归档周期的墙钟区间互不重叠。ACK 之前结束的周期 `began=1794938930102` 没有 `backupStarted`。ACK 之后第一轮是 `began=1794938933521`，状态 `published`，`backupStarted=1794938933648`，`backupFinished=1794938933807`。作业内部 `source_range.backup_started_at_ms=1794938933774`，比外层启动晚 126ms，仍然在请求窗口内。随后四次是 `waiting_for_nas`，不计入重叠。磁盘上分析备份包 1 份，Ark checkpoint 6 份，收据目录 0。`pending_records=27`，等于 9 轮 × 3 设备。

维护谓词用 `rollup_done`，不用等查询结束后的 `done`。ACK 前那轮 `start=1794938932076`、`rollup_done=1794938932367`、`done=1794938933516`：rollup 在首个请求之前结束，`done` 却落在首个请求之后。重算结果是不重叠。ACK 之后那轮 `start=1794938933518`、`rollup_done=1794938933723`，整个区间在请求窗口内，并与上面那次 published 备份相交。脚本写出的两个重叠布尔与这次重算一致。

smoke 分支只要求查询样本数大于 0 且 invalid 为 0。重叠断言写在 `fullDay` 分支。这次 smoke 退出 0 记录到了重叠，全日分支本身没有执行。

## 查询

每轮维护在 `arkRounds>0` 时启动 `storage-ark-query-load.ts`，`T5_QUERY_ROUNDS=1`。6 个结果文件各 3 个设备，actor 0、1、2 都在。每轮 reader 日志 5 行：2 行 `query_id=null` 的暖机，3 行设备查询。设备样本文件保留了每一笔，包括每轮的 actor 0。6 份 `*.startup.json` 的 `warmup.status` 都是 `ready`，耗时 66.2–136.3ms，低于现有 1000ms 预算，并且没有进入 18 笔分位。

18 笔全部 `status=200`、`body_complete=true`、带数字 `service_ms`。`before_snapshot_id` 与 `after_snapshot_id` 这轮全部相同，所以“前后任一快照”没有放进第二个值。按 snapshot id 的 `round+actor` 重算，18 笔金币值都相符，`occurred_at_ms` 等于该快照时间，并且都晚于日批 `started_ms`（最早一笔金币时间 1794938932101）。慢样本是 `mixed-query-1794938933518` 的 actor 0，42.621ms，`service_ms=30.865`。6 个单轮结果的 `pass` 都是 true。

星尘和补勤卡的原始应答没有单独落盘。已核对的归档谓词把 `stardust===null` 和 `makeup_card.value===actor%4` 与金币条件写在同一个 `correct` 里，18 笔 `correct` 都是 true。结束时 `ark_current` 三行是 `family_coin` 8/9/10、`stardust` null、补勤卡 0/1/2、`source_mode=normal`。客户端 `arkRequests` 为空。

`T5_QUERY_OBSERVE=1` 时，子进程在事实和传输断言之后才跳过单轮 `result.pass`。父进程全日分支仍用 jsonl 的 `ms` 汇总断言样本数、invalid、P99、跨度和间隙。这次 18 笔都低于 100ms，跨度 16219ms，最大轮距 5003ms。这些全日阈值没有被执行。

先前 `p003-t5-soak-with-query-smoke-01` 的首笔 166.271ms、`status=null`、`history_transport_failures=1`，子进程报 `Ark query facts or transport failed`，父进程 `FAILURE.json` 是 `smoke requires actual Ark queries`，样本数 0。该目录没有 `*.startup.json`，堆栈停在当时工作树脚本第 66 行。那不是本归档 blob 的一次运行。本归档把传输断言放在 observe 判断之前，并要求 `warmup.status==='ready'`。

日批有 2 次 `503 ANALYTICS_OVERLOADED`，重试后 9 个批次成功。ACK p99 74.681ms。`analytics_dirty_day` 为 0。

## 本轮缺口

- 全日分支的 `elapsed_ms>=86400000`、资源门、两项重叠、查询样本 `>=10000`、invalid 0、P99 `<=100`、跨度 `>=23h50m`、轮距 `<=10min` 都没有执行。
- 没有注入“没有真实 ACK”或“暖机超时”的失败。形状守卫是这次实际跑到的非 0 退出。
- 0 条 ACK 时备份不会启动，这一点由源码顺序和这次“ACK 前无 `backupStarted`”支持；失败退出本身没有在这个提交上再打一次。
- 查询 HTTP 与同轮 rollup 没有同时占用。
- Linux cgroup、24h 墙钟、NAS 回执、72h 积压、语音和成熟库没有跑。
- `full_t5_pass` 固定为 false。阶段名仍是 `T5_INCREMENTAL_LOAD_NOT_FULL_ACCEPTANCE`。
