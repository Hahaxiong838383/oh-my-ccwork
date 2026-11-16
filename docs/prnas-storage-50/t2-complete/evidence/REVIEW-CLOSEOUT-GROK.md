# T2 最终收口

结论：**PASS_T2_ISOLATED**

固定候选 `2183eb0cb843812582b5ca8adeac11ac1dd1d903`。本结论只覆盖候选业务脚本，加上这次隔离在真实 NAS 上的合成 50×6000×90 备份与恢复。生产发布为否。T3 仍是已定稿计划，代码未实现。

模型身份来自本会话系统提示，自报 Grok 4.7，没有可见 build 哈希。性能复核文稿里的模型署名不沿用。

本审查没有改业务源码、生产、设备、配置或共享记忆，没有外发消息，没有重跑大库备份、完整 integrity 或全文件哈希。

## 收口前已核

候选是当前 HEAD `94b8bb854bedc80e35526442e7c0fba27d08fb95` 的祖先。HEAD 相对候选只改 4 个文档：`ROLLBACK.md`、`RUNBOOK.md`、`T3_HANDOFF.md`、`T3_REVIEW_RESOLUTION.md`。工作树仅 `RUNBOOK.md` 有未提交改动，把 NAS wrapper 变量写成 `ARCHIVE_ROOT`、`ARCHIVE_CODE_ROOT`、`ARCHIVE_VERIFY`、`ARCHIVE_SSH_CONFIG`、`ARCHIVE_SSH_TARGET`、`ARCHIVE_PYTHON`、`ARCHIVE_VOLUME_MARKER`、`ARCHIVE_VOLUME_ID`、`ARCHIVE_DOCKER`、`ARCHIVE_NODE_IMAGE`。这些名字与候选里的 `storage-nas-cycle-body.sh`、`storage-nas-transfer.sh`、`storage-nas-verify-container.sh`、`storage-lock.py` 一致。业务脚本在候选、HEAD 和工作树之间字节相同。

457 的两条缺陷在候选源码里已关闭，本审查重读了对应行，没有重跑全套件：

- `analytics-maintenance.mjs` 在归档根存在且状态为 `published` 时，把 `last_backup_success_ms` 写成 `result.manifest.created_at_ms`。
- `storage-lock.py` 在 `os.open` 创建锁文件之前要求 `ARCHIVE_VOLUME_MARKER` 与 `ARCHIVE_VOLUME_ID` 同时有效。

日界在 `storage-backup-job.py`：已 ACK 的最新份与当前时刻同属 CST 日 `(ms+8h)//86400000` 时返回 `not_due`。435 到 218 只改这个作业、它的测试和 `IMPLEMENTATION.md`。

`EVIDENCE-PRE-FINAL-INDEX.json` 列出的文件重新哈希，0 处不符。`REGRESSION-2183eb0c.json` 的两份日志哈希与磁盘一致，退出码字段为 0；本审查没有重跑这两份套件。`CLOUD-JOB-2183eb0c.json` 的文件哈希为 `443c4e13f69d819b597bb86b825b7eca23315dc27c6167b38913f617b47d7251`。

T3 定稿字节与先前性能复核记录一致：HEAD 的 `T3_HANDOFF.md` 为 `7379c549618417e76c0cc98a7fd6c1f57611e93ad3a8687dc90ac5f5ccbb1cdd`（10098 字节），`T3_REVIEW_RESOLUTION.md` 为 `71aa0b39e73b3d9225da3cd5c6f47a72b92d6fdf39022c7ced3c8d944ad60d84`（1693 字节）。本审查读了采纳记录里的六条收敛，没有重做整份 T3 设计审计，也没有看到新的设计级阻断。`T3-PLAN-FINAL-INDEX.json` 指向的四个文件哈希仍相符。

对声称的 44,871,368,704 字节，预算公式 `min(7200, max(300, ceil(180 + 2 * size / 16777216)))` 独立算出 5530 秒。页数 `10954924 × 4096` 等于该字节数。

## 最终标记

`FINAL-READY-2183eb0c.json` 在等待期间出现。`status=READY`，`candidate` 仍是上述 SHA。标记列出的 13 个文件，磁盘字节和 SHA-256 全部相符。标记自带的 `result=PASS` 只当作索引，下面的数字来自原文件和一次 NAS 只读回读。

## 大库结果

