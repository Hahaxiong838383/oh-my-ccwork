# Ark 历史部分覆盖索引只读审计

审计会话：`01a1e7c9-6512-74c3-9fa7-ed1ce07c37d5`（Grok）
回传对象：Codeg 会话 13，external_id `01a12f4d-4458-7af1-85a3-480b2c388d9c`，标题「小可AI语音对话-总调度」
日期：2026-11-17
候选：`65c86916e1e6a64352ec75d3c2b6eebb364e649a`
对比基线：`1cd501b233a8ded3c6af0ec98c7f25873c753f9b`
范围：`2-Projects/P003GameDemo20260513/apps/server` 下五份实现文件，相对 `1cd501b2..65c86916`。

## 结论

可以进入后续隔离 T5 验证。这一提交没有必须先改才能复验的正确性缺陷。

不能把整体 T5 写成通过，不能放宽 A09 或自检脚本，不能部署，不能改真实设备或生产库，不购买磁盘。

索引代码的查询语义、部分索引约束、GM/设备隔离、空库和旧库回落、事务回滚、CLI 锁失败都在固定 SHA 的临时归档上复现通过。已记录的 2 次历史传输失败是客户端 120ms 截止没赶上，reader 侧两次都是 HTTP 200；资产校验没有出错。ACK P95 和 dirty2 的失败不在这次索引差分里，仍然有效。

## 审计边界

`git rev-parse --verify 65c86916^{commit}` 得到 `65c86916e1e6a64352ec75d3c2b6eebb364e649a`。开始时工作树 HEAD 就是这个提交，只多了未提交文档。审计过程中 root 另提交了 `73252b6bcd694ece9991bf81844bc22a4f8c5be1`（`docs(p003): retain 600k load failures and bounded Ark query evidence`）。`65c86916..73252b6` 的 server 代码 diff 为空。本报告不把该文档提交当代码变更。

运行使用 `git archive 65c86916` 抽出的 server 树，目录 `grok-cover-review/sha-65c86916/`。`node_modules` 只符号链接到原工作树，只读复用。Node 为 `/Users/fu-121/.local/node-v24/bin/node`，v24.19.0，SQLite 3.53.3。没有 SSH、部署、装全局依赖、改原树或其他树。结束后 `apps/server` 工作区仍干净。原树 `node_modules/.cache` 的 mtime 仍是 2026-10-21T09:18:59Z。

五文件相对 `1cd501b2` 的 diff：67 行新增、6 行删除。生产启动路径 `src/analytics/store.ts` 不调用 `installArkHistoryIndexes`。新索引只在离线 CLI，或 `storage-capacity-load.ts` 里 `T5_ARK_HISTORY_INDEXES==='1'` 的新建合成库上创建。

## 实现核对

三份部分索引与 `history.ts` 里三条查询的 `event_name IN (...)` 逐字相同。

| 索引 | 事件族 |
|---|---|
| `analytics_ark_evidence_cover_v1` | logical_day_changed、command_failed、runtime_command_completed、gift_became_available、gift_claimed、reward_granted |
| `analytics_ark_assets_cover_v1` | wallet_balance_changed、inventory_changed、makeup_card_balance_changed |
| `analytics_ark_daily_cover_v1` | progress_checkpoint、reward_granted |

`reward_granted` 同时进入 evidence 和 daily，是两条查询本来就各选一次，不是一行被读出两遍。写入时这一事件会维护两份部分索引，只影响该事件的写入代价。

旧库没有这三份索引时，三次查询都 `INDEXED BY analytics_ark_device_event_received`。这是 `1cd501b2` 已有索引。facts/daily 以前没有 hint，现在旧库也会强制走它。对抗数据和去掉 hint 的结果一致，见下。

`EXPLAIN QUERY PLAN`（覆盖索引已安装）：

- `SEARCH e USING COVERING INDEX analytics_ark_evidence_cover_v1 (device_key=? AND event_name=? AND received_at_ms>? AND received_at_ms<?)`
- assets、daily 同样是 `USING COVERING INDEX`，键相同
- 三条都还有 `USE TEMP B-TREE FOR ORDER BY`

