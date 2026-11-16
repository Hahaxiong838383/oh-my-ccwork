# 固定候选 4354512d 定向复验

结论：**PASS_CODE_WITH_B5_PENDING**

本结论只覆盖提交 `4354512d1258107cb539767d80edc75ba1e03124`。相对旧候选 `457ed5ae1349ba6c1795ed66750075792bc72156`，先前两条开放缺陷已关闭，归档套件在该提交的 `git archive` 上退出码为 0。没有新的代码阻断。

T2 仍未关闭。生产调度仍未切换。B5 仍未测：写报告时没有 `MATURE-ACCEPTANCE.json`。不能把本结论写成 T2 完成或生产上线。

旧报告 `REVIEW-CANDIDATE-GROK.md` / `.json` 原样保留。本次没有改源码、没有部署、没有发外部消息。

## 审查对象

| 项 | 值 |
|---|---|
| 固定候选 | `4354512d1258107cb539767d80edc75ba1e03124` |
| 旧候选 | `457ed5ae1349ba6c1795ed66750075792bc72156`（是其祖先） |
| 中间提交 | `6daf1b348c57665a46d4d4d1554c97b15c6e7a02`，`4354512d` |
| 相对旧候选 | 9 个文件，+93 / -20 |
| 归档 | `git archive 4354512d …/apps/server`，12,759,040 字节，tar 退出码 0 |
| 解压目录 | `/tmp/p003-grok-t2-4354512d/2-Projects/P003GameDemo20260513/apps/server` |
| 抽取与 git blob | 抽查的脚本字节一致，SHA-256 见下 |

审查开始时工作树干净，HEAD 就是 `4354512d`。复跑期间作者又提交了 `2183eb0cb843812582b5ca8adeac11ac1dd1d903`（2026-11-16 13:54:27 +0800，`fix(p003): prevent daily backup gaps from timer jitter`）。它只改 `storage-backup-job.py`、`storage-backup-job.test.py` 和 `IMPLEMENTATION.md`，把 `not_due` 从满 24 小时改成 CST 日历日。归档复跑用的是 `git archive 4354512d`，没有跟随这次 HEAD。`2183eb0` 不在本结论内。

带 `4354512d` 的证据与该提交一致：`CANDIDATE-4354512d.json`、`NAS-CANDIDATE-CYCLE-4354512d.json`、`CLOUD-CANDIDATE-CODE-4354512d.json`，以及 `MATURE-FIXED-CANDIDATE-START.json` 里的 `storage-mature-fixture.py`，共 45 处 SHA-256，0 处不符。关键文件：

| 文件 | SHA-256 |
|---|---|
| `scripts/analytics-maintenance.mjs` | `9c0fa35fb5b788bb257636251547b2d11fe04f931fb26d8a5fa06c64018f68e3` |
| `scripts/storage-lock.py` | `d185c9bf108a9fb0476d275c797d73e61606f6c2b8db5a7a69ce982083f54fb2` |
| `scripts/storage-backup-job.py` | `377cca0129f2bce589c432d57ba7b1afd2853e21e75b81f519a18b80cfb456e6` |
| `scripts/storage-nas-verify.mjs` | `c2028fecac834adbae196fcb3460b25bf1069a0160ec29f693d13c6ebba11e09` |
| `scripts/storage-mature-fixture.py` | `65b337a1f155bf7c9551e5f7a3fd85bb6bc3fbb43ffe90300d29317fff668d8e` |

`NAS-CANDIDATE-CYCLE-4354512d.json` 退出码 0，上传哈希与上表一致。它的 stdout 仍是 105,811,968 字节、3200 行的小包。`MATURE-FIXED-CANDIDATE-START.json` 把原先 stdout 里的 64 位十六进制标成 `container_ids_stdout`，并单独记录上传文件 SHA-256；夹具脚本哈希与 `4354512d` 一致。

## 已关闭的两项

### 1. 归档水位使用 manifest.created_at_ms

`scripts/analytics-maintenance.mjs` 在有 `ANALYTICS_ARCHIVE_ROOT` 且状态为 `published` 时，把 `last_backup_success_ms` 写成 `result.manifest.created_at_ms`。没有归档根时仍写完成时刻，keep2 路径保持原样。`waiting_for_nas` 不改已写入的水位。

