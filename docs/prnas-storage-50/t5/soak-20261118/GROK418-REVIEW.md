# 复核 5be3fb4b 相对 10d0dc55

结论：`storage-ark-export.py` 与其测试没有可复现阻断。claim 的范围更新在空隙、并发追加和前缀变化下保持原子；ACK 后的删除仍在写事务内做全列精确比对。

候选 `5be3fb4b63ca96ccf7465217cd9582e10f56e7a5`，基线 `10d0dc5514671c85c9224d84eff224700172c2cc`。工作区这两个文件的 blob 与候选一致：`98a04db14f5c7376c0b685ca1535f7ce4d873f7a`、`f850457d4e4f00fc8c947ca77c5d5ed67baea2ae`。只读了 `git show` / `git diff` / `git grep`，并用 Python 3.12.2 对候选模块做了内存库探测。未改源码，未 SSH，未打云负载，未启动代理，未重跑 Mac usleep。

## WAL64 证据

`docs/prnas-storage-50/t5/soak-20261118/WAL64-MIXED-INDEPENDENT.json` 的 `candidate` 是 `10d0dc55`，不是本候选。HTTP `503` 为 1849，Ark 失败体是 `ark_dependency_unavailable`，并列的 `ark_errors` 有 `sqlite_code: 5`。历史查询失败 12 次，最慢查询 1212ms，语句在 analytics 库，不在归档导出器。`reclaimed_checkpoint_completions` 为 30。该证据说明父版本写锁期间的 SQLITE_BUSY 已实录，同时历史查询仍然慢。本 diff 只缩短归档导出器的写事务，不改历史 SQL。

## 源码行为

`claim` 在 `BEGIN IMMEDIATE` 之前读取 `batch_id IS NULL ORDER BY id` 的 1000 行 / 1MiB 前缀。写事务里只有一条：

`UPDATE ark_archive_outbox SET batch_id=? WHERE batch_id IS NULL AND id>=? AND id<=? RETURNING id,bytes`

返回的 `(id, bytes)` 与预读前缀不一致时抛 `archive_claim_changed`。`transaction()` 对 `BaseException` 执行 `rollback`，批次插入和映射一起撤销。

设备插入使用 `sqlite_sequence+1` 的显式 id（`archive.ts`）。新 id 大于表内已有最大 id，因此大于本次 `last_id`，不会落入本批区间。已有其他 `batch_id` 的行被 `batch_id IS NULL` 排除。字节上限在 id 序上截断后缀，区间右端是最后一条纳入的 id，被字节上限排除的后续行不在区间内。

`process_batch` 在锁外做 JSON 解析、拼接和哈希。收据分支的 `finish` 在写事务内执行 `SELECT * ... ORDER BY id`，用 `current!=rows` 比较两次读取的全部原始列，然后才 `DELETE`、标 `complete`、更新 `last_ack_ms`。`sqlite3.Row` 从 Python 3.5 起按列名和列值判等；信封等长改写会改变 `envelope`，比较失败，事务回滚，行保留且状态不会变成 `complete`。

claim 的 RETURNING 只核对 id 和 bytes。等长正文改写若发生在预读之后、payload 读取之前，会随后来的整行读取进入清单；删除前的全列比较仍对着那次 payload 快照。这与「确认路径保留全列、claim 只核 id/bytes」一致。

## 本机探测

Python 3.12.2，链接的 SQLite 3.46.0。直接调用候选 `claim`：

- id 2 已是 `older`，id 1 与 id 3 未认领，`MAX_BYTES` 足够大：批次为 `record_count=2, first_id=1, last_id=3`，id 2 仍为 `older`，id 1 和 id 3 写入同一新 `batch_id`。
- 再按 `sqlite_sequence+1` 插入 id 4 并第二次 `claim`：id 4 单独成批，前三行的 `batch_id` 不变。
- 在 `BEGIN IMMEDIATE` 时向区间内插入 id 2：抛 `archive_claim_changed`，`ark_archive_batch` 为 0，三行 `batch_id` 均为 NULL。
- 把 id 4 的 `envelope` 换成等长字符串且不改 `bytes`：两次 `SELECT *` 的 `Row` 不相等。

RETURNING 在这个 Python 3.12.2 运行库可用。SQLite 从 3.35.0 起提供 RETURNING。仓库已记录的镜像包是 `libsqlite3-0 3.40.1-2+deb12u2`（`docs/prnas-storage-50/t2-complete/evidence/T2-MATURE-PERFORMANCE-REVIEW-GROK.md`）。本次没有在云主机上再执行 `SELECT sqlite_version()`。云上同 SHA 的 16 项测试若跑在该 3.40.1 库上，这四条新 claim/ACK 用例会实际执行；它们没有 `linux` skip。两则 skip 仍是原有的真实 BUSY 时限用例。

## 测试缺口（不构成阻断）

`test_claim_preserves_byte_limit_and_skips_already_claimed_gap` 把 `MAX_BYTES` 设成 id 1 的字节数，区间停在 id 1，没有覆盖「认领 id 1 与 id 3、保留 id 2」的跨空隙路径。函数本身在上面的探测里走过了这条路径。

`test_ack_race_after_validation_keeps_rows_and_does_not_mark_complete` 把信封写成 `{}`，长度也变了。`finish` 比的是 `SELECT *` 全列，等长改写同样会失败。提交里的用例没有使用等长正文。

## 未纳入本结论

云上 16 项和 HTTP BUSY 负向对照仍在运行，这里没有采结果。历史查询变慢也不在这两个文件的 diff 里。
