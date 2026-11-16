# T2 候选验收

审查身份：Grok 4.7。系统身份没有另行给出的 build 哈希。
结论：`NOT_ACCEPTED`。这不是 T2 收口，也不是生产接管。
固定候选：`457ed5ae1349ba6c1795ed66750075792bc72156`（`457ed5ae` 的 `git rev-parse`）。之后的命令、哈希和测试都对着这个提交，不追随后出现的新 HEAD。
基线：`ac476d3c55d6d708bc49536ba4348870541419b0`。基线是候选的祖先。候选相对基线是 1 个提交，27 个文件，+915 / -77。
审查开始时工作树干净且 HEAD 就是该候选。审查期间 HEAD 前进到 `6daf1b348c57665a46d4d4d1554c97b15c6e7a02`。写完报告文件时 HEAD 仍是该提交。工作树在收尾时还有未提交改动：`storage-backup-job.py`、`storage-lock.py`、`storage-lock.test.py`、`storage-mature-fixture.py`、`storage-nas-verify.mjs`。这些草稿和 `6daf1b34` 都不在本次验收范围内，没有对它们重跑 `test:archive-complete`。
本审查没有改业务源码，没有部署，没有改设备，没有删除共享 NAS 数据，没有发外部消息，没有读取私钥或 env。

## 阻断

候选的归档维护入口在发布成功时把 `analytics_meta.last_backup_success_ms` 写成 `Date.now()`。快备份会偏离捕获时间几十毫秒；重放一份几天前的 `ready.json` 时，会把旧快照的年龄刷成刚刚成功。`backup-status.json` 里的 `manifest.created_at_ms` 和 `last_offsite_backup_ms` 没有这个错误。已提交的运行说明要求最后成功按捕获时间计算，断线时年龄继续增加。

候选文件 `2-Projects/P003GameDemo20260513/apps/server/scripts/analytics-maintenance.mjs` 第 28 行：

```js
if(!archiveRoot||result.state==='published') ... run('last_backup_success_ms', String(Date.now()));
```

`test:archive-complete` 退出码是 0，挡不住这个缺陷。套件里的维护测试只检查第二次 `waiting_for_nas` 不再改写水位，打印的 “honest watermark” 不是捕获时间相等。

独立复现用的是 `git archive` 出来的候选树，Node `/Users/fu-121/.local/node-v24/bin/node` v24.19.0，维护脚本内部的 `/usr/bin/python3`（Python 3.9.6）：

- 新发布：`created_at_ms=1794806880367`，水位 `1794806880414`，差 47 毫秒，不相等。`state=published`，`last_offsite_backup_ms=null`，keep2 的 `legacy` 目录没有出现。
- 把同一份 payload 配上一份 `created_at_ms = 现在 - 3 天` 的 `ready.json` 再进维护入口：manifest 仍返回旧捕获时间 `1794547680443`，水位变成 `1794806880837`。相对旧捕获时间晚 259200394 毫秒，距离复现当时的现在只有 17 毫秒。

修复方向：归档模式的发布水位写成 `result.manifest.created_at_ms`；keep2 路径可以继续用完成时刻。补一条三天前 `ready.json` 的断言，要求水位等于那份 manifest 的捕获时间，并且 `waiting_for_nas` 不再改它。后续提交 `6daf1b34` 的 diff 里有这一行改动和对应测试，但本审查没有执行那个提交。

## 另一个开放缺陷

卷标记守卫只在 `ARCHIVE_VOLUME_MARKER` 或 `ARCHIVE_VOLUME_ID` 至少设置了一个时才运行。两个都缺省时，`storage-lock.py` 直接创建锁文件。`storage-nas-cycle.sh` 和 `storage-nas-pull.sh` 只强制 `ARCHIVE_ROOT`。

这和“标记缺失就失败关闭、不创建锁”还差调度入口这一层。环境变量成对出现时，守卫本身是有效的：