集成测试现在断言两件事：新发布的水位等于 manifest 捕获时间；把同一份 payload 配上三天前的 `ready.json` 再进维护入口后，水位等于那份 `created_at_ms`。

独立探针（Node v24.19.0 调用归档树里的维护入口，内部备份进程是 `/usr/bin/python3` 3.9.6）退出码 0：

- 新发布：`created_at_ms=1794808561356`，水位相同，差 0。探针结束时距离现在 65 毫秒，水位没有跟到完成时刻。
- 三天前 ready：manifest 与水位都是 `1794549361421`，差 0。距离探针当时的现在 259,200,414 毫秒。

同一探针换上旧提交的 `analytics-maintenance.mjs` blob 后退出码 3：

- 新发布：manifest `1794808566658`，水位 `1794808566711`，差 53 毫秒。
- 三天前 ready：manifest `1794549366733`，水位 `1794808567107`。相对捕获时间晚 259,200,374 毫秒，距离当时的现在 19 毫秒。

这就是原先的归零行为。新提交上的套件断言能挡住它。

### 2. 卷标记缺失时不建锁

`scripts/storage-lock.py` 在 `os.open` 创建锁文件之前要求 `ARCHIVE_VOLUME_MARKER` 与 `ARCHIVE_VOLUME_ID` 同时存在、标记路径是绝对规范路径、普通文件、不超过 256 字节、与锁目录同设备，且内容等于卷 ID。缺任一项就返回 2。两个 NAS 入口 `storage-nas-cycle.sh`、`storage-nas-pull.sh` 仍只强制 `ARCHIVE_ROOT`，失败点在锁程序，入口本身不另建锁文件。

`/usr/bin/python3` 3.9.6 对归档树里的 `storage-lock.py` 直接调用，锁路径使用解析后的绝对路径：

| 条件 | 退出码 | 锁文件 |
|---|---|---|
| 两个变量都缺 | 2 | 未创建 |
| 只有卷 ID | 2 | 未创建 |
| 只有标记路径 | 2 | 未创建 |
| 两个都有，标记文件不存在 | 2，stderr `ARCHIVE_LOCK_FAILED` | 未创建 |
| 标记内容不符 | 2 | 未创建 |
| 标记内容相符 | 0 | 已创建 |
| `storage-nas-cycle.sh`，只有 `ARCHIVE_ROOT` | 2 | `.cycle.lock` 未创建 |
| `storage-nas-pull.sh`，只有 `ARCHIVE_ROOT` | 2 | `.pull.lock` 未创建 |

套件里的新测试 `test_nas_entries_require_volume_config_before_creating_lock` 覆盖两个 shell。把锁程序换回 `457ed5ae` 的 blob、保留新测试文件后，`python3 scripts/storage-lock.test.py` 退出码 1：6 个测试里 1 个失败，失败点就是该断言，锁文件已被创建。其余 5 个仍通过。新提交上这 6 个测试退出码 0。

`NAS-PYTHON27-EXACT.json` 退出码 0，stdout 写明 `/usr/local/bin/python` 为 `2.7.18 (default, Aug 27 2025, 08:23:16)`，以及 `PASS native Python2.7 kernel mutex acquired/busy3/released`，stderr 有 `ARCHIVE_JOB_BUSY`。这补上了前审“证据里没有 Python 2.7 字符串”的缺口，范围是互斥锁获取、忙返回 3、释放。该文件没有缺失标记的退出码。`NAS-VOLUME-4354512d.json` 的摘要行写了 Python 2.7 有效守卫和缺环境拒绝，并附有 6 个测试 OK；测试文件使用 `pathlib` 和 `subprocess.run`，本次本地复跑是 CPython 3.9.6 / 3.12.2。新守卫源码没有 f-string，沿用文件顶部的 Python 2.7/3 写法。我没有在 NAS 的 2.7 进程里重放缺标记路径。

## 独立套件

```
PATH=/Users/fu-121/.local/node-v24/bin:$PATH npm run test:archive-complete
```

- 工作目录：上述归档解压后的 `apps/server`
- 开始：`2026-11-16T05:55:47Z`
- 退出码：0
- 耗时：13.12 秒
- Node：`/Users/fu-121/.local/node-v24/bin/node` v24.19.0，npm 11.17.0
- 套件 `python3`：`/opt/anaconda3/bin/python3` 3.12.2（SQLite 3.46.0）
- 维护入口硬编码 `/usr/bin/python3`：3.9.6（SQLite 3.51.0）