临时排序是因为 `event_name IN` 多个值，索引只能在单个 `event_name` 内按 `received_at_ms` 有序，跨事件仍要归并。这不破坏 `ORDER BY`。下面 600 条「更晚收到、更早发生」的钱包没有挤掉真正最新的 777。不为内测去改列顺序。

部分索引约束被 SQLite 强制执行：对 `analytics_ark_assets_cover_v1` 统计 `voice.session_state_changed` 得到 `no query solution`。同一索引上钱包/库存/补签卡家族行数 602，等于表上的 602。3000 条噪声不在该部分索引里。

本机小夹具页数：旧索引 576 页，加上三份部分索引 639 页，差 63×4096=258048 字节。噪声占大多数，部分索引没有把噪声再存一遍。60 万库上 root 已测到的物理增长 41525248 字节仍以那次实验为准，本审计没有重放那份库。

## 语义与兼容

对抗夹具：1 条发生时间最新、值为 777 的家族币；600 条值为 1、发生更早但接收更晚的家族币；另一设备 12345；补签卡 4；20 笔奖励各 1；同一会话进度 100/200/300；3000 条无关事件。`notBefore` 覆盖这些行。

| 路径 | 币 | 卡 | 日进度 | 奖励合计 | 另一设备币 | 与去掉 INDEXED BY 的 JSON |
|---|---|---|---|---|---|---|
| 旧库回落 | 777 | 4 | 300 | 20 | 12345 | 全等 |
| 三份覆盖索引 | 777 | 4 | 300 | 20 | 12345 | 全等 |

GM：同一逻辑日上 `gm_override:true` 后，该设备历史为 `unknown`，币为空。另一设备同日普通标记仍是 `available`，币 44。覆盖索引没有放宽 GM 隔离，也没有串设备。

600 笔日奖励超过 512 行上限时，`daily` 为 null，状态 `unknown`。没有把截断子集加成一笔看起来完整的奖励。

空库：安装前 `unknown`，一次创建 3 个索引，再次调用 `{created:[]}`，安装后仍 `unknown`，连接不在事务中。`sqlite_schema.sql` 与安装语句逐字相同（长度 366/307/267，`equal: true`），所以第二次安装不会误报 `DEFINITION_CONFLICT`。

已有数据的库先读再安装：既有 16 项历史测试在 `ARK_HISTORY_TEST_COVER=1` 下仍 16/16，安装发生在写入之前，覆盖插入路径。

嵌套在 `readSnapshot` 里调用安装：抛出 `ARK_HISTORY_INDEX_REQUIRES_OWN_TRANSACTION`，覆盖索引数 0，连接回到非事务，随后读取仍是 `unknown`。

同名但 `WHERE` 更窄的 assets 索引（只含 wallet）：`readArkHistory` 抛出 `no query solution`，不会静默丢掉库存。`installArkHistoryIndexes` 抛出 `ARK_HISTORY_INDEX_DEFINITION_CONFLICT`，`isTransaction` 为 false，evidence/daily 没有被留下。坏索引还在，之后读取仍是 `no query solution`。这是失败关闭，不是算错余额。正常安装路径不会造出这种索引。

schema 查找：300 次 `arkHistoryReadIndexes` 共 22.774ms，每次 0.0759ms。300 次完整 `readArkHistory`（小库）共 256.604ms，每次 0.8553ms。相对 120ms 内部截止，不值得为内测加缓存。

## CLI 边界

`scripts/ark-history-indexes.ts` 要求绝对路径、文件已存在、且第 3 个参数正好是 `--offline-reviewed`。然后 `busy_timeout=0`，在自己的 `BEGIN IMMEDIATE` 里建三份索引。

| 调用 | 结果 |
|---|---|
| 相对路径 + 标志 | 退出 1 |
| 绝对路径但没有标志 | 退出 1 |
| 绝对路径但文件不存在 | 退出 1 |
| 目录 | 退出 1，`unable to open database file` |
| 空 SQLite 文件、没有 `analytics_event` | 退出 1，`no such table: main.analytics_event` |
| 另一连接已 `BEGIN IMMEDIATE` | 退出 1，`database is locked`，墙钟 304.5ms（含 tsx 启动），没有挂住 |
| 已关闭的 AnalyticsStore 库 + 标志 | 退出 0，`{"created":[三份索引]}`，524.4ms |
| 再跑一次 | 退出 0，`{"created":[]}` |
| 安装后只保留 db 文件再打开 | 仍能看到 3 个索引；当时 `-wal` 为 0 字节 |
| 安装后用 AnalyticsStore 再读 | 家族币 9，与写入值一致 |