- 规范绝对路径、两个变量都未设置：退出码 0，锁文件被创建，模式 `0600`。路径是 `/private/tmp` 下的规范目录。`/tmp` 在这台 Mac 上是符号链接，会先被 `realpath` 拒绝，不能用来证明卷守卫。
- 同一目录设置了变量但标记文件不存在：退出码 2，`ARCHIVE_LOCK_FAILED`，锁未创建。
- 标记内容错误：退出码 2，锁未创建。

`NAS-VOLUME-AND-KERNEL-FINAL.json` 只覆盖“变量已设置时，缺失或错误标记在加锁前拒绝”，退出码 0，5 个测试 OK。它没有证明调度脚本在忘了导出变量时也会拒绝。

修复方向：在 `storage-nas-cycle.sh` 和 `storage-nas-pull.sh` 进入锁程序之前要求这两个变量；或者让锁程序本身缺省即失败，并让直接调用的单元测试自备标记。T6 安装 cron 之前必须先合上。写报告时工作树里的未提交草稿把检查改成了强制，并给两个 shell 入口加了缺省拒绝测试。那不是候选内容，本审查没有运行它。`6daf1b34` 的已提交 diff 也还没有这处修改。

## 本候选上实际跑过的测试

测试树：`git archive 457ed5ae1349ba6c1795ed66750075792bc72156` 解到 `/tmp/p003-grok-t2-457ed5ae`。没有切换分支，没有使用审查期间变脏或前进的工作树。抽出的 `analytics-maintenance.mjs` SHA-256 为 `91b600d941e23be1d619bdb94e74a7b59564d417a4a82b90a22330ac7447045f`，与候选 blob 一致。

命令，工作目录是归档里的 `apps/server`：

```text
PATH=/Users/fu-121/.local/node-v24/bin:$PATH
node v24.19.0
npm 11.17.0
python3 -> /opt/anaconda3/bin/python3 3.12.2
npm run test:archive-complete
```

退出码 0。开始时间 2026-11-16T05:25:47Z。输出计数：

| 命令 | 结果 |
|---|---|
| `scripts/storage-archive.test.py` | 7 tests OK，0.144s |
| `scripts/storage-nas-verify.test.mjs` | PASS：续传、原子落地、ACK 丢失重试、坏包隔离、schema 与符号链接拒绝 |
| `scripts/storage-lock.test.py` | 5 tests OK，3.669s |
| `scripts/storage-backup-job.test.py` | 6 tests OK，0.393s |
| `scripts/analytics-backup.test.py` | 7 tests OK，0.159s |
| `scripts/storage-nas-retention.test.mjs` | PASS |
| `scripts/storage-maintenance-integration.test.mjs` | PASS，见上面的水位限度 |

维护集成测试走的是脚本里写死的 `/usr/bin/python3`（3.9.6），不是 PATH 上的 3.12.2。这条路径包含在退出码 0 里面。

另外在候选树上执行：

- `analytics-archive-maintenance.sh` 缺少 `ANALYTICS_ARCHIVE_ROOT`：退出码 1，`archive spool required`。
- 该变量是相对路径：退出码 2。
- Python 3.12.2 与 3.9.6 对无竞争的 86 页库做 `backup(pages=1, sleep=0.05)`，耗时都约 0.008 秒，与 `sleep=0` 相同。这次测量里，`sleep=0.05` 没有按页加进预算。它仍只是无竞争小库的测量，不是 48GB 的速度。

## 核对后可以认定的行为

这些认定只覆盖候选 blob 和下面点名的证据，不覆盖 90 天大库。

