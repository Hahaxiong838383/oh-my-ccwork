# T2 预审：PRnas 异步归档与断线续传

模型：Grok 4.7。角色：独立预审。分支 `codex/p003-prnas-storage-50-20261116`，HEAD `bef0dea904bc813a9a141b92455e57c898726c16`，与用户给出的原树一致。预审时 `git status --porcelain` 为空。

结论：**可以按下面的最小切片实现。本文件不是实现通过，不是 NAS 验收通过，也不是上线通过。** T0/T1 仍是未部署状态。T3–T6 不在本切片。没有登录公司 NAS、阿里云或任何设备，没有改业务源码，没有跑备份单测，没有委派。

## 本轮只做这些

隔离目录里，用现有 SQLite Backup API 生成一份不少于 100MiB 的包（正文用随机字节，避免全零稀疏文件），由 NAS 侧 rsync 拉取。同一轮覆盖：真实杀掉传输进程后续传、重复确认、损坏拒绝、隔离恢复 `integrity_check=ok` 与表条数一致。云端在收到匹配的确认前保留该包。生产库、生产备份目录、全局路由和防火墙不动。50 台、语音、成熟 90 天库时延都不在本切片里测完。

公司 NAS 在既有文档中是 QNAP `prnas`（TS-X65）。本轮没有读取它的 `rsync --version`。100MiB 实机记录必须写下两端 `rsync --version` 的首行，以及实际使用的标志。Air 或本机不能代替 NAS 端。

## 已核对的现况

| 位置 | 现况 |
|---|---|
| `scripts/analytics-backup.py` | `sqlite3` Backup API，`pages=256`，`sleep=0.05`，进度回调 60 秒超时；目标先写 `.partial`，`os.replace` 后写 manifest；默认 `--keep 2`；prune 按文件名排序，不看 NAS 确认 |
| `scripts/analytics-maintenance.mjs` | 备份固定传 `--keep 2`，`spawnSync` 超时 90 秒；成功后才写 `last_backup_success_ms` |
| `scripts/analytics-maintenance.sh` | 与 rollup 共用 `data/analytics-maintenance.lock`；备份等锁 20 秒 |
| `deploy/systemd/p003-analytics-backup.service` | `TimeoutStartSec=120`，`Restart=on-failure`，`StartLimitBurst=5`，`StartLimitIntervalSec=600` |
| `deploy/systemd/p003-analytics-backup.timer` | 每天 00:30 `Asia/Shanghai`。这是全库备份节奏 |
| `deploy/analytics-offsite-pull.py` | 已有 `rsync -a --partial --partial-dir=.rsync-partial`、`flock`、校验字节和 SHA256 后 `os.replace`。同时复制 `.env.analytics`，并按 7 天文件名时间删除本地副本。没有回传确认 |
| `src/analytics/capacity.ts` | `backup_peak_copies: 4`，每设备字节乘 4。注释写明：运行库、两份保留、prune 前的下一份 |
| `src/storage/policy.ts` | 持久化策略里 `archive_enabled` 必须为 `false`，否则 `INVALID_STORAGE_POLICY` |
| 本机 rsync | `openrsync: protocol version 29`，`rsync version 2.6.9 compatible`。`rsync --append-verify` 返回 `unrecognized option`。帮助里有 `--append`、`--partial` |

文件名规则与现脚本一致：`%Y%m%dT%H%M%S%fZ` 在 `T` 后是 12 位，glob `analytics-????????T????????????Z.sqlite3` 能匹配。`Path.with_suffix('.json')` 得到同茎 `.json`。这个匹配本身不用改。

`sleep=0.05` 是源库 BUSY/LOCKED 时的重试间隔，不能写成每 256 页固定休眠，也不能据此推导 20MiB/s 上限。60 秒预算是否够大库，本轮 100MiB 证明不了。

## 最小实现

新文件保持计划里的四个入口，但做薄包装：`archive.ts` 只做确认状态，`storage-archive-export.ts` 调用现有备份函数，`storage-nas-pull.py` 只拉已发布包，`storage-archive.test.ts` 与 `analytics-backup.test.py` 覆盖下面的失败路径。不要第二套备份器，不要事件级归档台账，不要对象存储，不要管理页面。

