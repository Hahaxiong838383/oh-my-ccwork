# P003 T3 磁盘预算增量复验（仅 11ef01ec）

署名：Grok 4.7（xAI）
时间：2026-11-16 22:55 +0800

结论只覆盖固定区间 `74482851a914256591238a6cb8b9d66a1447cfbb..11ef01ecf0e05bebb2af77b6d8cfb26c813b195b`。这不是 744 整体结论，不能记成 744 PASS。

## 结论

固定提交 `11ef01ecf0e05bebb2af77b6d8cfb26c813b195b`（父提交就是 `74482851a914256591238a6cb8b9d66a1447cfbb`，说明 `fix(storage): reserve queued export disk and pause safely when disk fills`）里：

- 累计 `reserved_bytes` 进入实际空闲门槛：通过。比较是严格小于。等式放行，少 1 字节拒绝，且不新增行。
- 其他进程占盘后暂停写新包：通过。最终包还不存在且空闲低于门槛时，不创建工作文件。
- 已确认清理仍可执行：只在 `process_batch` 已经走到该批时成立。同一次导出里先写出一批、再因磁盘不足停下下一批时，若未落盘批的 `archive_id` 排序更靠前，下一轮会先抛错并停住，已确认的那一批保持 `published`，outbox 不释放。

因此这条增量 **不能通过**。阻断 1 条，见下文。13 个 `ark-archive` 与 8 个 `storage-ark-export` 在该提交上均为 0 失败；阻断来自提交测试没有覆盖到的同轮多批排序。

复验期间工作树 HEAD 已前进到 `4ea6af5afb8fbd80133a7a48fbeea9565d135217`（`fix(storage): drain confirmed batches despite low-disk blocked exports`）。它不在指定区间里。本次没有抽它的 archive，没有跑它的测试，不对它给通过或失败。

## 范围与环境

4 个文件，blob 均取自 `11ef01ec`：

| 文件 | blob |
|---|---|
| `apps/server/src/ark/archive.ts` | `c0131ef9f4cb164e077bacbab4e19af24778c33e` |
| `apps/server/scripts/storage-ark-export.py` | `8481c77e7577fde1ec0f7c065e98d00458990d20` |
| `apps/server/scripts/ark-archive.test.ts` | `1f200cde7bf61b9526cf3df211e368b6f62f72b8` |
| `apps/server/scripts/storage-ark-export.test.py` | `67f0eed639ba25c4ea5aa6d433b6b64e2c553e60` |

抽出的是 `git archive 11ef01ec`，目录 `/tmp/p003-disk-grok-src`。`archive.ts` 与 `storage-ark-export.py` 的 `git hash-object` 与上述 blob 一致。`node_modules` 只做符号链接，指向既有安装；复验后 45 分钟内该目录没有新文件。未执行安装，未改业务源码，未改生产，未改 360 工作树。Node `/Users/fu-121/.local/node-v24/bin/node`，版本 v24.19.0。Python 3.12.2。

当前工作树相对 `11ef01ec` 还有别人写下的 `4ea6af5`，以及 `docs/prnas-storage-50/t3/` 的未提交文档。复跑不使用这些文件。

## 复跑

工作目录是抽出的 `apps/server`。

```text
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/ark-archive.test.ts
TEST_NODE=/Users/fu-121/.local/node-v24/bin/node python3 scripts/storage-ark-export.test.py
```

| 套件 | 结果 | 日志 | SHA-256 |
|---|---|---|---|
| ark-archive | tests 13，pass 13，fail 0，exit 0，duration_ms 2179.772292 | `grok-ark-archive-11ef01ec.log` | `ab425d9ece542c726371b132318492e1a7241745478cc146e6ad7801c0af8cda` |
| storage-ark-export | Ran 8 tests in 5.554s，OK，exit 0 | `grok-storage-ark-export-11ef01ec.log` | `8109a2dd4886bd80403b9c7e40bc3f61aff96b281aa2d225ff956eaa0cd83e86` |

其中包含 `free disk also reserves the accumulated queue, not only the arriving row`，以及 `test_disk_consumed_after_accept_pauses_export_without_losing_rows`。

## 累计 reserved_bytes

`appendArkCheckpoint` 在插入前读取 `ark_archive_stats.reserved_bytes`，门槛是：

