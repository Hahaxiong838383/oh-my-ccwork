# T2 B5 成熟大库耗时只读复核

结论：**COPY_STATUS_STALE_DURING_INTEGRITY_SCAN**。子进程在读 `snapshot.partial`，状态机停在 `copy remaining_pages=30892` 与正在做的工作不一致。这是 Backup API 进度回调已经停更、`PRAGMA integrity_check` 的 B-tree 扫描尚未回到 VDBE 进度回调的可观测性缺口，叠加一次真实的全库扫描。现有探针支持磁盘读等待，不足以支持死锁结论。

本结论 **不等于 B5 通过**，**不等于要立刻改实现**，也 **不是成熟夹具的替代品**。写报告时最后一份本地监视仍是 `phase=backup`、`state=building`、预算 5530 秒尚未用尽。主 13 继续跑完。2 小时硬上限保持 7200/7260。未 SSH、未改代码、未碰生产、未杀进程、未对 42GB 库做新测试。

## 审查身份

| 项 | 值 |
|---|---|
| 模型 | Grok 4.6 |
| 固定候选 | `2183eb0cb843812582b5ca8adeac11ac1dd1d903` |
| HEAD | 与固定候选相同。`fix(p003): prevent daily backup gaps from timer jitter`，2026-11-16 13:54:27 +0800 |
| 工作树 | 业务脚本与候选字节一致。`T3_HANDOFF.md` 有未提交的「实施定稿」；`T3_REVIEW_RESOLUTION.md` 未跟踪。`ROLLBACK.md` 有未提交改动，本次未读、未改 |
| 范围 | `analytics-backup.py`、`storage-backup-job.py`、`storage-nas-verify.mjs`、`storage-archive.py`、`mature_acceptance.py`、D 下探针/状态、SQLite 3.40.1 / 现行文档与源码、本地 8000 行隔离实验 |
| 未做 | 未 SSH，未改实现，未中断容器 `p003-t2-mature-acceptance-final-20261116`，未把建议写成验收通过 |

## 能证实

1. 夹具 `50×6000×90`，15 表，行数合计 89,442,002，源文件 44,871,368,704 字节。`total_pages=10,954,924`，`10954924×4096=44871368704`，与 `snapshot.partial` 字节数相同。
2. 备份任务预算 `budget_seconds=5530`，由 `min(7200, max(300, ceil(180+2×size/16MiB)))` 算出。硬上限仍是代码里的 7200，以及夹具外包的 7260/7200。
3. 探针 1：`snapshot.partial` 在 11-16 14:30 已是完整 44,871,368,704 字节；stderr/日志最后一条 Backup API 进度是 `copy remaining_pages=30892`。
4. 探针 2–4：工作进程 PID 30529 状态 `D`，`VmSize=152200` KiB；`write_bytes=44871700480`、`wchar=44871378754`、`syscw=10955005` 三次相同；`rchar`/`syscr`/`read_bytes` 持续增加。
5. 探针 3/4：当前系统调用 `17`，第一个参数 `0x5`，长度 `0x1000`。fd 5 的路径是 `/data/backup-spool/backup-work/snapshot.partial`。Linux x86_64 上 syscall 17 是 `pread64`，一次读 4096 字节，即一页 SQLite 页。
6. 最后一份本地监视 `MATURE-MONITOR-1794811708.json` 仍是 `progress.phase=copy, remaining_pages=30892`。相对探针 1 的 `at_s=1794810982` 已过 726 秒。`storage-backup-job.py` 的状态节流是 5 秒，这个窗口远大于节流。
7. `_copy_checked` 先 `src.backup(..., progress=copy回调)`，再 `dst.execute('PRAGMA integrity_check')`。Backup API 的 `progress` 与 `set_progress_handler(integrity_progress, 10000)` 是两条通道。`integrity_progress` 一旦进入 `on_progress`，状态应变为 `phase=integrity_check`。
8. 隔离 Python 镜像安装了 `libsqlite3-0 3.40.1-2+deb12u2`（`PYTHON-IMAGE-BUILD-LOCAL.json`）。SQLite 3.40.1 的 `vdbe.c` 里 `OP_IntegrityCk` 一次调用 `sqlite3BtreeIntegrityCheck`；同版本 `btree.c` 中没有 `checkProgress` / `xProgress`。官方文档：`sqlite3_progress_handler` 按 **虚拟机指令** 计数。
9. 本地 CPython SQLite **3.46.0** 小库实验（8000 行，790,528 字节，非成熟库）：`EXPLAIN PRAGMA integrity_check` 含 `IntegrityCk`；`set_progress_handler(n=1)` 在 integrity_check 上 80,238 次，在 `count(1) NOT INDEXED` 上 24,010 次。3.46 的 btree 层已有按页 `checkProgress`。该实验证明现行 SQLite 会回调，**不能**外推到容器里的 3.40.1。
10. NAS `finalize` 对 `analytics_backup` 做 SHA + `PRAGMA integrity_check` + 全表 `count(1) NOT INDEXED`。`rotateBackups` → `restoreCheck` 在首次恢复时再做源 SHA、`copyFileSync`、目标 SHA、再一次 `verifyRows`。云端 `publish_prepared` 对已关闭快照是同卷 rename，不再整库拷贝，但会再 SHA 一次。
11. 夹具备份外包 `timeout=7260`，NAS finalize+ack+rotate 另起 `timeout=7200`。两段预算不共用。传入 NAS incoming 的 payload 用硬链接，避免再传一份 42GB。
12. 业务三脚本与候选 blob SHA-256 一致，见文末表。