| 命令 | 结果 |
|---|---|
| `scripts/storage-archive.test.py` | 7 tests OK，0.135 秒 |
| `scripts/storage-nas-verify.test.mjs` | PASS |
| `scripts/storage-lock.test.py` | 6 tests OK，4.216 秒 |
| `scripts/storage-backup-job.test.py` | 6 tests OK，0.392 秒 |
| `scripts/analytics-backup.test.py` | 7 tests OK，0.161 秒 |
| `scripts/storage-nas-retention.test.mjs` | PASS |
| `scripts/storage-maintenance-integration.test.mjs` | PASS，含捕获时间相等和三天前 ready |

`4354512d` 与 `457ed5ae` 的源码差异只在维护入口、锁、备份作业计数、NAS 校验计数、夹具 `--resume`、对应测试和两份文档。`src/` 下的摄入、查询和索引定义不在这个差异里。

## 顺序计数：等价与有界

离线三处改成同一条 SQL：`SELECT count(1) FROM "<table>" NOT INDEXED`。

- `storage-backup-job.py` 在副本上统计 manifest 行数
- `storage-nas-verify.mjs` 按 manifest 回读
- `storage-mature-fixture.py` 用它决定续建偏移和最终计数
- `D/mature_acceptance.py` 的只读核对也是这一条，缓存仍是 `PRAGMA cache_size=-131072`（128 MiB）。该文件不在 git 候选里；其 SHA-256 与 `MATURE-FIXED-CANDIDATE-START.json` 记录的上传哈希一致

`count(1)` 统计行。`count(*)` 也统计行。`count(可空列)` 会跳过 NULL，二者不相等。表名仍限制为 `[a-z][a-z0-9_]{0,63}`。当前 analytics DDL 是普通 rowid 表，主键是复合 PRIMARY KEY，没有 `WITHOUT ROWID`。`NOT INDEXED` 走表扫描。无 WHERE 的 `count(*)` 可以走覆盖索引。

作者实测，我没有重开那份正在生成的库：

| 证据 | 顺序 | 查询 | 秒 | 结果 | 计划 |
|---|---|---|---|---|---|
| `COUNT-BENCHMARK-READBACK.json` | 先索引 | `count(*)` | 164.49936864711344 | 27000000 | `USING COVERING INDEX sqlite_autoindex_analytics_event_seen_1` |
| 同上 | 后扫描 | `count(1) … NOT INDEXED` | 18.99098933674395 | 27000000 | `SCAN analytics_event_seen` |
| `COUNT-BENCHMARK-REVERSED.json` | 先扫描 | `count(1) … NOT INDEXED` | 18.60159501247108 | 27000000 | `SCAN analytics_event_seen` |
| 同上 | 后索引 | `count(*)` | 157.78246598877013 | 27000000 | 同上覆盖索引 |

四次都是 27,000,000，等于 50×6000×90 的 `analytics_event_seen`。作者说明没有清 OS cache。反向顺序里，扫描先跑仍然约 18.6 秒，索引后跑仍然约 158 秒，所以快慢不是“谁排在第二”造成的。这是 seen 表。`analytics_rollup_fact` 的 54,000,000 行不在这四次里。

本地补充（`/usr/bin/python3`，SQLite 3.51.0，8000 行，其中 1600 个 `event_hash` 为 NULL，另有二级索引）：

- `count(*)` = `count(1) NOT INDEXED` = 8000
- `count(event_hash)` = 6400
- progress handler 固定返回 1、每 100 个 opcode 调用：`count(1) NOT INDEXED` 第一次回调就抛出 `OperationalError: interrupted`
- 同一设置下 `count(*)` 回调次数为 0，查询完成且没有中断

因此 `count(1)` 能进入 SQLite 进度回调，既有的 `count(*)` 覆盖索引路径可以不进入。备份作业把回调挂在复制、计数、哈希共用的 monotonic deadline 上；超时返回 1。计数发生在写入 `ready.json` 和 `publish_prepared` 之前，中断进入 `failed` 并返回 `BACKUP_JOB_FAILED`，不会发布半成品。状态文件写入仍按 5 秒节流。

预算公式没有改：`min(7200, max(300, ceil(180 + 2 * size / 16MiB/s)))`。计数多一次顺序读，并且可以被这条 deadline 打断。它没有把上限放宽到 7200 秒以上。90 天库的复制、计数、哈希能否一起落在预算内，要由 B5 实测，不在本次用小库套件外推。