```text
freeBytes < reserveBytes + stats.reserved_bytes + 本行 reserved
或 stats.reserved_bytes + 本行 reserved > limitBytes
或 limitBytes / reserveBytes / freeBytes 不是非负安全整数
```

任一成立就抛 `archive_buffer_full`，插入不发生。`reserved_bytes` 由 outbox 的 AFTER INSERT / AFTER DELETE 触发器按每行 `reserved_bytes` 累加，本行在检查里只加一次。单行预留仍是原有的 `archiveReservation = 3 * (bytes + 1024)`。

这是保守的。排队行的 SQLite 正文已经占用过磁盘，触发器里的 3 倍预留仍整段再拿去和当前空闲比较，所以已落在库里的部分会被再计一次。少计排队、只看本行的旧式比较被关掉。

实际空闲不是这 4 个文件里新采样的。未改动的 `src/ark/service.ts` 在归档开启时对 `ARK_DB_PATH` 做 `statfs`，`freeBytes = bavail * bsize`，`reserveBytes = 4.5 * 1024**3`。这个值和导出常量 `DISK_RESERVE_BYTES = 9 * 1024**3 // 2` 相同，都是 4831838208。`accept` 在 `BEGIN IMMEDIATE` 之前调用策略函数，排队累计则在事务内读取。空闲样本比锁稍早，4.5 GiB 安全余量盖住这个窗口。该采样不在本次 diff 里，这里只用来确认门槛吃的是实时空闲，而不是一个写死的剩余容量。

提交里的队列测试把空闲设为 `reserve + 已有 reserved + 100`，以及 `reserve + 2 * reserved + 100`。实测两行预留都是 5430，100 字节的余量远小于一行预留，所以该测试能抓住“漏加队列”，但没有钉死字节边界。

## 边界反例（接受路径）

脚本只放在抽出的临时树里，不在仓库中。日志 `grok-boundary-accept.log`，SHA-256 `38a71acae4ac04d99a678a37e0319dae26f9e0525d5225f80c500cd71fab8c12`。

同一快照重复测量：`r1 = r2 = 5430`，两行之后统计表 `reserved_bytes = 10860`。`reserveBytes = 4831838208`。

| freeBytes | 结果 |
|---|---|
| `reserve + r1 + r2` = 4831849068 | 接受，outbox 变为 2 |
| `reserve + r1 + r2 - 1` = 4831849067 | `archive_buffer_full`，outbox 仍为 1，当前 sequence 仍为 1，统计表 `reserved_bytes` 仍为 5430 |
| `reserve + r2` = 4831843638（不加已排队的 r1） | `archive_buffer_full`，outbox 仍为 1 |

第三条就是旧公式会放行的点：旧比较只看本行，等式不小于门槛。新公式在这里拒绝。

## 暂停写新包，以及清理缺口

导出在已确认分支之后才检查磁盘。该分支先删已校验载荷并提交 outbox 删除，然后 return。下面的检查是：

```text
最终 payload.bin 不存在
且 shutil.disk_usage(spool.root).free < DISK_RESERVE_BYTES + len(payload) + 65536
→ ValueError('archive_export_disk_reserve')
```

检查在写入 `ark-work` 之前。`publish_prepared` 是同卷 rename，注释写明最多一个新载荷。最终包已经存在时不再为这一包要求整段空闲，因为不会再写一份新载荷。

8 个提交测试里的低磁盘用例用 `free=1`：新导出抛错，outbox 仍是 3，spool 列表为空；该批确认之后，同样 `free=1` 的下一轮仍把 `pending_records, reserved_bytes` 收到 `(0, 0)`。这条单批路径本次复跑通过。

字节边界在临时脚本里再钉了一次。3 行样本载荷 2505 字节，门槛 = 4831838208 + 2505 + 65536 = 4831906249。日志 `grok-boundary-export.log`，SHA-256 `d25d35429602b3b600d1ae9a71e1a2c64c884e2d8a2ffc0ba97f79ca2fa46610`。

| 空闲 | 结果 |
|---|---|
| 门槛减 1 | `archive_export_disk_reserve`，outbox 仍为 3，`ark-work` 为空，已发布列表为空 |
| 正好等于门槛 | `published == 1`，包大小 2505 |

阻断用的是 `cycle()` 本身，不是绕过循环去调用下一批：