CLI 不检查路径是不是生产库，也不核对备份是否真的存在。负载脚本另有 `p003-t5-` 且不含 `/server/data` 的目录限制；CLI 没有这层限制。`--offline-reviewed` 是操作者确认，不是技术锁。对内测离线工具，这够用，不额外加生产路径黑名单。

持锁失败发生在 `BEGIN IMMEDIATE`。空闲的已打开连接如果不持锁，CLI 仍会开始建索引并占住写锁直到三份索引建完。使用前仍要先停写入方。这是操作边界，不是这次要改的代码。

## 测试命令和结果

归档并核对 blob 与工作区 `hash-object` 一致后：

```bash
NODE=/Users/fu-121/.local/node-v24/bin/node
OUT=/Users/fu-121/.local/state/p003-prnas-t5-20261117/grok-cover-review
SERVER=$OUT/sha-65c86916/2-Projects/P003GameDemo20260513/apps/server
export TMPDIR=$OUT/tmp
cd "$SERVER"
"$NODE" --experimental-sqlite --import tsx scripts/ark-history.test.ts
ARK_HISTORY_TEST_COVER=1 "$NODE" --experimental-sqlite --import tsx scripts/ark-history.test.ts
# package.json test:ark 的八个文件，同一个 Node 24，逐个 --import tsx
cd "$OUT"
"$NODE" --experimental-sqlite --import "$SERVER/node_modules/tsx/dist/loader.mjs" probe.ts
```

| 命令 | 结果 |
|---|---|
| `ark-history.test.ts` 默认（旧索引回落） | 16 pass / 0 fail，3614.6ms，退出 0 |
| 同上且 `ARK_HISTORY_TEST_COVER=1` | 16 pass / 0 fail，4089.6ms，退出 0 |
| `test:ark` 八个文件，server-only 归档 | 67 tests，66 pass，1 fail |
| 失败项 | `ark-state.test.ts`：`versioned Android example conforms to executable v1 schema`。`ENOENT .../docs/ark-brain-20261031/snapshot-v1.example.json`。该文件在 `65c86916` 中存在，只是第一次归档只抽了 `apps/server` |
| 从同一 SHA 补上该 JSON 后重跑 `ark-state.test.ts` | 16 pass / 0 fail，623.7ms，退出 0 |

补文件后，八个文件合计 67 pass / 0 fail。第一次那 1 个失败不是候选代码的回归。

`probe.ts` 退出 0。原始 JSON：`grok-cover-review/probe-result.json`。

本审计没有重跑 50×12000 入库，也没有重跑 1000 次 HTTP。root 正在另跑 2×601，这里不并行打同一夹具，也不碰云端。

## 计划 A09 和自检脚本

计划原文（`docs/superpowers/plans/2026-11-16-p003-prnas-50-devices.md` A09）：同设备同数据，本地查询 p99 低于实际最短内部 deadline 至少 20ms；正常健康负载无新增超时降级。另有超时注入条款，本索引差分没有改那条注入路径。

最短内部 deadline 在 `src/ark/runtime.ts`：从 facts 开始剩 `120 - 已用毫秒`。20ms 余量对应 p99 < 100ms。

自检脚本 `scripts/storage-ark-query-load.ts` 更严：

`pass: invalid===0 && transport===0 && q(.99)<=100`

`transport` 是客户端看到的 status 非 200 或 body 未完整，包含 120ms abort。它要求零次这种失败，不是「相对基线不新增」。本审计不改这个判定，也不把 p99 达标说成整门通过。

私有证据（本机只读，未重跑）：

