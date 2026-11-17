# 最终 07f8b552 四文件增量复验

日期：2026-11-17T19:53:35+08:00。复验对象是 `07f8b55246d4767beb0af6244e9a7cc81eb26042`（父提交 `afc2bec31d73656c27df552278c4057c85e5de7e`，说明 `test(p003): verify deferred metadata stays in the same read snapshot`）。运行源码与 `afc2bec31d73656c27df552278c4057c85e5de7e` 的差异只有测试：`git diff --stat` 为 `scripts/ark-history.test.ts` 一文件 +11。`src/ark/history.ts` 与 `src/ark/warmup.ts` 的 git blob 在这两笔提交上相同，分别是 `7c4eb5e6688f4e070732c73782c952678a7ebc70`、`54365b3421da8c70cbbf668970cea0bd05ea6852`。

相对已通过的 `61332160fe603b98a3b8cb3141b2ceab4a9db203`，差异只有 4 个文件、+44/−11。`src/analytics/writer.ts` blob `90d14c0096f0c07cb90a73356440a68d55db4546` 与 613 相同，本轮不重读 writer。

**结论：这 4 个文件的增量检查通过，没有发现需要改源码的缺陷。没有阻断项。云端 3×1000 只作已落盘证据阅读，不在本轮重跑。整体 T5 与生产通过都未证实。**

## 通过

隔离测试的 exit code 都是 0。工作目录是下面归档树的 `apps/server`。日志末行 `EXIT:` 即该值。

| 测试 | 结果 | 日志 SHA256 |
|---|---|---|
| `scripts/ark-history.test.ts` | 18 pass / 0 fail，`duration_ms` 3260.380584，exit 0 | `9f1f13824d47c7620c9e2b09e0c6d5edad2c7388388aa983522c779100c719c2` |
| 同一测试，`ARK_HISTORY_TEST_COVER=1` | 18 pass / 0 fail，`duration_ms` 3693.122，exit 0 | `5844d7baf1cdbb518a8a1c4d110ef735bf768de5e19fc1d095357842ce17c513` |
| `scripts/ark-warmup.test.ts` | 进程打印 `ark warmup: PASS`，exit 0 | `21a1fabe9672c903de91f68ce5903a7dd549d8f12181ef1b66db68622e710623` |

预热日志里三次 client 的首次 history 为 27.012207999999987ms、27.940832999999998ms、30.11820799999998ms，`daily` 600，`snapshot` false，`warmup` 为 `ready`。这是 3 条合成事件的库，只说明这次测试里的首次采纳落在 125ms 内。

资产元数据：

- `facts` 查询不再 `LEFT JOIN analytics_batch`。它选择事件列、`NULL AS client_json` 和 `e.batch_attempt_id`。evidence 与 daily 仍是 `NULL AS client_json`，没有 batch 查找。两轮 history 里「only asset history reads batch metadata」都通过：三份事件计划都没有 `SEARCH b`/`SCAN b`；合格资产的 `batchReads` 为 1；GM 否决后为 0。
- `content_version` 只在行通过发生时间窗、`notBefore`、可疑时钟、收发时差、`truncated`、GM 日、正常日水位、字段和数值检查之后才查。查询是同一次 `readSnapshot` 里的 `SELECT client_json FROM analytics_batch WHERE attempt_id=?`。`Map` 建在这个回调内部，下一次 `readArkHistory` 会新建。
- `readSnapshot` 在回调前对当前连接做 `BEGIN`（已在事务中则复用），回调结束后 `COMMIT`。这几行不在 4 文件差异里，只为读懂新测试。新测试在已开始的读事务里，用另一条连接把 `client_json` 改成 `changed-after-read-start`，再执行点查。两轮都保持当前结果 `test-content`，紧接着的下一次 `readArkHistory` 读到新值。套件共 18 项；新增的是这一项，名字是 `lazy batch metadata shares the read snapshot and is never cached across requests`。文件里的最后一项仍是离线索引回滚。
- 平局、513 和日奖发放校验与 613 相同，并且在这 18 项里通过：同时刻两个绝对值得到 `null`；513 条钱包事件得到 512；坏奖励行作废小计。`null` 与坏 JSON 的判定式与 613 相同：空 `client_json` 不解析，非空则 `JSON.parse`，`content_version` 仍要匹配 `^[A-Za-z0-9_.:-]{1,64}$`。坏 JSON 仍会抛出并让快照 `ROLLBACK`。本套件没有单独的空 batch 行或坏 JSON 夹具。
- 读完 history 之后的身份与 `grant_id` 复检在 `src/ark/runtime.ts` 第 38–39 行。该文件 blob `9cee37b22aecf3ea0f56935b566be0b2a522ac61` 与 613 相同。第 29 行剩余预算仍是 120，第 35 行采纳仍是 125。摘要路由先核对 account、epoch、`not_before_ms` 再调用 `readArkHistory`；`src/analytics/index.ts` blob `baf5a8fff6f5a9ac3887963860fd5a96ddbcbdc7` 与 613 相同。预热 client 的稳定身份路径拿到了 family_coin 17 和 daily 600，因此这次复检没有把结果清掉。本轮没有在两次 `grant()` 之间改 `grant_id`。