- 未 ACK 的 `analytics_backup` 让下一次任务停在 `waiting_for_nas`，不生成第二份全库，不创建 keep2 目录。上一份已 ACK payload 要等新份 ACK 之后才删正文；manifest 和 receipt 保留。`ark_checkpoint` 不进这份清理。低空间用替换的 `disk_usage` 做了测试，已有 payload 和方舟包还在。这是套件结果，不是生产盘。
- 日 7、周 4 的公式与前审一致：`day = floor((created_at_ms + 8h) / 86400000)`，`week = floor((day + 3) / 7)`。从 `2026-11-16T04:00:00Z` 起连续 45 个 CST 日，独立算出保留下标 `0,1,2,3,4,5,6,8,15`，共 9 份。套件用同一期望通过，并检查了未 ACK 包、方舟包、坏掉的最新包、以及零预算拒绝。
- NAS 上两份已验证小包 `80e713d0d678424382fe737effb69d3a` 与 `ae13ec4287d04d9bbb080d3c42f2ae59` 落在同一个 CST 日桶。`NAS-CANDIDATE-CYCLE.json` 保留较新的一份、移除较旧的一份，恢复结果 `integrity_check=ok`，3200 行，105,811,968 字节。这符合桶规则，不是 45 天大文件演练。
- 预算函数是 `min(7200, max(300, ceil(180 + 2 * size / (16*1024**2))))`。模型单份 48,206,400,000 字节得到 5927 秒。单次全文件按 16MiB/s 约 2873 秒，三次全文件约 8620 秒，超过 7200。105,811,968 字节约到 300 秒下限。候选里的三层时间是 Python 7200 秒、`spawnSync` 7,220,000 毫秒、systemd `TimeoutStartSec=7260`，`Restart=no`。等锁仍是 20 秒。`StartLimitBurst=5` 还在，但 `Restart=no` 不会把一次失败重跑起来。
- `capacity.ts` 与 `policy.ts` 相对基线没有 diff。`backup_peak_copies` 仍是 4。`archive_enabled` 仍只能是 `false`，`archive_interval_sec` 仍是 300。候选没有实现 `shouldArchive` 或 `appendArkArchive`。
- 生产 unit 仍执行 `analytics-maintenance.sh backup`。归档入口只存在于 `analytics-archive-maintenance.sh` 和 `p003-analytics-backup.archive.conf.example`。示例 drop-in 用 `EnvironmentFile` 和替换后的 `ExecStart`，并再次写 `Restart=no`。这是 T6 的安装件，不是已经生效的生产配置。
- 锁程序不按 pid 文件发信号，也不删除锁 inode。监督进程清掉 `FD_CLOEXEC`，子进程 `setsid` 后继承锁描述符；子进程被杀死时，监督进程的 `finally` 向该进程组发 `SIGTERM`，最多等 1 秒再 `SIGKILL`。本地 5 个锁测试通过，其中包括监督进程被 `SIGKILL` 后孤儿仍占锁，以及关闭多余 fd 的孙子进程不会在锁释放后继续存活。

## NAS 与 systemd 证据

`NAS-CANDIDATE-CYCLE.json` 里列出的 12 个上传文件 SHA-256 与候选 blob 逐个一致，包括 `storage-lock.py`、cycle/transfer/verify、`storage-backup-job.py`、`analytics-backup.py`、`storage-archive.py`。因此这份 cycle 记录可以算到本候选的 NAS 脚本上。退出码 0。它验的是 105,811,968 字节、1600+1600 行的合成包，SHA-256 `fdfe8c7f717170673cb9173ed433e822e7ee8e7238f698f9e4ae991d136b1a75`。这是模型单份 48,206,400,000 字节的 0.2195%，不能算 B5。

`NAS-CODE-HASHES.json` 是更早的字节，其中 `storage-backup-job.py`、`analytics-backup.py`、`storage-archive.py`、`storage-nas-verify.mjs` 与候选不同。不要再拿那份 JSON 当本候选的指纹。

进程终止证据，都不是整机断电：