1. 两行数据，`MAX_ROWS=1`，同一次 `cycle` 的 `now` 相同。生产代码在队列超过 `MAX_BYTES`（1 MiB）时也会在同一轮切出多批，`created_at_ms` 同样共用这一个 `now`。
2. 第一批 `archive_id` 固定为 32 个 `f`，磁盘空闲很大，发布成功。
3. 第二批 `archive_id` 固定为 32 个 `0`，空闲改为 1，抛 `archive_export_disk_reserve`，状态停在 `prepared`，没有最终包。
4. 对已发布的 `f` 批写入匹配回执。
5. 再跑一轮，空闲仍为 1。

结果：再次抛 `archive_export_disk_reserve`。状态是 `0000…` = `prepared`，`ffff…` = `published`。outbox 仍为 2。已确认的 `f` 批没有进入 `complete`，清理没有执行。

原因在 `11ef01ec` 的 `cycle`：未完成批按 `created_at_ms, archive_id` 排序，`process_batch` 抛错会终止整轮。磁盘是在两批之间被占满的，失败批的 id 又排在已确认批前面，于是每一轮都先撞上未落盘批。单写锁并不阻止这个顺序。UUID 随机时，后申请的那一批大约一半会排在前面。回执可以在下一轮之前到达，因为第一批的包已经发布。

所以“暂停写新包”成立，“已确认清理仍可执行”不能对所有已进入 spool 的已确认批成立。这是本提交把磁盘不足变成异常之后，和原有“遇错即停”叠在一起的结果。

`4ea6af5` 改的是这个 pending 循环。它不在本次固定 SHA 内，本次不把它算作已修复。

## 已有 NAS 证据的一致性

只读了目录里的 `E2E-SOURCE.json`、`E2E-NAS.json`、`E2E-CONFIRMED.json`、`E2E-NAS-INDEPENDENT.json`、`PRODUCTION-UNCHANGED.json`。五份都是 `exit: 0`、`stderr` 为空。我没有登录远端，没有重放 NAS，下面只是这五份文件彼此是否打架。

对齐的字段：

| 字段 | SOURCE | NAS | CONFIRMED | NAS-INDEPENDENT |
|---|---|---|---|---|
| archive_id | `9e899fa0a14b49488569dd67a4112399` | 同左 | 无此字段 | 无此字段 |
| sha256 | `72e7d919e217614fe6367a484e1de46b797c9f93bf5fae4b07c1bf9db7c5bd19` | 同左 | 无 | 同左 |
| bytes | 41755 | 41755，且 `ARCHIVE_VERIFIED` 同字节 | 无 | 41755 |
| 条数 | record_count 50，lines 50，id 1..50 | manifest 同为 50 | current 50，baselines 50，outbox 0 | lines 50，distinct_identities 50 |
| 阶段 | cycle published 1，confirmed 0 | `ACK_STORED` 后 `ARCHIVE_VERIFIED` | cycle published 0，confirmed 1 | `asset_values_verified: true` |

SOURCE 的 `created_at_ms` 是 1794839903894。CONFIRMED 的 `stats` 第三个数是 1794839909202，晚于该创建时间。两份 cycle 一个是“已发布未确认”，一个是“本轮确认 1 且 outbox 0”，可以串成先后，不是互相否定。

`PRODUCTION-UNCHANGED.json` 写着 `protected_equal: true`、`processes_equal: true`，并列出 `p003-voice`、`kidshub-voice`、`p003-analytics` 的 pid 与 restarts。它和上面的 archive_id / sha256 没有共同字段，所以既不矛盾，也不能用来证明那次归档周期。pid 我没有在机器上复核。

`E2E-NAS-INDEPENDENT.json` 的目录列表（`.pull.lock`、`.verify.lock`、`incoming`、`packages`、`quarantine`、`trash`、`restore`、`receipts`）在另外四份里没有对应项，无从互相核对，也没有和另外四份冲突。

同目录还有 `E2E-SOURCE.json.first-failed`，exit 1，stderr 是远端找不到 `/opt/p003/archive-t3-20261116/candidate-74482851/2-Projects/P003GameDemo20260513/apps/server`。那是另一份失败记录，不是当前这五份 exit 0 文件。当前五份之间一致。一致性不等于我亲自测过远端。

## 本次没有做的事

- 没有重跑 schema、HTTP、NAS 套件，也没有重跑 744 的其余提交。
- 没有执行 `4ea6af5`。
- 没有改 360 树，没有部署，没有装依赖。