1. **发布物**是一个目录改名。同一文件系统上先写 `incoming/<archive_id>/payload.sqlite3` 和 `manifest.json`，文件 `fsync`，父目录 `fsync`，再 `rename` 到 `published/<archive_id>/`。`archive_id` 只用内部生成的 `[0-9a-f]{32}`。确认接口只收 id、sha256、字节数、条数，不收路径。
2. **清单**在备份连接关闭前，从目标库而不是运行库读取固定表的 `count(*)`：`analytics_event`、`analytics_event_seen`、`analytics_batch`、`analytics_settlement`、`analytics_rollup_fact`、`analytics_dirty_day`、`analytics_rollup_retry`、`analytics_day`、`analytics_device_day`、`analytics_meta`。字段沿用现有 `schema_version`、`sha256`、`bytes`、`integrity_check`，并增加 `archive_id`、`record_count`、`state`。SHA256 覆盖最终传输的那个文件。本切片不加重压缩层；计划里的“打包”收成这一次目录改名。
3. **状态**只有 `pending → published → verified`。`verifyArchiveReceipt` 用一条条件更新：id、sha256、bytes、record_count 全部匹配，且当前是 `published` 或已经是同一组值的 `verified`，才成功。第二遍相同确认返回成功，不删文件，不改哈希。未知 id、哈希不符、条数不符、字节不符都保持原状态。
4. **云端清理**。`published` 且未 `verified` 的包钉住，不进入 `--keep 2` 的删除集合。已有本地完整包继续按现行 keep 2 只删除带完整清单、且不属于未确认钉住集合的旧文件。没有 NAS 回执时不把 keep 改成 1。`capacity.ts` 的乘 4 本切片不改。未确认包会让真实份数高于 4，用归档状态里的待传字节表示，留到 T4 再改公式。
5. **NAS 中断期间**若已有未确认的完成包，下一次全库备份直接跳过，退出码和 JSON 写明原因，不删旧文件。没有未确认包时，每天 00:30 仍允许生成一份。`archive_interval_sec=300` 是以后检查点包的拉取间隔，不是每 5 分钟做一次全库备份。
6. **传输**复用相对目录 `.rsync-partial`，命令形态保持 `rsync -a --no-owner --no-group --partial --partial-dir=.rsync-partial --no-whole-file`。目标是稳定临时名，校验大小、清单条数和独立 SHA256 之后才改名到发布目录。rsync 退出码必须是 0。不使用 `--delete`、`--append`、`--append-verify`、绝对 `--partial-dir`、`-W`。不复制 `.env.analytics`，不把现有 `analytics-offsite-pull.py` 接到新目录。
7. **锁**。全库备份继续由 shell 占用 `analytics-maintenance.lock`，避免和 rollup 叠在一起。`analytics-backup.py` 再持有自己的 `analytics-backup.lock`（非阻塞）。拿到这把锁之后，只删除匹配 `^\.analytics-\d{8}T\d{12}Z\.sqlite3\.partial$` 和对应 `.json.partial` 的残留。其他名字的 `.partial` 保留。现有“删临时文件前核对 inode”保留。NAS 拉取端单独一把本地 `flock`，锁文件放在 NAS 目标盘，不放在网络盘。第二任务立即返回明确的 busy，退出码非 0，不能写成 `ok:true`。
8. **超时三层一起改，本轮不声称已经适合 90 天库。** Python 进度回调、`spawnSync`、`TimeoutStartSec` 现在分别是 60 秒、90 秒、120 秒。只放宽其中一层无效。本切片把三层改成同一个可配置预算，硬上限 2 小时；`Restart=no`，失败留给下一次 00:30，避免 `StartLimitBurst=5` 连打全库备份。100MiB 跑通只说明这条路径，不勾掉计划里的成熟库备份项。
9. **确认命令**是云端固定程序，参数只做 id/哈希/整数校验。不要把 NAS 传来的字符串拼进 `ssh python -c`。NAS 只读 `published/`，确认走这条受限命令。凭据不进仓库。
10. **策略开关**继续保持存盘的 `archive_enabled:false`。本切片用显式调用拉取脚本，不在生产启用 timer，不改管理页。