- `NAS-SUPERVISOR-SIGKILL.json`：监督进程退出 137，随后第二次抢锁退出 3，之后完成的是已经传满的同一 105,811,968 字节对象。
- `NAS-KILL-BODY-RESUME.json`：主体退出 137，并发任务退出 3，partial 停在 3,309,568 字节，再次传输从该偏移续到 105,811,968，SHA、3200 行和 ACK 都在这份 stdout 里。
- `NAS-CONTAINER-RESTART-LOCK.json`：退出码 0，stdout 写明校验容器内的 flock 在客户端脱离后仍在，容器 `SIGKILL` 并重启后释放。本审查没有在 NAS 上重做这一步。
- `NAS-OFFLINE-RECOVERY.json`：把 SSH 指到 `127.0.0.1:1`，list 阶段退出 255，`connection=unreachable`，`last_success_ms` 保留上一次成功。这是连接拒绝，不是磁盘掉电。

首轮失败保留在 `NAS-FIRST-CYCLE.json`：rotate 阶段退出 1，错误字符串是 `ARCHIVE_VERIFY_FAILED:UNEXPECTED_TRASH_CONTENT`。JSON 正文没有写 WAL 或 SHM。候选代码与这个失败相符：只读打开 WAL 模式库会在包旁边留下空的 `payload.bin-wal` 和 `payload.bin-shm`，旧的 trash 白名单拒绝它们。当前代码在关闭连接后删除空 sidecar，非空 WAL 仍以 `UNEXPECTED_ARCHIVE_WAL` 失败；trash 允许这两个文件名，但非空 WAL 仍失败。`NAS-CYCLE-RECOVERED.json` 随后退出码 0。本审查没有在 NAS 上重放首轮失败。

`SYSTEMD-EXACT-PROPERTIES-PASS.json`：隔离 unit `p003-t2-isolated-backup-final-20261116.service`，`Restart=no`，`TimeoutStartUSec=2h 1min`（7260 秒），`NRestarts=0`，`ExecMainStatus=0`。状态是 `published`，`pending_bytes=105811968`，`last_offsite_backup_ms=null`，`budget_seconds=300`。这与小包公式和“发布还不是异地确认”一致。`SYSTEMD-ISOLATED-PASS.json` 同时写着 `published`、复制进度和 `pending_bytes=0`，超时也只有 90 秒，不能当作最终状态机证据。

`PRODUCTION-GUARD.json` 的提交证据是生产路径哈希前后不变，23 点上传仍启用，3 个 subject。本审查没有登录生产机复核。

`CLOUD-ARCHIVE-ENTRY.json` 写了 `watermark_matches_capture: true`，但没有 `analytics-maintenance.mjs` 的哈希。本候选这份文件的实际行为与该声明不符。不能把这份 JSON 算作候选已证明水位。

D 下的 JSON 和 log 没有 `python2.7` 或宿主解释器版本。`NAS-RUNTIME.json` 只证明校验容器里有 `/usr/bin/flock`、Node v22.19.0 和 Debian 12。锁程序源码按 2.7/3 写法编写，本审查没有用 Python 2.7 执行它。宿主 Python 2.7 仍是证据文件里没有独立确认的一项，不是已证伪。

共享 NAS 硬断电和整机重启没有执行。上面的 kill、容器重启和单元测试里的 `sync_dir` 失败注入不能称为硬件断电测试。`storage-backup-job.test.py` 的 fsync 用例是把 `sync_dir` 替换成抛错一次，套件已重跑通过；这不是 NAS 磁盘返回 EIO。

## 成熟库

不能写成熟测试 PASS，也不能写 B5 通过。

最新读到的 `MATURE-PROGRESS-10.json`：`analytics_rollup_fact` 20,260,000 / 54,000,000 行，阶段仍是 `generate`，耗时约 2529 秒，文件 19,842,736,128 字节。容器 `StartedAt=2026-11-16T05:21:11Z`，状态 running。没有 Backup API，没有隔离恢复，没有 `MATURE-ACCEPTANCE.json`。`MATURE-ACCEPTANCE-START.json` 只有一段哈希。

seen 的最后一条显式计数在 `MATURE-PROGRESS-4.json`：17,950,000 / 27,000,000。后面的样本已经进入 fact。候选生成器按 seen、fact、event 的顺序写，进入 fact 通常表示 seen 循环已经走完，但 D 里没有 `rows=27000000` 的完成记录。不把 seen 写成已验收。

