# 调度编排复核 ec6e3f7515fd54db17bff6959d710a594a33adf6

复核对象是提交 `ec6e3f7515fd54db17bff6959d710a594a33adf6`（父提交 `13b62db9c0039539eaa5bf887486023b64abc9cf`）。结论只覆盖这个树。生产 `src` 与 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1` 的树哈希同为 `6c4da74257c63aa9797501024822c251de1e0fc8`。本次没有改提交内源码，没有 SSH，没有启动真实 24h，也没有动在跑的 1h 云 NAS 任务。

真实 24h 先不要按这个提交开跑。维护和备份的“与日批重叠”是 5 分钟循环碰巧撞上日批，不是日批一开始就强制做一次。日批只有一两分钟时，跑满 24h 后重叠断言会失败并退出非 0。这是编排漏触发，失败方向是拒收，不会把 `not_due` / `waiting_for_nas` 记成 pass。

Mac smoke 的 `pending_records=27`、`local_resource_gate=false` 是无 NAS、非 Linux 的范围界限，不是产品故障。这次 smoke 和将来的 fresh 24h 都不能充当完整 T5：成熟云库、72h 积压排空、语音 AB 仍不在本脚本里。`full_t5_pass` 固定写 `false`。

## 实跑

Node `/Users/fu-121/.local/node-v24/bin/node`，版本 v24.19.0。代码来自私有归档 `review-scheduler/archive`，blob 与该 SHA 一致：

| 文件 | git blob |
| --- | --- |
| `scripts/storage-soak-schedule.ts` | `eda6141d44579f5e3d35a9fe5dfc948bc6bb189f` |
| `scripts/storage-soak-schedule.test.ts` | `10e28e6be80de3f66e2808547fb84c5125870bb5` |
| `scripts/storage-capacity-load.ts` | `26b7e92ee8812bc2e803e7deaf8616db2a5d9c5a` |
| `docs/ark-brain-20261031/snapshot-v1.example.json` | `35f65e578e8d68671cb4590fe68ae49106a85f8c` |

从 `apps/server/scripts` 向上三级能读到归档里的快照。`node_modules` 只链到现有 server 模块。

| 运行 | exit | 证据 sha256 |
| --- | --- | --- |
| `storage-soak-schedule.test.ts` | 0 | stdout `dd4685fff95861073dadf1ef182704538821cfccd6a1cd90c660c3800d656bf0`（73 字节，与提交里的 `soak-schedule-green.log` 相同） |
| `T5_SOAK=1` 且 `T5_DEVICES=3` | 1 | stderr `8198e2fb0ae0485e4d1665b87184f57c01edd232f1f285e1f4e13a70e7aeb3df`。15 秒内自行退出，停在 50×6000 断言，没有进入 24h 等待 |
| smoke：`T5_SOAK_SMOKE=1 T5_DEVICES=3 T5_EVENTS=200 T5_MAINTENANCE=1 T5_BACKUP=1 T5_ARK_HISTORY_INDEXES=1 T5_ROLLUP_PREFIX_INDEX=1` | 0 | stdout `0ea0e297985e05ff8b0bc1f566511088477a740577cc9b897be8ac918c0f8e63`；`SOAK-RESULT.json` `ed327fcd040ebd87f5ccafd04ffed51e3f7afa470c37c6a3b5630050a7736414`；`RESULT.json` `46e2503d284bad814ce65f8cec254f4cf9cd6f015ff22e67872baaae5d08ab98` |
| 无 soak 的 2×200 旧路径 | 0 | stdout `64a65f74d59137f469ec9d3d9d745ca83546b885c9300833be642e12db3bf336`；`RESULT.json` `0ecb49b93156aef44e1bb25624098bd3f613ede092ff486f05b4364d14ecae58`。无 `SOAK-RESULT.json`，`backup_exit=0` |

计划探针（`plan-edges.json`，sha256 `146ab2f478478f483bb44108a788f4179b09541d619b8ee7553cbe04fffaeb91`）：`T5_SOAK=1` 在 2026-11-18 01:00 CST 的 `durationMs=86400000`、`dailyDelayMs=79200000`；23:00 整点延迟 0；23:30 延迟 84600000；23:00 之后 1ms 延迟 86399999。smoke 的 `durationMs=17000` 且 `fullDay=false`。两个开关同时打开，以及 `now` 为 NaN，都抛 `AssertionError`。

## 提交里已经成立的门

- 真实模式时长是 86400000ms。跑完后还有 `elapsed_ms>=86400000` 断言。smoke 被互斥开关挡住，不能升成 full day。
- CST 23:00 只算下一次。日批只 `launch` 一次客户端。`T5_SOAK=1` 还要求 50 设备、6000 事件、批大小 200、截止 3600000ms、维护、备份、Ark 历史索引和 rollup 前缀索引，并且不能开 covering index。
- `continuous_ark` 时，日批客户端不写 Ark。本次 smoke 的 `arkRequests` 为空。三份当前快照是 `soak-…-0-8`、`soak-…-1-8`、`soak-…-2-8`，`family_coin` 为 8/9/10，`stardust` 为 null，`sequence` 为 9。不是日批那组 `100+actor`。
- 备份重叠只认 `state==='published'`，并且备份的开始/结束区间与日批相交。smoke 里相交的那次是 `published`，`last_offsite_backup_ms` 仍是 null。其后三次是 `waiting_for_nas`，不计入重叠。fresh spool 上同日已有收据才会 `not_due`；这次没有把 `not_due` 当成完成。
- 真实模式排空最多再等 1h，条件是 `pending_records==0` 且某次备份报告带真实 `last_offsite_backup_ms`，然后 `state='complete'` 的 `record_count` 之和必须等于接受数。脚本里没有合成 ACK。smoke 不进这段。本次库内 `pending_records=27`，complete 合计 0，published 批次记下 27 条但没有收据。
- 结束时 `clearInterval` 之后又 `await monitor()`。smoke 有 20 条资源样本，全部 `supported:false`，原因是要 Linux `/proc` 与 cgroup。
- 断言失败会非 0 退出。`full_t5_pass` 恒为 false。结果阶段名仍是 `T5_INCREMENTAL_LOAD_NOT_FULL_ACCEPTANCE`。
- 旧路径小回归：完整性完整，`dirty_days=0`，备份进程退出 0，客户端照常写一次性 Ark。

## 阻断

`archiveLoop` 每轮先导出，只有 `dailyStarted` 已经非 0 才备份，然后睡 `maintenanceIntervalMs`。真实模式这个间隔是 300000ms。维护是启动后 2s 一次，之后也是每 300000ms。日批本身在 22h 处才开始，健康时墙钟大约是 30 批 ×（请求 + 2s 间隔），约 1–3 分钟，短于 5 分钟缝。

控制流模型（不是 24h 实跑）在 `evidence/phase-model.json`：导出固定 2000ms、日批延迟刚好 22h 时，日批开始后第一次备份在 +228000ms。日批墙钟 70s、120s、180s 都碰不上；240s 才碰上。导出固定 50ms 则会碰上。所以同一套代码，相位变了结果就变。

维护模型在 `evidence/maintenance-phase.json`：假设每次维护 500ms、日批墙钟 120s，在一个 5 分钟起点里按 1 秒扫描，300 个偏移有 179 个碰不上。smoke 里维护实际大约 0.4–0.6s，而 23:00 之前分析库几乎还没有日批事件，这个假设接近真实模式前半夜。

smoke 自己重叠为 true，是因为 smoke 间隔是 5s，而这次日批墙钟是 8567ms，缝比窗口窄。它证明谓词算得对，不能证明 5 分钟真实节拍也会撞上。

最小修正：在 `dailyStarted=Date.now()` 之后、`await` 客户端之前，主动拉起一次 `maintain()` 和一次备份，并与客户端并行；和现有 5 分钟循环共用单飞锁，避免备份 `flock` 冲突。重叠判定保持现在的 `published` 加真实区间。不要把 `not_due` 或 `waiting_for_nas` 算进去，也不要新做一个调度服务。

## 不记为故障

- Mac 上 9 轮 × 3 设备 = 27 次接受，无 NAS 收据，所以 pending 停在 27，资源门为 false。`LONG-SOAK-PREP.md` 已把这写成 smoke 界限。
- smoke 出现 2 次 503 后重试成功，p95 约 199ms，ACK 门通过。这是短混合运行里的瞬时拒绝，不是这条编排门失败。
- 资源口径仍是 13b62db9 的保守工作集。非 Linux 样本直接 `unavailable`，不能用 Mac 计数冒充 24h 门。
- 当前 1h 云 NAS 断线是另一条任务。本脚本只调用既有导出、备份和维护，不调用那条 SSH 断线流程。

## 其余界限

CST 23:00 只在开跑时算一次，之后用单调钟等这段延迟。进程准备会把日批再推迟大约启动耗时，仍然只有一轮。23:00 过后 1ms 会排到下一个 23:00，这是计划函数的既定行为。

真实模式采样间隔改成 5s，而资源门仍要求相邻样本间隙不超过 10s。一次慢的 `/ready` 再叠上“正在采样就丢掉 tick”，间隙余量变小。这次 smoke 间隔是 1s，没有打出这个洞。它不是本次阻断。

`RESULT.json` 写在末尾断言之前。重叠失败时进程仍是非 0，并写 `FAILURE.json`；`full_t5_pass` 仍是 false。判读以退出码和 `FAILURE.json` 为准。

复核期间工作区相对该 SHA 又出现未提交改动，其中包括 `storage-capacity-load.ts` 的 +15/−2。那些行不在本提交里，归档 blob 仍是 `26b7e92e`。本次执行的是归档。那份未提交 diff 没有把备份或维护绑进日批窗口。