隔离恢复沿用 `restore_backup`：目标必须不存在，恢复后再跑 `integrity_check`，并比对清单里的十张表条数和 seen 抽样。恢复路径由测试传入临时目录。

日备 7 份、周备 4 份做在 NAS 侧，用同一文件系统的硬链接把“本 ISO 周最新一份已验证日备”固定到周目录。已有周备不覆盖。隔离恢复失败时，新文件留在隔离区，日备和周备都不删。删除前必须仍至少留一份已验证副本。周备不是指向日备的符号链接。

## rsync：`--partial` / `--append-verify`

上游手册（rsync 3.4 文档，2026-11-16 读取）：

- `--partial` 才保留中断文件；默认会删掉半成品。
- `--partial-dir` 隐含 `--partial`，把半成品放进指定目录，下次用它加速，用完再删。
- `--whole-file` 或被隐含打开时，已有 partial-dir 文件会被直接删掉，因为不再走增量算法。本地路径到本地路径时，`--whole-file` 是默认值。
- `--inplace` 与 `--partial-dir` 冲突。`--append` 是就地追加，只适用于“接收端已有内容确认为发送端前缀”的持续增长文件；接收端长度不短于发送端时直接跳过，并且不校验已有前缀。
- `--append-verify` 把已有内容纳入校验，失败时改为普通重传。手册仍把它标成危险选项，并要求文件是共享的增长文件。它解决不了“接收端已经不短于发送端”的损坏文件。
- 协议低于 30 时，任一 append 选项都会走 append-verify 语义。这不能反推本机 openrsync：它的协议号是 29，但命令行直接拒绝 `--append-verify`。
- 绝对路径 `--partial-dir` 在较新的 rsync 上有过错误校验循环（上游提交 `31fbb17`，半成品校验和漏算 basis，退出码 23，正确数据留在 partial-dir）。本轮没有复现该缺陷。相对目录 `.rsync-partial` 避开这条路径。

因此续传用相对 `--partial-dir` 加显式 `--no-whole-file`。`--append-verify` 与 partial-dir、不可变归档包、本机 openrsync 都不匹配。最终是否发布只看独立 SHA256、字节数和从包内算出的条数。rsync 自己的退出码 0 不能代替这三项。

实机必须是远程 shell 上的两个 rsync 进程。在本机用本地路径互拷，会落入 `--whole-file`，续传测试会把半成品删掉并从零再传，结果仍然可能 SHA 相同。

## 断线与确认丢失

传输进程被杀死时，半成品只留在临时名或 `.rsync-partial`。`published/` 里没有这个 id。云端状态保持 `published`。

NAS 已经 `fsync` 并改名之后、确认包丢失时：云端仍是 `published`，文件还在。下一轮发现本地字节和 SHA 已一致，只重发确认，不再整文件重传。确认写上之后才允许该包进入可清理集合。

相同确认并发两次：一条条件更新，结果仍是一份 `verified`。不同哈希的第二次确认失败，状态不变。

确认发送必须排在文件 `fsync` 和目录 `fsync` 之后。中途 `fsync` 失败则不发确认，云端不删。

## 锁、目录、SQLite 与清理

shell 锁不覆盖直接执行的 `analytics-backup.py`：node 的 `spawnSync` 不会把 shell 的 fd 9 交给 Python。所以备份脚本要有自己的锁。两把锁的分工见上，不要让 Python 再去抢 shell 已经持有的同一把锁，否则正常定时备份会把自己锁死。

`published/` 与 `incoming/` 先比较 `st_dev`，不同则拒绝开始传输。`os.replace` 跨文件系统会失败；若改成复制加删除，发布就不再原子。

目录 0700，文件 0600。打开锁文件使用 `O_NOFOLLOW`。拒绝目标路径中的符号链接。rsync 不用 root 保留属主，避免退出码 23 被误当成“字节已经到了”。