## 仅推断

1. 14:30 文件写满之后，Backup API 复制已经结束；`remaining_pages=30892` 是 5 秒节流留下的最后一条 copy 回调，`remaining=0` 的那一次被节流丢掉。随后进入 `PRAGMA integrity_check` 的 `OP_IntegrityCk`。
2. 容器 Python 使用镜像里的 3.40.1。该版本在 B-tree 扫描内部不调用进度回调，所以 `integrity_progress` 在扫描结束前不会跑，状态一直停在 copy，内层 5530 秒 deadline 也要等这个 opcode 返回才可能触发。外层 7260 秒仍由 `subprocess.run` / `timeout` 进程约束。
3. `rchar` 在探针 2→3 约 134 秒增加 3.04GiB，3→4 约 84 秒增加 2.03GiB。这是扫描速率样本，不是剩余时间公式。504MB 试验在 128MiB 缓存下约 40.7 秒；42GB 缓存比约 0.3%，不能按比例外推为 B5 失败。
4. 扫描结束后，integrity_check 还会用 VDBE 做索引条目数/亲和性核对，那时 3.40.1 的进度回调会开始出现，`phase` 才可能变成 `integrity_check`。再往后才是可中断的全表 count 与两次 SHA。
5. 未在运行中的容器执行 `SELECT sqlite_version()`。3.40.1 来自镜像构建日志，不是进程内探测。

## 任务 1：状态为何可停在 copy

复制阶段的进度来自 `sqlite3.Connection.backup(..., progress=)`，按剩余页更新。校验阶段的进度来自 `set_progress_handler`，按 VM 指令更新。`PRAGMA integrity_check` 的主体是单条 `IntegrityCk` 指令，内部 `sqlite3BtreeIntegrityCheck` 按页 `pread` 目标库。

因此状态停在 copy 同时包含：

- **可观测性**：节流 5 秒、copy 回调在 backup() 返回后不再触发、3.40.1 在 IntegrityCk 内部不进 Python 回调，`backup-status.json` 会长时间显示过期的 copy。
- **真实工作**：目标文件上持续 4KiB `pread`、`rchar` 增加、`write_bytes` 冻结、进程 `D`、容器 RSS 约 157MiB / 512MiB。这是在读已经写完的备份镜像，不是锁等待。

只有可观测性修复（在 `PRAGMA` 之前写入 `phase=integrity_check`）不会缩短扫描。内层 deadline 在 3.40.1 的 IntegrityCk 期间同样看不见。外层 7260 秒仍然有效。不把 2 小时上限改掉来处理显示问题。

## 任务 2：finalize / rotate 是否重复完整校验

**会。** 同一份 SHA 字节在夹具路径上的完整 integrity+count 次数：

| 阶段 | 引擎 | 完整 integrity_check | 全表 count | SHA |
|---|---|---|---|---|
| 云端 `_copy_checked` | Python / libsqlite3 3.40.1 | 是，对 `snapshot.partial` | 否（在 rename 之后另做） | 随后一次，publish 再一次 |
| NAS `finalize` → `verifyRows` | Node 22 `node:sqlite` | 是，对 incoming/packages payload | 是 | finalize 前一次 |
| NAS `restoreCheck`（无 `latest.json` 命中） | 同一 Node | 是，对 `restore/next.partial` 副本 | 是 | 源一次 + 副本一次 |