`MATURE-ACCEPTANCE.json` 的 `result=PASS`，`phase=complete`，`candidate` 匹配。源检查与恢复检查的 schema、15 表计数、`devices` 和样本哈希相同。

| 项 | 值 |
|---|---|
| 合成身份 | `analytics_event_seen` 的 `count(DISTINCT device_key)=50` |
| 表 | 15，另有 11 个带 SQL 的命名索引，以及 15 个 `sqlite_autoindex_*` |
| 行合计 | 89,442,002 |
| 字节 | 44,871,368,704 |
| 样本哈希 | `a447e347286fc5b0ba515aaa18a161a3141f848ebaa1e641d4faade4eb0fbc18` |
| manifest / 恢复 SHA-256 | `720a6b3fc7db7976d72315607519a330393211eb09f92b2e3cc67ce6e43dd05b` |
| archive_id | `d452ddf47bfb40d29a67586f341ab4a4` |
| 捕获时间 | `created_at_ms=1794810392898` |
| 源备份 | 退出码 0，3256.318824 秒，预算 5530 秒 |
| NAS finalize、ACK、轮换和恢复 | 退出码 0，4216.207319 秒 |
| 验收容器总墙钟 | 9076.415035 秒 |

行数按表：`analytics_event` 4,200,000，`analytics_event_seen` 27,000,000，`analytics_rollup_fact` 54,000,000，`analytics_settlement` 4,200,000，`analytics_batch` 21,000，`analytics_transport` 21,000，`analytics_tier_event` 2，其余 8 表为 0。带 SQL 的表和命名索引与 `mature-schema.json` 一致。两边的 `sqlite_master` 都含这 15 个主键自动索引。

源备份日志先把 copy 走到 `remaining_pages=30892`，随后进入 `integrity_check`、全表 `count_rows`、`checksum` 和 `publish_checksum`。进度按约 5 秒节流，最后一条 publish 进度停在 42,780,852,224 / 44,871,368,704；完成记录在 stdout，状态 `published`，SHA 与 manifest 相同。发布当时 `last_offsite_backup_ms=null`，`pending_bytes` 为整包。

两段时限分开计算。源备份 3256 秒低于 5530 秒预算，也低于 Python 7200 秒和验收外包 7260 秒。NAS 段 4216 秒低于 7200 秒。9076 秒是等待夹具完成后再串行做这两段的总墙钟，单段都没有越过自己的硬上限。

夹具进度里的 `sample_sha256=334322c727fc1ca1f0dc6e9b44edcef921a6f94b4fb8ec991e1752a5b8c1ccb9` 只哈希 `analytics_event` 的 `rowid=1`。验收样本哈希的是每张表的首行和末行。恢复核对用的是后者，源与恢复相同。

## NAS 只读回读

用已验证 helper 对 NAS 做了只读元数据回读，没有重新计算 44.87GB 的 SHA，也没有跑 integrity。小文件哈希与本地原字节一致，包括验收 JSON、源 ACK、四份日志和进度 JSON。`code/` 下 7 个文件的 SHA-256 与候选或 D 中同名文件一致：

| 文件 | SHA-256 |
|---|---|
| `storage-backup-job.py` | `5e61efcb141ca6831b4ee64d8e88b1374d6b338c9c0548db1ced7c2b596d20db` |
| `analytics-backup.py` | `28a018c89259187ea0e1d90e37e3f838daf5a903ecc3ee5bbd518b87ee031e2b` |
| `storage-archive.py` | `d782dd5708cdeb0ed12629d8b3e6535306b9839da2917921527966cb2185e8fe` |
| `storage-nas-verify.mjs` | `c2028fecac834adbae196fcb3460b25bf1069a0160ec29f693d13c6ebba11e09` |
| `storage-mature-fixture.py` | `65b337a1f155bf7c9551e5f7a3fd85bb6bc3fbb43ffe90300d29317fff668d8e` |
| `mature_acceptance.py` | `858c78e986ee6a4d65b8e688ba7cf558b82ca3ed4e8dcae393031866c908bc6a` |
| `mature-schema.json` | `531b57452f7f0d815d430a37996dbbe05beccff303a96724b5bc65ceba1f5dbb` |

大文件只读了 stat。三次 inode 不同，字节数都是 44,871,368,704：