| 文件 | 记录 |
|---|---|
| `ARK-QUERY-AB-MID02.json` | 旧查询基线：1000 次，`history_transport_failures` 338，p95 122.213ms，p99 124.607ms，`invalid_facts` 0，`pass` false |
| `ARK-QUERY-COVER-END.json` | 部分覆盖实验：1000 次，failures 2，p95 34.567ms，p99 47.701ms，`invalid_facts` 0，deadline 120，余量 20，`pass` false |
| `ARK-COVER-FAILURES.json` | 两条失败都是 `correct: true`。`0-0`：客户端 125.088ms，status null，body 未完整；reader HTTP 200，122.038ms。`4-23`：客户端 124.196ms；reader HTTP 200，121.389ms |

p99 47.7ms 低于 100ms，A09 的百分位余量这一个数字达到了。2 次仍然越过客户端 120ms 截止，所以自检 `pass` 为 false 是符合脚本的。相对 338 次是减少，不是新增出更多超时；「无新增超时降级」也不能据此改写成 A09 整句已通过，因为健康负载条款和零失败脚本都还看到截止未赶上的样本。

`resolveArkFacts` 在快照更新或同龄时采用快照。那 2 次 `correct: true` 可以由本地快照满足，不能单独证明客户端用上了那两次历史 body。reader 日志表明服务端查询已以 HTTP 200 结束。没有记录到资产值错误。

这 2 次不是部分索引算错行。reader 用了 121–122ms，只比 120ms 截止多出约 1–2ms，其中第一次是 round 0。不建议放宽 120ms 或把脚本改成允许 2 次失败。

整体 T5 仍未通过，依据仍是 root 已记录的结果，不是本索引实验：50×12000、600000 条、1350.168 秒排空且账目对齐；ACK P95 525.924ms > 500ms；维护末尾 dirty=2，预算耗尽。24 小时、语音 A/B、NAS 断线未验。44.87GB 成熟夹具放不进 40GB 现役盘。500GiB 隔离盘未确认。本审计不建议购买，也不把本地快盘结果当成云盘结论。

## 最小修复

没有必须在下一轮隔离验证之前改的代码。

可选，不挡复验：

1. `arkHistoryReadIndexes` 只认索引名。同名但定义不同的部分索引会让查询 `no query solution`，安装器也不会覆盖它。若要让这种库继续走旧索引，可在命中名字后再比较 `sqlite_schema.sql`，不一致就回落。当前安装语句和存盘 SQL 逐字相同，正规安装不会走到这里。
2. 事件列表在 `history.ts` 和 `history-indexes.ts` 各写一次。这次逐字相同。以后只改查询、不改索引，装上索引后会 `no query solution`。可以把 IN 列表收成一处。现在不改。

不要做：为 0.08ms 的 schema 查询加缓存；为了跨 `IN` 列表去掉临时排序而改索引列；在生产启动时建这三份索引；放宽 ACK 500ms、查询 120ms 或零 transport 失败。

## 能否进入后续 T5

可以，只在隔离环境：

- 候选固定为 `65c86916e1e6a64352ec75d3c2b6eebb364e649a`，或在此基础上只改索引缺陷后的新 SHA。现在不必为索引正确性再改一版。
- 新合成库用 `T5_ARK_HISTORY_INDEXES=1`，或对已停写、已备份的合成库显式跑 CLI。
- 下一轮若复测查询，继续用现有脚本的 `pass` 定义。p99 < 100 且 `invalid_facts=0` 之外，2 次 transport 失败仍然算脚本未过。
- ACK P95 和 dirty2 要单独复验，不能用查询变快代替。

不可以：

- 宣布 T5、A07、A08、A09、A14 通过。
- 在生产启动或现役库上建索引。
- 部署、SSH、改真实设备。
- 购买或扩容 500GiB。成熟库、24 小时、语音、NAS 断线仍待资源确认后再做。

## 证据 SHA256

见同目录 `SHA256.txt`。候选 blob：

- `history-indexes.ts` `1da8f953a6516ce97a892d6c016b476617c5178a`
- `history.ts` `0b2d7a8ab2dd4dd9b8f48335468557c221173eb4`
- `ark-history-indexes.ts` `52e881e2fed64381513316b4fdf95f1f3e6523e5`
- `ark-history.test.ts` `cc7e10b246a8852e9f06897de5e3727fce3e6d8c`
- `storage-capacity-load.ts` `36f6569fff4a7e8623d2f0e52292955a4259f170`

未 commit 根树。