`restoreCheck` 在 `archive_id`+`sha256`+`latest.sqlite3` 已存在且大小相符时会跳过。首次成熟恢复没有这份标记，所以会整文件 `copyFileSync` 后再跑一遍 `verifyRows`。

云端 Python 的 integrity_check 与 NAS Node 的 integrity_check 不是同一 SQLite。Node 22.19.0 自带的 `node:sqlite` 与 Debian `libsqlite3-0 3.40.1` 不是同一个库。NAS finalize 仍是离线侧独立引擎核对，这一次要保留。

### 若后续真实预算失败：最小应对（不实施）

只在 **同一引擎已经对某 inode/字节做过 `verifyRows` 且副本 SHA-256 与那份已证实 payload 相同** 时，允许跳过副本上的第二次 `verifyRows`。夹具里就是：`finalize` 已经 ok 的 payload，`restoreCheck` 拷出来的 `next.partial` 再哈希相等。

仍必须做：字节数、源 SHA 或目标 SHA 与 `manifest.sha256` 一致、`copy`/`fsync`/`rename`、失败则拒绝。不提高 7200、不用 `quick_check`、不加大 cgroup、不换新服务。

### 必须防的反例

1. 副本 SHA 与 payload / manifest 不一致，包括短写和静默损坏。
2. 只比大小、不比 SHA。
3. 把云端 Python 3.40.1 的 `ok` 直接当作 NAS Node `verifyRows` 通过。
4. 跳过 **第一次** NAS `finalize.verifyRows`。
5. 跳过云端 `_copy_checked` 里对备份目标的 integrity_check。
6. payload 在 finalize 之后被写入；或出现非空 WAL。
7. `archive_id` / `kind` / `record_count` / `source_range.tables` 与当时那次 `verifyRows` 不是同一份 manifest。
8. 用 `quick_check`、抽检、mmap 整库或把隔离内存升到 512MiB 以上来换时间。
9. 把「跳过第二次 verifyRows」写成 B5 通过，或用它替换 50×6000×90 夹具。
10. 硬链接恢复副本后仍允许写 payload；共享 inode 的后续变异会同时污染归档和恢复文件。

当前备份段若死在 **第一次** IntegrityCk，上述 NAS 复用帮不上。那时只记录实测耗时，等外层 7260 秒说话。现在未超预算，不为假设改实现。

## 任务 3：T3 实施定稿六点收敛

审查对象是工作树 `T3_HANDOFF.md`（SHA `7379c549…`，10098 字节）和未跟踪的 `T3_REVIEW_RESOLUTION.md`（SHA `71aa0b39…`，1693 字节），对照上一份 Grok 4.7 报告（候选内 T3_HANDOFF 仍是 `9b979249…` / 5760 字节）。未重做 T3 全文审查。T3 仍未实现。

| 上一报告建议 | 定稿 | 是否新阻断 |
|---|---|---|
| 与上一条 outbox 比 | ACK 清正文后保留轻量基线（received_at_ms + 语义字段签名） | 无。这是上一报告按「上一条 outbox」落地时的必要修正 |
| JSONL 直接写 snapshot | 版本化封套：身份、内部序号、接收时间、body_hash、完整 snapshot | 无。归属隔离验收需要封套 |
| 8GiB 只数 outbox 正文 | 加上生成中/待发副本和磁盘预留 | 无。收紧预算，避免假接受 |
| 关闭即停导出器 | 关闭只停新增，已 accepted 积压继续补送/确认 | 无。否则已接受记录被永久搁置 |
| 关闭仍显示 `not_implemented` | 后台显示关闭/积压；设备接口与原字段兼容 | 无。故障矩阵「关闭时旧返回值」约束设备 `/state` 与 accept 码，不要求管理面永远假称未实现 |
| list 完全不变 | 先源端 GC、SQL LIMIT、20 包队列；真积压再最小兼容分页 | 无。未预建索引服务，也未把分页挤进 T2 |

**新阻断：无。** 定稿仍禁止 GM 鉴权、设备历史 API、新服务、OTA，以及用 T2 大库备份冒称 50 台接收或语音通过。

## 对主 13 的口径

