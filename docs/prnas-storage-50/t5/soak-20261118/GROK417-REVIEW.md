# Ark 导出 / 接收事务竞争审查

审查提交 `10d0dc5514671c85c9224d84eff224700172c2cc`。业务源码与 `3b09cde5` 在下列文件上 diff 为空：`src/ark/store.ts`、`src/ark/routes.ts`、`src/ark/archive.ts`、`scripts/storage-ark-export.py`、`scripts/storage-archive.py`。`10d0dc55` 只在 `scripts/storage-capacity-load.ts` 给 `ArkStore.accept` 包了一层日志。未 SSH、未打负载、未改仓库、未动正在跑的 WAL64。

这不是根治证明。结论只覆盖这条代码因果链。

## 结论

导出可以成功，同时前台 `accept` 在写锁上失败并变成 HTTP 503 `ark_dependency_unavailable`。窗口是导出进程持有的 `BEGIN IMMEDIATE`，不是 gzip，也不是 spool 的 fsync/rename。

这条路径没有 gzip。`payload.bin` 是原始 JSONL。`publish_prepared`、工作文件的 `os.fsync` / `os.replace` / `sync_dir` 都在 `transaction()` 之外，持有的是 spool 的 `flock`，不是 SQLite reserved lock。

真正还在 `BEGIN IMMEDIATE` 里做非 SQL 工作的是确认分支 `finish()`：它调用 `batch_payload()`，对最多 1MiB 信封做 `json.loads` 和逐行比对，然后才 `DELETE`。`claim()` 也在同一把写锁里更新最多 1000 行，但那是 SQL。

接收端 `PRAGMA busy_timeout=15` 是毫秒配置，不是一份已经测量过的云端墙钟。锁超时候选异常是 `database is locked`，`code === "ERR_SQLITE_ERROR"`，`errcode === 5`。路由不认识这个 message，重新抛出后被 `onError` 收成与其它依赖失败相同的 503。同内容重试在锁释放后是幂等的；soak 客户端没有重试。

V2 那一条失败不能记成 `SQLITE_BUSY`。见下文证据。

## 因果链

1. Soak 同时跑两件事。`produceArk()` 顺序 `POST /t5/ark/state`（`storage-capacity-load.ts` 115–125 行）。`archiveLoop()` 另起进程跑 `storage-ark-export.py --db <root>/ark.db`（106–109、127–128 行）。两边写同一个 `ark.db`。Node 单线程，所以两个 `accept` 不会并行；并发写者是导出进程。

2. `ArkStore` 打开库时执行 `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15`（`store.ts` 12 行）。`accept` 在 61 行 `BEGIN IMMEDIATE`。拿不到 reserved lock 时，node:sqlite 抛 `Error`，message `database is locked`，`code` 为 `ERR_SQLITE_ERROR`，`errcode` 为 5（本机 Node v22.14.0 对 `node:sqlite` 的只读探测；`errstr` 同为 `database is locked`）。Node 22.14.0 的 `DatabaseSync` 构造函数没有 `timeout` 选项，忙等只来自这条 PRAGMA。

3. `routes.ts` 25–26 行只吞掉 `archive_buffer_full`（503，body 仍是这个 code）、`stale|conflict|before_grant`（409）、`clock_invalid`（400）。`database is locked` 被重新抛出。43 行 `onError` 把其余异常一律收成 `{ok:false,error:"ark_dependency_unavailable"}` 与 HTTP 503。同一 body 还覆盖 `accept` 内部抛出的 `not_authorized`（62 行，外层预检是 403，事务内复检不是）、`archive_sequence_exhausted`，以及 `archivePolicy()` 里 `statfsSync` 抛出的文件系统错误（harness 62 行的 policy 在 `accept` 60 行、拿锁之前执行）。所以 503 加这个 error 字符串不能区分忙锁。

4. 导出连接是 `timeout=.1`（100ms）再加 `BUSY_RETRY_SECONDS=1.0`，并且只对 `sqlite_errorcode & 255 == SQLITE_BUSY` 重试（`storage-ark-export.py` 18–39、148 行）。现有 Linux 测试要求 `sqlite_busy_timeout_ms == 100` 且 `busy_retries > 0`。导出比接收端耐心。导出自己的事务还在提交时，接收端已经可以失败；导出之后仍能 exit 0。`archiveCycle` 把导出非 0 当成另一条断言（`Ark export failed`），与这条 HTTP 503 不是同一个失败点。

5. 写锁持有点：
   - `claim()` 48–60 行：`BEGIN IMMEDIATE` 期间选出最多 1000 行、插入 batch、逐行 `UPDATE ark_archive_outbox`。没有文件 I/O。
   - `finish()` 96–102 行：注释写 “short transaction”，98 行却在锁内调用 `batch_payload()`（整批 `json.loads`、字节比对，上限 `MAX_BYTES=1MiB`），然后删除 outbox。这是会稳定超过 15ms 配置的非 SQL 段。
   - 92、119、138、140、153、168 行是单语句或短更新。COMMIT 仍包含 SQLite 自己的 WAL fsync。若 `ark.db` 所在卷 fsync 很慢，单行更新也可能超过对端忙等。本次没有查看云端挂载点。
   - 116–118 行的 `fsync` / `os.replace` / `sync_dir`，以及 `storage-archive.py` `publish_prepared` 174–198 行的 `sha256`、`fsync`、`os.rename`、目录 `fsync`，发生在 119 行短事务之前，不在 `BEGIN IMMEDIATE` 内。