| 路径 | inode | nlink |
|---|---:|---:|
| `mature/mature-50x6000x90.sqlite3` | 211157078 | 1 |
| `backup-spool/published/.../payload.bin` | 211157166 | 2 |
| `nas-check/packages/.../payload.bin` | 211157166 | 2 |
| `nas-check/restore/latest.sqlite3` | 211157183 | 1 |

发布包与 `packages` 包是同一 inode。`incoming` 已不在，因为 `finalize` 在校验后把 stage 目录 rename 到 `packages`。恢复副本是另一个 inode，同尺寸。源库、发布包、恢复副本都没有 `-wal` 或 `-shm`。

收据 201 字节，字段为同一 `archive_id`、44,871,368,704 字节、上述 SHA-256、`record_count=89442002`，`verified_at_ms=1794815354640`。

两个容器都已退出，退出码 0，`OOMKilled=false`：

| 容器 | 内存上限 | swap | CPU |
|---|---:|---:|---:|
| `p003-t2-mature-fixed-20261116` | 805306368 | 1610612736 | 1.5 |
| `p003-t2-mature-acceptance-final-20261116` | 536870912 | 1073741824 | 1.5 |

验收记录的 `maxrss_child_kib=214516`。容器内 Linux 的该值约为 209 MiB，低于 512 MiB 上限。

包内交接是本机硬链接。44.87GB 没有经过 WAN。单独的真实 SSH 续传证据仍是 `NAS-KILL-BODY-RESUME.json`，索引哈希 `19eb57ca27ef28ee1686c98364525385ad5a205667d38654e4261911b18b8cb5` 仍与磁盘一致：105,811,968 字节点，从偏移 3,309,568 续传。本审查没有重做那次传输。

## 源 ACK 与水位

`MATURE-SOURCE-ACK.json` 与 runner stdout 一致。第一次 runner 退出码 2，stderr 为 `python3: can't open file '/app/timeout'`，发生在 helper 运行之前；该失败记录保留，helper 哈希仍是 `e8e1e6b6797b6c386d94dc6b9e48b1d1561e668ed908f111faac5b0c37f6b84c`。修正入口后的 runner 退出码 0。

成功记录：包数 1 到 1，重复 ACK 结果相同，`pending_bytes=0`，`oldest_pending_ms=null`，`state=not_due`。`last_offsite_backup_ms=1794810392898`，等于 manifest 捕获时间。`checked_at_ms=1794818443813`，`offsite_age_ms=8050915`，与两者的差相同。两个时刻属于同一个 CST 日。本审查没有再次执行 ACK，避免改动 spool。

## 生产只读守卫

`PRODUCTION-GUARD-FINAL-2183eb0c.json` 退出码 0，21 个路径 `all_files_unchanged=true`。其中 19 个文件的 before/after SHA-256 与本地 `BASELINE.json` 一致。`src/storage/policy.ts` 和 `src/storage/routes.ts` 在基线哈希表里没有摘要，守卫记录两边都是 null，因此记为未变化；这两项没有文件内容可比。

进程与早先 `PRODUCTION-FINAL.json` 相同：`p003-voice` PID 2075857、online、restarts 3；`p003-analytics` PID 2075980、online、restarts 2。上传策略 enabled、revision 4、hour 23、subjects 3。`storage.policy.v1` 为空。原 backup timer 仍是 active/waiting，service inactive/dead，`Restart=on-failure`，`TimeoutStartUSec=2min`。归档 drop-in 没有装上。本审查没有另开生产会话。

## 软件恢复与未覆盖范围

先前索引仍相符、本审查没有重跑的软件恢复记录是：监督进程 SIGKILL 后孤儿写锁返回 3（`NAS-SUPERVISOR-SIGKILL.json`），主体 SIGKILL 后续传（`NAS-KILL-BODY-RESUME.json`），校验容器重启后释放锁（`NAS-CONTAINER-RESTART-LOCK.json`），以及候选套件里的 `sync_dir` 一次失败注入。这些验证的是进程、锁和文件同步失败后的软件恢复。

以下各项不在本结论内：

- 44.87GB 的 WAN 传输或续传压测
- 50 台真实设备、阿里云成熟吞吐、24 小时耐久
- NAS 整机硬断电和整机重启
- 安装后的调度在重启后是否仍在，留给 T6
- 生产自动归档切换和放量
- T3 代码实现

没有新的代码阻断，因此没有另写 `FINAL-FINDINGS-GROK.md`。
