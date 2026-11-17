# 候选 61332160 独立评审

日期：2026-11-17T19:39:25+08:00。评审对象只限提交 `61332160fe603b98a3b8cb3141b2ceab4a9db203`（父提交 `24dbad37ae0b289418307d4db9cbbe5bd45acf77`，说明 `fix(p003): drain failed writer and warm Ark history reads`）。相对基线共 13 个文件，+312/−18。

**结论：这 13 个文件里的项目 1 恢复、检查点准入、项目 3 的 evidence/daily 去关联和有界预热，与已通过的设计一致；四项隔离测试的实际 exit code 都是 0。云端 60 万、原 ACK 门和查询门没有在本轮实测。总体 T5 与生产通过都未证实。本范围没有发现需要改源码的缺陷。**

交付时工作树 HEAD 是 `07f8b55246d4767beb0af6244e9a7cc81eb26042`。它堆在本候选之上的两笔提交都未纳入本次测试，也未纳入本结论：`afc2bec31d73656c27df552278c4057c85e5de7e`（`perf(p003): await reader readiness and defer asset metadata reads`）和 `07f8b55246d4767beb0af6244e9a7cc81eb26042`（`test(p003): verify deferred metadata stays in the same read snapshot`）。

## 范围与保护

- Node：`/Users/fu-121/.local/node-v24/bin/node`，`process.version` 为 `v24.19.0`，`process.execPath` 为同一路径。子进程使用 `process.execPath`，因此恢复测试和检查点子进程也是这一份 Node。
- 测试树：`review-candidate/tree`，由 `git archive 61332160` 抽出 `apps/server`。13 个实现/测试文件与该提交的 git blob 字节相同。`node_modules` 是指向既有目录的符号链接，没有安装依赖，没有复制数据库。
- 源码工作树、3006、PM2、语音池、设备 `03800006`、SSH 和生产网络都没有操作。3306 只在归档树的测试进程里短时监听，结束后端口已空。
- 评审开始时工作树曾出现未提交修改（`ark/history.ts`、`ark/warmup.ts` 及对应两个测试）。那些修改随后成为 `afc2bec`。隔离测试始终跑归档树里的 `61332160` 字节，没有回滚或覆盖工作树。
- 设计 `review-design-1` 里「Task 2 未实现」是当时对 `24dbad37` 草稿的描述。本候选已经实现检查点准入。结论按当前提交，不按那份旧状态。

## 已执行测试

工作目录是归档树的 `apps/server`。四份日志都带 `EXIT:` 行，下面的 exit 是该行的值。

| 测试 | exit | 日志 SHA256 |
|---|---|---|
| `scripts/analytics-recovery.test.ts` | 0 | `c7b9be8fec4d7a1f9bce15b849a7e38fcfc3e08c2e46840c07aa3919289d3ac0` |
| `scripts/analytics-checkpoint-admission.test.ts` | 0 | `e8b88f0ce77a725cf8c01cf501c1cdd729f6eda7a45efaa00c2d00de51700fd2` |
| `scripts/ark-history.test.ts` | 0 | `516ce466b8b0df6bb3258312017135e5bee08e043ea20f912cc868ecd1663e4d` |
| `scripts/ark-warmup.test.ts` | 0 | `ae310bc0161dd788916e866042dc84ec7c1425909cbba2801b176a03c1b71476` |

`ark-history` 为 17 项、0 失败，包含「evidence/daily 不读 batch、assets 仍读 batch」和离线覆盖索引的幂等与定义冲突回滚。

预热日志里三次新进程的首次真实 history 耗时为 20.477208ms、27.151792ms、30.678584ms，daily 600 被采纳，snapshot 为 false。这是 3 条合成事件的库，只说明这次测试里的首次采纳落在 125ms 内。

## 已核对的行为

恢复（真实 HTTP，3306，延迟提交的测试 worker，job 时限 30ms）：

- 正常 close 预算和 40ms close 超时两轮都先返回 503 `ANALYTICS_STORAGE_UNAVAILABLE`，此时进程仍在，提交标记尚未出现。
- 迟到提交完成后进程 exit 1。exit 挂在 writer 线程 `onExit` 且 `failed` 已为真的 `fatalExit` 上，不挂在 8 秒拒绝或 30 秒 close 拒绝上。
- 新进程用同一 body 重放：200，`accepted_event_ids` 为空，`duplicated_event_ids` 为原 ID，`rejected` 为空；`analytics_event`、`analytics_event_seen`、`analytics_rollup_fact` 与退出前相同。
- 随后 SIGTERM 的 exit code 为 0。
- 源码没有第二 writer、没有补跑 settle、没有 `worker.terminate()`。8 秒路径是 `rejectPending(false)` 加已有 `close()`。`rejectPending(false)` 不唤醒检查点等待。

检查点：