预热：

- `warmArkHistory` 仍只接受 `http://127.0.0.1`、无 userinfo、非空 secret。一个 `AbortController` 在 1000ms 时 abort，`/ready` 循环和后面的 POST 共用它。`redirect` 为 `error`。
- 循环先请求 `/ready`。`ready.ok` 且 JSON `ready===true` 才退出循环；状态不是 503 则返回 `degraded`；503 则在同一 signal 上等待 25ms。现存 `/ready` 在 `health().ready` 为假时返回 503，为真时返回 200。该路由不在本差异里。
- 通过之后才 `POST /internal/analytics/ark-warmup`，body 为常量 `{}`，带 internal token。该路由返回 `unknownHistory()` 与 `no-store`，不调用 `ArkStore`，不 `grant`。`warmup.ts` 里没有 `grant`。
- 测试在套接字已听、`dependency-ready` 尚未写入时得到 `degraded`。写入标记后，端点检查与三个 client 进程 exit 0。服务停止后的调用也是 `degraded`，断言小于 1500ms。事件与 seen 仍各为 3。非法 URL 与空 secret 为 `skipped`，错误 secret 为 `degraded`。
- Brain `src/index.ts` blob `ad636858a13fd3d55322fe50fa50a0e0f08f8033` 与 613 相同。`await warmArkHistory` 之后无条件 `serve()`，只把 status 打到日志。函数失败返回 `{status:'degraded'}`，不抛。本轮没有启动这个入口，因为它的默认 URL 是 `127.0.0.1:3006`。

## 阻断

无。4 个文件里没有发现需要改源码才能合入的缺陷。本轮没有改源码，没有提交，没有部署。

## 未验