SQLite 继续走 Backup API 和 `mode=ro` URI。不要只复制主库文件。现有进度回调里的超时包住了复制和 `integrity_check`。超时或校验失败时，现有 inode 核对会删掉自己创建的临时文件，上一份已改名的完整备份还在。SIGTERM 和 systemd 杀进程不会走这个 Python 异常路径，残留 `.partial` 靠下一轮持锁清理。

`last_backup_success_ms` 只表示本地 Backup API 成功。它不是 NAS `verified` 时间。归档状态要另记回执时间；没有回执时显示本地备份年龄，并写明断线期间不承诺 24 小时异地恢复点。

现有 prune 在清单写完之前崩溃时，可能留下一份没有清单的最终 sqlite。它按文件名排在最前，会占掉 keep 名额并挤掉更旧的完整清单备份。新逻辑只把“有清单且未钉住”的文件放进删除集合。

旧的 Studio 拉取脚本按 7 天删除，而且会复制运行环境文件。新拉取脚本不要共享这段逻辑。

## 最可能漏掉的测试

按漏过之后会直接破坏数据或误报通过的顺序：

1. 续传证据只用最终 SHA。必须在半成品超过约 40MiB 时杀掉 rsync，第二次的 literal/接收字节明显小于 100MiB。只比较最终哈希，全量重传也会绿。
2. 在本机用本地路径 rsync，或带了 `-W`。partial 被删除，测试仍显示成功。
3. 只翻转“比源文件短”的半成品。还要测等长和更长的损坏前缀：`--append` 会跳过不短于源的文件。发布目录必须保持没有这个 id，云端包仍在。
4. 清单条数被改、文件字节不变。确认必须失败。条数若从运行库现读，并发写入会造成误拒或误收。条数要在备份连接上取值，恢复后再算一次。
5. 确认在改名和 `fsync` 之后被丢掉。云端仍是 `published`，文件 inode 不变；第二轮不重传整文件，只补确认。重复确认不删除云端或 NAS 上的那份。
6. `os.replace` 写出 sqlite 之后、清单之前杀掉进程，再跑一轮 keep。没有清单的新文件不能挤掉上一份有清单的备份。
7. SIGKILL 留下 `.partial`。下一轮在持有 `analytics-backup.lock` 时只删除自己的命名残留。目录里另放的 `unrelated.partial` 还在。不持锁的进程不能清理。
8. 两个 `analytics-backup.py` 并行：后者 busy，前者临时文件还在。这个测试补的是 shell 锁覆盖不到直接调用的洞。
9. 未确认包存在时，定时入口不再生成第二份全库备份，也不删除旧文件。确认成功后下一次 00:30 才可以再生成。本测试同时防止有人把 300 秒策略理解成每 5 分钟全库备份。
10. 三层超时。把进度回调模拟成超过旧的 60 秒，上一份完整备份仍在，半成品不进入 `published/`。`TimeoutStartSec=120` 若没和 Python、`spawnSync` 一起改，2 小时上限是空的。100MiB 在 60 秒内跑完，不能把这项算通过。
11. 隔离恢复失败时，日备 7 份和周备 4 份都不减少，最后一份已验证副本还在。周目录是硬链接或独立副本，不能是符号链接。`st_dev` 不同时传输开始前就失败。
12. 源库处于 WAL 且未 checkpoint 的已提交行，恢复后必须在。只复制主文件、不走 Backup API 的实现过不了这一条。
13. 测试解析出的数据库和目标路径落在 `/opt/p003/server` 时立即中止。shell 的默认根就是这里。
14. `archive_enabled:true` 仍然被策略解析拒绝。现有配额测试继续通过。容量乘 4 的源码没有变化。

不需要在本切片做的：50 台负载、语音对照、生产库演练、断电实验室、通用垃圾回收框架、gzip 双哈希、云端主动拨入 NAS、T3 检查点、T4 维护吞吐、T6 部署。

## 明确未做

没有修改仓库。没有操作系统、NAS、生产数据库或网络。没有运行 `analytics-backup.test.py` 或维护锁测试，因此不能引用它们的通过结果。NAS 端 rsync 版本未知。90 天库的备份时延未知。本预审不授权部署，也不把 T2 标成完成。