6. 同内容幂等已经存在，且不增加 outbox。`store.ts` 71 行：`snapshot_id`、`sequence`、`canonicalJson` 三者都相同则 `COMMIT` 并返回 `{status:"duplicate", received_at_ms:旧值}`，返回点在 `appendArkCheckpoint`（76 行）之前。测试在 `ark-state.test.ts` 与 `ark-http-sse.test.ts`。忙等失败发生在 61 行 `BEGIN IMMEDIATE`，事务尚未写入；锁释放后的同 body 重放应是 `accepted` 而不是第二条 checkpoint。若前一次已经 `COMMIT`，重放是 `duplicate`，`received_at_ms` 不变。幂等路径自己也要 `BEGIN IMMEDIATE`，锁还在时重试仍会 503。`produceArk` 123 行对非 200 直接 `assert`，没有 Ark 重试。

## V2 证据为什么不够

`V2-ARK-FAILURE.json` 与 `v2-cadence-evidence-3b09cde5/ark-continuous.jsonl`：302 行，301 次 HTTP 200，1 次 503。失败行是 actor 1、round 6、`snapshot_id=soak-1794945146859-1-6`，body 恰好 `{ok:false,error:"ark_dependency_unavailable"}`，`ms=2086.528`。`at_ms` 在 `fetch` 之前赋值。前一条 actor 0 round 6 的 `at_ms` 早 414ms，自身 `ms=404`，结束后这条才开始，两条请求没有重叠。

延迟：min 5.6ms，p50 12.0ms，p95 170.6ms，唯一大于 1000ms 的就是这次 503。90/302 次成功请求的 `ms` 已经大于 15。客户端 `ms` 含事件循环、`statfsSync`、canonical JSON 和 checkpoint 插入，不等于 SQLite 忙等。

本审查机（Darwin，Node v22.14.0，Python sqlite 3.46.0）上，`PRAGMA busy_timeout=15` 的实测等待约 545–562ms，不是 15ms。`storage-ark-export.test.py` 已写明真实 busy deadline 只在 Linux 部署运行时测量，并 skip 非 Linux。2086ms 对不上源码里的 15ms 配置，也对不上这台 Darwin 机器上 pragma 15 的约 550ms。V2 没有 `errcode`。10d 的 `ark-accept-errors.jsonl` 才会记下 `name`、`code`、`sqlite_code`（即 `errcode`）。`errcode === 5` 才是忙锁；扩展码会原样落下（低 8 位为 5 的 261/517/773 也可分开）。`sqlite_code: null` 则是 `not_authorized`、`archive_sequence_exhausted` 或 `statfsSync` 一类。

## 最小修复

只改 `scripts/storage-ark-export.py` 的 `finish()`。事务外完成信封 JSON 对照；事务内只核对 SQL 不变量：`COUNT(*)`、`MIN(id)`、`MAX(id)`、`SUM(bytes)` 与 batch 元数据一致，再 `DELETE` / `UPDATE`。文件 fsync/rename 保持在事务外。不提高 `busy_timeout=15`，不加进程间大锁，不加新服务。

残余：`claim()` 的最多 1000 行更新，以及每次 `COMMIT` 的 WAL fsync，仍可能长过对端有效忙等。用下一轮 10d 的 `sqlite_code` 和导出 JSON 里的 `busy_retries` 判断，而不是加长前台超时。

## 负向测试

在 Linux 上做。只断言 HTTP 503 的测试无效，因为非忙异常走同一 body。

1. 堵住 `publish_prepared` 的 fsync/rename 时，另一连接按接收端方式 `PRAGMA busy_timeout=15` 后 `BEGIN IMMEDIATE`。期望拿到锁，`errcode` 不是 5。这用来否定 “spool fsync 持有 SQLite 写锁”。
2. 堵住 `finish()` 且 `BEGIN IMMEDIATE` 已持有时，打一发真实 `POST /ark/state`。期望 HTTP 503、body `ark_dependency_unavailable`，并且被吞掉的异常满足 `errcode===5`、`code==="ERR_SQLITE_ERROR"`、message `database is locked`。对照：`throw new Error("forced_non_busy")` 得到同一 HTTP body，且没有 `errcode===5`。两条都只看 503 时，测试必须失败。
3. 释放写锁后重放同一 snapshot。忙等发生在 `BEGIN` 之前则恰好一条 `accepted` 和一个 outbox 行；若前一次已提交则 `duplicate`、`received_at_ms` 不变、outbox 不增加。不要加大 busy timeout。