- 云端数字是阅读 `/Users/fu-121/.local/state/p003-t5-fix-d13-20261117/cloud-evidence/d13-fix-20261117/` 里已有文件，没有重跑，没有 SSH。`QUERY-V2-RUNS.json` 三轮都是 `synthetic: true`、`samples: 1000`、`failures: []`、`exit: 0`、`pass: true`。p99 为 26.407460000000356ms、24.970807000001514ms、25.262571000000207ms。首样本 `ms` 为 32.72323099999994、82.96229600000015、74.71096299999999。拓扑字符串是同机 `startAnalyticsServer` 3306、8MiB reader、worker/checkpointer 和独立 Brain 查询进程，observation-only runtime copy；驱动还写了 `CPUQuota=100%`、`MemoryMax=768M`。`CANDIDATE-V2.json` 记录的候选是 `afc2bec31d73656c27df552278c4057c85e5de7e`，`archive_sha256` 为 `bed5559d75377a397e1b563f336461121a1ff20ebcd5a086510ac68838cd9093`。本轮没有重算那份远端归档。运行源码与该 SHA 相同，因此这三轮对应的是这份 history/warmup 字节；它不是生产流量，也不是整体 T5。
- 相邻 `PROFILE-RUNS.json` 由 `profile-driver.py` 对 `candidate/` 跑 6 次，每次 `samples: 50`。`CANDIDATE.json` 把该目录标成 `61332160fe603b98a3b8cb3141b2ceab4a9db203`。三次 `ready_wait: false` 的首样本 `ok: false`、`status: null`，各 1 条 failure，exit 1。三次 `ready_wait: true` 的首样本 `ok: true` 且 `failures` 为空；其中 ready-0、ready-1 的 `pass` 仍是 false，ready-2 为 true。本轮没有重推那个 `pass` 公式。
- 相邻 `QUERY-RUNS.json` 15 轮都是 `pass: false`。fix-a/b/c/d 为 50 样本且各有 1–4 条 failure。fix-final 三轮为 1000 样本、各 1 条 failure，p99 为 26.104976999999963ms、29.938685000000987ms、28.337256999999227ms，首样本 185.286427ms、132.48283000000004ms、166.27699200000006ms。这是 v2 之前的记录。
- 单次 HTTP 200 ACK 的 p95≤500ms、p99≤2s，以及 60 万行。上述查询数字不能代替 ACK 门。
- 生产 3006、PM2、语音窗、设备 `03800006`。复验开始时 3306 空闲；预热测试只用归档树进程短时监听，结束后再次为空。
- Brain `src/index.ts` 进程本身。调用点字节未变，但没有把该进程拉起来。
- 空 batch 行、坏 `client_json`、以及 history 读取途中变更 `grant_id`。前两者只做了与 613 的源码对照；第三者只确认稳定路径和未改字节。
- 613 已覆盖的 writer 排空、检查点准入、恢复测试。本轮不重跑，也不把它们重新记成新的通过证据。
- 主 13 可能另有的全量 `test:ark`、tsc 或容量测试。本轮只跑了上面三份命令。

## 范围与保护

- Node：`/Users/fu-121/.local/node-v24/bin/node`，`process.version` 为 `v24.19.0`，`process.execPath` 为同一路径。三份命令都用这个绝对路径，并带 `--experimental-sqlite --import tsx`。子进程 `fork` 使用 `process.execPath`。
- 预热日志开头的 `node` 行在测试结束后补了一行同一二进制的版本。测试正文、`EXIT:0` 和 `3306 free after test` 没有改。上面的日志 SHA256 是补完这一行之后的文件。
- 测试树：`review-final/tree`，由 `git archive 07f8b55246d4767beb0af6244e9a7cc81eb26042 -- 2-Projects/P003GameDemo20260513/apps/server` 抽出。四文件与该提交 blob 字节相同。`node_modules` 是指向 `/Users/fu-121/.codex/worktrees/p003-brain-search-tools-20261021/2-Projects/P003GameDemo20260513/apps/server/node_modules` 的符号链接，没有安装依赖。测试要的 `src/analytics/event-property-schema-v1.json` 已在这份 `apps/server` 归档里，没有从 SHA 外另造夹具。
- 源码工作树里的四文件在复验前后都没有未提交修改。复验期间工作树出现未跟踪的 `docs/prnas-storage-50/t5/fix-d13-20261117/IMPLEMENTATION.md`（mtime 2026-11-17T19:47:05+0800）。本评审没有读它，没有把它放进归档，也没有用它跑测试。

四文件内容 SHA256：

| 文件 | SHA256 |
|---|---|
| `src/ark/history.ts` | `d877e618b69b6eb2826919ce408084e9fc29c940c3f2b146fff9e4ea9131fe6c` |
| `src/ark/warmup.ts` | `727c04fbfd5b5a605eeddad03493c86a2b89115957d50c7837e28eae62056d4b` |
| `scripts/ark-history.test.ts` | `70bd5050f3858cf195e84e1aef2d3488a0519dffb8bad71c96a56aa41b524555` |
| `scripts/ark-warmup.test.ts` | `c1c1874b43743669fc40e65c94f13ec8bfbe4b5a48637326c43acd8d6d1b6c08` |