继续跑当前 B5。未超 5530/7260 时不要为状态停在 copy 改代码。若备份段在 IntegrityCk 内被 7260 杀掉，先记下 `rchar`/耗时再决定是否只加 `phase=integrity_check` 的状态写入。若备份成功、NAS 段在第二次 `verifyRows` 超时，再考虑「SHA 相同则复用已证实 integrity」，并带上上面的反例测试。任何优化通过都不能改写本次尚未结束的 B5 结果。

## 读文件 SHA-256

路径相对仓库根，除非标明 D。哈希覆盖全文件。

| SHA-256 | 字节 | 文件 |
|---|---:|---|
| `28a018c89259187ea0e1d90e37e3f838daf5a903ecc3ee5bbd518b87ee031e2b` | 6989 | `2-Projects/P003GameDemo20260513/apps/server/scripts/analytics-backup.py`（与 2183eb0c 一致） |
| `5e61efcb141ca6831b4ee64d8e88b1374d6b338c9c0548db1ced7c2b596d20db` | 6936 | `scripts/storage-backup-job.py`（与 2183eb0c / CLOUD-JOB 一致） |
| `c2028fecac834adbae196fcb3460b25bf1069a0160ec29f693d13c6ebba11e09` | 15029 | `scripts/storage-nas-verify.mjs` |
| `d782dd5708cdeb0ed12629d8b3e6535306b9839da2917921527966cb2185e8fe` | 11569 | `scripts/storage-archive.py` |
| `9b9792498e26b95b6179e6389393437f83bae284b01a45d5a2ec11bf9adf465b` | 5760 | 候选内 `T3_HANDOFF.md` |
| `7379c549618417e76c0cc98a7fd6c1f57611e93ad3a8687dc90ac5f5ccbb1cdd` | 10098 | 工作树 `T3_HANDOFF.md`（实施定稿） |
| `71aa0b39e73b3d9225da3cd5c6f47a72b92d6fdf39022c7ced3c8d944ad60d84` | 1693 | 工作树 `T3_REVIEW_RESOLUTION.md` |
| `aa11f8d98425be21dd6f09435f9a75a80683d27368cf9f2c2a816759b9afade9` | 1697 | D/`MATURE-BACKUP-IO-PROBE-1.json` |
| `8136281efe55b0ca61514d79b004d282bad7517d4c9576b5f4df7e9ea7a19e99` | 1089 | D/`MATURE-BACKUP-IO-PROBE-2.json` |
| `b61af5aea1a47e83a2757b4a21a5e46297901dfbc8cf0c426a3dd5ca35f682d3` | 775 | D/`MATURE-BACKUP-IO-PROBE-3.json` |
| `765258ecb6d594d273700d03858ad2d906b6c1336207194de0ed10e8b826691b` | 663 | D/`MATURE-BACKUP-IO-PROBE-4.json` |
| `ed2ded4e8ac82bc0d583d6262584af7ac5454bf7231d442ef72b82f54a56f5b2` | 11360 | D/`MATURE-STATUS-1794810448.json` |
| `cdbf5283a7dd686c036e50993d8ea65301fadb536ce3c763a794d7c4f3069d86` | 11277 | D/`MATURE-MONITOR-1794811708.json` |
| `eb8b02cfc14db983821c8f1cb1349e91a9d96c2be16aa8ba8713bd13c0b05c30` | 283 | D/`MATURE-ACCEPTANCE-2183eb0c-START.json` |
| `443c4e13f69d819b597bb86b825b7eca23315dc27c6167b38913f617b47d7251` | 1459 | D/`CLOUD-JOB-2183eb0c.json` |
| `177f69404a95e2bcebb4d5742b889ee95907c843140dc2684e9df9ecad111686` | 851 | D/`COUNT-BENCHMARK-READBACK.json` |
| `7b9bf60c0d99fa291280187820b0d61ac82c7abf17a34a7be7ad3a8400d2f849` | 11689 | D/`PYTHON-IMAGE-BUILD-LOCAL.json` |
| `858c78e986ee6a4d65b8e688ba7cf558b82ca3ed4e8dcae393031866c908bc6a` | 5525 | D/`mature_acceptance.py` |
| `e9fdbd5b0caf218590f5654aff1902537a32ea0cd71633900b0e7474df5e952e` | 16199 | D/`T3-PLAN-REVIEW-GROK.md` |