- `withCheckpoint` 在等待当前 `pending` 之前同步置 `checkpoint`。`busy` 含该标志。批次路由在记 RPM 之前和 `settle` 之前各有一道 `OVERLOADED` / `Retry-After: 5`。
- 测试持有 `BEGIN IMMEDIATE` 时检查点子进程尚未 spawn；当前写入 200 之后才出现 `worker_pid`。
- 子进程 `SIGSTOP` 期间新批 503，`Retry-After` 为 5，错误码 `ANALYTICS_OVERLOADED`，对应 event 行数为 0，`/health` 为 200。断言要求这次 503 在 500ms 内返回；这是单次拒绝的及时性，不是 ACK p95 门。
- 错误节点路径使 `failures===1` 且 `busy` 清除，之后写入 200。等待当前写入时 `stop()` 不再补 spawn，当前写入仍 200，之后 `busy` 清除、`worker_pid` 为空。
- 子进程 `close`（成功、失败、超时）都会 resolve `launch`，`withCheckpoint` 的 `finally` 清标志。查询、`/health`、`/ready` 没有走这道写入门。`/ready` 的 stale 公式仍是 timeout + 3 个周期。
- `FULL`、`wal_autocheckpoint=0`、`busy_timeout`、8 秒、30 秒、10 秒、256MiB 不在这 13 个文件的差异里。`analytics.ecosystem.cjs` 无差异。

历史 SQL 与 120/125：

- evidence 与 daily 使用 `NULL AS client_json`，没有 `LEFT JOIN analytics_batch`。assets 仍是 `b.client_json` 与 `LEFT JOIN`。测试的查询计划对 evidence、daily 否定 `SEARCH b`/`SCAN b`，对 assets 肯定仍有 batch 查找，并核对 `content_version`。
- 谓词、14 天窗、`LIMIT 513`、排序和 `readSnapshot` 没有改。
- `src/ark/runtime.ts` 相对 `24dbad37` 无差异。120ms 剩余预算在第 29 行，125ms 采纳在第 35 行。
- 覆盖索引安装器 `history-indexes.ts` 无差异。本候选没有新增 v2 索引，也没有启动建索引。

预热：

- `warmArkHistory` 只接受 `http://127.0.0.1`、无 userinfo、非空 secret；总预算 1 秒；`redirect: 'error'`；解析 `historySchema` 后丢弃。非法 URL 与空 secret 为 skipped，错误 secret 与服务关闭后为 degraded。
- 常量路由在 internal token 中间件之后，只接受严格空对象，返回 `unknownHistory()` 与 `no-store`。路由本体不调用 `ArkStore`、不 `grant`、不读 `analytics_event`。测试在预热请求之后事件与 seen 仍各为 3。
- Brain `src/index.ts` 在 `serve` 之前 `await` 预热；`ARK_FACTS_PROXY_URL` 存在时跳过。本轮没有执行 Brain 入口，因为默认 URL 是 `127.0.0.1:3006`。
- 读侧生命周期走 `startAnalyticsServer`：测试断言 `query_only=1` 与 `cache_size=-8192`。

## 未执行、不能写成已通过

- 云端 50×12000、60 万、原汇总/备份节奏下的单次 HTTP 200 ACK p95≤500ms 与 p99≤2s。
- 查询侧 1000 次真实 HTTP 的 p99≤100ms 与零失败。上面三次 20–31ms 不能代替这道门。120/125 只确认源码未改，并在合成小库上看到首次采纳未超过 125ms。
- SQL busy（errcode 5/6）的运行时反例。源码上，`writer-thread` 对该结果 `postMessage({ok:false,busy})` 且不退出线程；`onMessage` 只拒绝当前 promise，不置 `failed`，不 resolve `fatalExit`。这条没有单独跑起来。
- 同 ID 不同 hash 的 `client_event_id_conflict`。`ingest.ts` 不在本差异里，本轮没有重跑。
- 退出前 `analytics_batch` 行数。恢复测试核对了 event、seen、rollup fact。源码路径没有第二次 `settle`。
- 主 13 已报告的 `test:analytics`、`test:analytics-capacity`、`test:ark`、`test:storage`、`test:analytics-v375` exit 0，以及 tsc 12 项与独立 `24dbad37` 基线字节相同。本评审没有重跑，不把这些称为全过。
- v2 过滤覆盖索引的页数、EQP 和写入代价。
- 生产 3006、PM2 重启、语音窗和设备 `03800006`。

## 验收门怎么写

用户既有硬门仍是：

- 单次 HTTP 200 ACK：p95≤500ms，p99≤2s。
- 120ms abort、125ms adopt 保持原值。
- 查询 p99≤100ms，且零失败。

设计评审里的「逻辑批次端到端 p95≤2s」是洗数界限的建议，不是用户既有硬门。原门里的 2 秒是单次 200 的 p99。以后做 60 万干预实测时，503 次数（按 `error_code`，`ANALYTICS_OVERLOADED` 再按槽位占用与检查点时间拆开）、Retry-After，以及含 503、连接失败、Retry-After 睡眠和 `restart_delay` 的逻辑批次，必须与 200 分位并列列出。不能靠删掉 503 来宣布 p95≤500。本轮没有这些数，因此不能收口项目 1 的性能，也不能收口 T5。

## 后继提交

相对 `61332160`，交付时 HEAD 多出 4 个文件、+44/−11。`afc2bec31d73656c27df552278c4057c85e5de7e` 把 assets 从批量 `LEFT JOIN` 改为存活行上的 `attempt_id` 点查，并让预热在 1 秒预算内轮询 `/ready`。`07f8b55246d4767beb0af6244e9a7cc81eb26042` 为这次点查补了同一次读快照的测试。这超出本候选已核对的「去关联只影响 evidence/daily」。本评审没有对这两笔提交做隔离测试，不把它们算作通过或失败。

## 评审动作

没有改源码，没有提交，没有部署。产物是本目录的 `REVIEW.md`、`REVIEW.json`、`logs/` 和只读归档树。