NAS 校验的 `count(1)` 没有安装 sqlite progress handler。`storage-nas-verify.mjs` 仍把缓存设为 128 MiB。它的有界性来自外层作业超时（锁默认 7200 秒，验收脚本对 node 也是 7200 秒）以及这次改成顺序扫描。`PRAGMA integrity_check` 仍是全库检查，不在这次计数改动新加的回调里。

## 夹具 --resume

`storage-mature-fixture.py` 的默认规模仍是 50、6000、90。`--resume` 只在目标已存在时使用。它核对 progress 里的 `synthetic/devices/events_per_day/days`、`sqlite_master` 的表 SQL，并用 `count(1) NOT INDEXED` 要求已提交行数等于目标或是 10000 的整数倍。`PRAGMA journal_mode=DELETE`，每 10000 行提交一次。索引按名称跳过已存在项。tier 行是 `INSERT OR IGNORE`，主键是 `(device_key, client_event_id)`。

用 `D/mature-schema.json`（6932 字节）在本地做了 1×10000×1，退出码 0：

- 函数默认值 50 / 6000 / 90
- 首次：seen 10000，fact 20000，event 10000，batch 50，phase `complete`
- 再次 `--resume`：计数不变
- 已存在且不带 `--resume`：`FileExistsError`
- 改 progress 的 devices：`fixture_resume_scale_mismatch`
- 删掉一行：`fixture_resume_count_mismatch`
- 加一张模式外的表：`fixture_resume_schema_mismatch`

这不替代 50×6000×90。写报告时 `MATURE-PROGRESS-14.json`（文件时间 2026-11-16 13:54 +0800）仍是 `phase=generate`，`analytics_rollup_fact` 34,680,000 / 54,000,000，`devices=50`，`events_per_day=6000`，`days=90`，`started_at_s=1794803943.1209075` 与修复前同一起点。固定候选重启之后行数从约 20,260,000 继续增加，说明这次续建没有在模式或规模校验上立即失败。生成未结束。

`PRAGMA temp_store=FILE` 在夹具内。`SQLITE_TMPDIR=/data/tmp` 在 `D/restart_mature_fixed.py` 的容器参数里，同时 `--tmpfs /tmp:size=128m`，数据卷是 `/share/CACHEDEV2_DATA/p003-archive/t2-complete-20261116/mature` 挂到 `/data`。该启动脚本没有 `mkdir /data/tmp`。夹具缓存从 128 MiB 改为 `cache_size=-524288`（512 MiB），容器内存限制是 768 MiB。NAS 校验和验收核对仍是 128 MiB。索引阶段还没出现在进度里。

## B5

保持未测。验收脚本要等 progress `phase=complete`，再跑 Backup API 和 NAS finalize/restore，超时分别是 7260 秒和 7200 秒。当前没有 `MATURE-ACCEPTANCE.json`。最新进度仍在生成 fact 表。不把小包 cycle、27,000,000 行计数或本地 1×10000×1 续建写成 B5 通过。

## 剩余问题

1. B5 未测。90 天库的 Backup API、NAS 校验和恢复还没有验收回执。T2 与生产上线都还要等这份回执之后的另一次放行复核。
2. `2183eb0` 未复跑。它改了备份作业的“次日是否到期”判断，不在 `4354512d` 的归档套件里。
3. 27,000,000 的四次计时只覆盖 `analytics_event_seen`。fact 表 54,000,000 行没有同一份双向计时。等价结论来自行计数语义、两边使用同一条 SQL，以及 seen 表的实测同值。
4. NAS 校验计数没有 sqlite progress handler。备份作业有，并且本地探针确认 `count(1) NOT INDEXED` 会被回调打断。套件没有一条把备份作业的计数阶段单独打到 deadline 的用例。
5. `SQLITE_TMPDIR=/data/tmp` 是否已在 NAS 卷上建目录，D 里没有目录证据。512 MiB 页缓存处在 768 MiB 容器限制内，索引阶段尚未观察到。这两项留给正在跑的夹具，不构成当前源码阻断。
6. Python 2.7 的精确证据是互斥锁获取、busy 3、释放。缺标记直接失败的复跑是本地 CPython 3。

没有新的代码阻断。