`MATURE-FIXTURE-RESUME.json`：第一个容器 `ExitCode=143`，结束于 2026-11-16T05:21:11Z，当时 fact 约 20,250,000 行。stdout 里的 64 位十六进制与候选或 `6daf1b34` 的 `storage-mature-fixture.py` 都对不上，不能当作脚本指纹。候选生成器没有 `--resume`。大库生成即使用了后续脚本，也不属于本候选的通过记录。

`fixture-smoke.progress.json` 是 2 台、每天 10 个事件、90 天的完成样本：event/settlement 各 280，fact 3600，seen 1800。它只说明小规模生成器能跑完，不是 50×6000×90。

16MiB/s 仍是源码常数。模型预算 5927 秒是公式结果，不是这次大库的墙钟。大库的字节、墙钟和失败阶段要等主 13 的 `MATURE-ACCEPTANCE.json`。上限保持 7200 秒。

## 门禁

| 门 | 本候选 |
|---|---|
| B1 未确认不产生第二份全库 | 套件通过。水位值不通过，见阻断。 |
| B2 新份 ACK 前保留上一份 | 套件通过。 |
| B3 空间不足不删已有包和方舟包 | 套件用替换的磁盘剩余通过。 |
| B4 预算与三层超时、Restart=no | 公式、源码和隔离 systemd 证据一致。真实大库墙钟未测。 |
| B5 90 天 Backup API 与隔离恢复 | 未做。生成仍在 fact。 |
| N1 日周桶 | 套件通过，下标已独立重算。 |
| N2 最新包损坏则不轮换 | 套件通过。 |
| N3 锁 | 本地套件通过。NAS 证据是进程/容器终止，不是整机重启。 |
| N4 卷标记 | 变量已设置时通过。变量缺省时失败关闭，未通过。 |
| W1 生产接线 | 代码和 drop-in 示例在。生产 unit 未切，`archive_enabled` 仍为 false。 |

原传输候选 `845d8cfa3e1d3a24d872a611d81e9e90467768c8` 的小包、偏移续传、ACK 丢失和坏包隔离没有重做，也不把它计入规模行。

## T3 / T4 / T5 / T6

T3 不从本候选当作已验收基线开工。边界文档已经在候选里：不实现方舟历史规则；`ark_checkpoint` 仍是合法 kind；日周轮换不删除它；Ark 的 ACK 只承诺哈希、字节和 `record_count`。`shouldArchive` 与 `appendArkArchive` 仍待实现，并且要和 `ark_current` 写在同一个 `BEGIN IMMEDIATE` 里。间隔 300000 毫秒。critical 字段仍是 family_coin、stardust、`M-CARD-001`、领取状态、`claimable_count`、`source_mode`、`content_version`。同一 `snapshot_id` 或只有时间戳、序号、boot、`remaining_seconds` 变化则 skip。`source_mode=gm` 单独成行。未 accepted 的快照不写归档行。

T4 再核对 90/180 天滚动容量、实际副本数和四副本系数。系数这次不动。
T5 再做 50 台日批、方舟/备份/维护混合，以及至少 50 轮语音对照。大库备份通过也不能写成 50 台接收或语音压测通过。
T6 才安装归档 drop-in、停原 backup timer、配置 NAS 私有 wrapper 和调度。本轮没有做。生产 23 点上传按提交的 guard 记录未切换。

## 证据范围

读了候选与基线的 diff、归档树上的备份/锁/轮换/维护脚本和四份 `t2-complete` 文档，重跑了上面的套件和水位、卷标记、缺省环境变量复现。读了 D 里的 NAS、systemd、生产 guard、成熟库进度和前审。没有把 `6daf1b34` 或写报告时的未提交锁草稿当作候选重测。没有重做 `845d8cfa`。没有等待大库生成完。
