# PRnas T3 × 会话360 只读冲突审计

判定：**不能按旧方案宣布安全，也不能互相覆盖工作树。** 提交级 `git merge-file`（基线 `7ccd1f7c`，本树 `ee876889`，360 `5d24359d`）在 `routes/telemetry.ts`、`routes/custom-llm.ts`、`apps/server/package.json` 留下冲突标记。T1 配额文件能干净留下本树版本，但 360 的历史功能挂在同一 `ARK_DB_PATH` 和 `arkCeiling()` 上。整分支合并还会带走 360 相对基线的删除。

审计只读：未改业务代码、未部署、未改配置、未改 360 工作树、未重启服务。未依据 `T3_HANDOFF.md` 或旧的 T3 计划评审宣布安全；交接文档只用来对照 T3 打算改的入口，结论以本次文件和 `git merge-file` 为准。

署名：Grok 4.7（xAI）  
窗口：2026-11-16 22:22 +0800。360 会话仍是 `in_progress`，整合前必须重读 HEAD。

## 会话与两端 SHA

| 端 | 位置 | 提交 | 工作树 |
|---|---|---|---|
| 会话 360 | `codeg://session/360`，codex，标题「小程序端数据是否已齐备」，分支 `codex/p003-mini008-realdata-20261111`，工作树 `/Users/fu-121/.codex/worktrees/p003-mini008-realdata-20261111` | `5d24359d15fb33f5d91621db3dc35af6dd1a4828`（2026-11-16 22:19:47 +0800，`docs(p003): record pushed revisions and shared-memory closeout`） | 干净，0 行 porcelain |
| 本树 T3 | `/Users/fu-121/.codex/worktrees/p003-prnas-storage-50-20261116`，`codex/p003-prnas-storage-50-20261116` | `ee876889647775f3c6c2bb540df7017f3571466f` | **脏**。主 13 正在写 T3，见下表。本审计没有改这些文件 |

共同祖先：`7ccd1f7cd3e9c23b148c4712686dc1a17cdc297a`（2026-11-03，SMS 交接）。

360 代码内容在 `203b63ad7a9c8f81e4708190be650923b5d34697`（22:13:39 +0800，`feat(p003): connect historical conversations and complete miniapp data summaries`）。`5d24359d` 相对它只增加了 `apps/server/docs/parent-history-20261116/` 下的关闭文档，没有再改 `src/`。审计期间 HEAD 从 `d400860b` 走到 `203b63ad` 再到 `5d24359d`；下面的 blob 是 `5d24359d` 上的。

历史功能（360，已在 HEAD）和 T1/T3 配额不是同一套数据：

- 家长历史：`src/parent-conversations.ts`（blob `d05e0ce95cbff7a83a02dfc698b89a74e9ca22d0`），读 `CONVERSATION_DB_PATH`，只读 ATTACH `DEVICES_DB_PATH`。
- 记录 R1：`src/ark/records-store.ts`（blob `197b543bc1fd89cca818497690d816e66746f907`）及 `records-contract.ts`、`records-routes.ts`、`records-service.ts`。`recordsStore()` 先调用 `arkStore()`，再对 **同一个** `ARK_DB_PATH`（默认 `./data/ark.db`）打开第二条连接。
- T1 配额：本树 `storage/policy.ts`、`storage/routes.ts`、`config-store.ts` 的 `storagePolicy` / `STORAGE_CAPACITY_LIMIT`、后台「存储与设备配额」。360 的 `store.ts` 仍是基线版本（blob `9cf9d2158a58`），没有这套配额。
- T3 进行中：本树未提交的 `src/ark/archive.ts` 在同一条 Ark 连接上建 `ark_archive_*`。这不是 360 的 `ark_record*`。

## 冲突锚点

`git merge-file` 有标记的文件（ours=`ee876889`，theirs=`5d24359d`）：

1. `apps/server/src/routes/telemetry.ts` — exit 3，3 处标记。360 blob `0fc728c006341e7e8b0332e156ed23c7c301b3d1`。本树 blob `bc81b3fcc5fb`。双方都改了家长 dashboard。标记里 ours 侧是空的，theirs 侧是历史挂载；若解决冲突时留 ours，历史字段会被删掉。必须两边都留。360 锚点：
   - 第 1 行 `recordsParentRoute,recordsDashboard`
   - 第 9 行 `parentConversationsRoute,parentConversationSummary`
   - 第 200 行 `Variables` 增加 `authRole`
   - 第 203、209 行 `Cache-Control` 与 `c.set('authRole', auth.role)`
   - 第 232–233 行 `parentTelemetryRoute.route('/', recordsParentRoute)` 与 `parentConversationsRoute`
   - 第 255–256 行 `records = recordsDashboard(...)` 与 `dashboardArk` 在同一个 `try` 里
   - 第 264–266 行 JSON 在 `ark` 之后增加 `records` 和 `conversations`
   挂载点在 360 `index.ts` 第 77 行：`app.route('/v1/parent/devices', parentTelemetryRoute)`。
2. `apps/server/src/routes/custom-llm.ts` — exit 2，2 处标记。本树保留 `arkConversationPolicy`；360 增加 `resolveArkUsageQuestion`，并把它用在知识召回。T3 不应改这个文件。整分支合并时不能只留一边。
3. `apps/server/package.json` — exit 1，1 处标记。本树有 `test:storage`、`test:archive`、`test:archive-complete`；360 侧把这段收成只有 `analytics:rollup`。本树工作区的 `package.json` 在审计结束时又变脏，合并前要按新 diff 再看一次。

`git merge-file` 无标记、但覆盖方向错误会拆功能的文件：

4. `src/ark/store.ts` — 干净合并留下本树（blob `cfd79d87bb30`）：`identities.length>1000`，`STORAGE_CAPACITY_LIMIT`，`admission`。360 blob `9cf9d2158a58` 仍是 `>32` 且 `authorize` 在名额满时抛 `invalid_scope`，没有 `STORAGE_CAPACITY_LIMIT`。用 360 文件覆盖会拆掉 T1。T3 未提交 diff 又在构造函数调用 `installArkArchive`，并在 `accept()` 的 `BEGIN IMMEDIATE` 内调用 `appendArkCheckpoint`。
5. `src/ark/service.ts` — 干净合并留下本树。本树第 18 行 `arkCeiling` 是在册 `active` 设备。360 第 14 行 `arkCeiling` 是环境变量名单再 `slice(0,32)`，并带一个写死的单台回退。`records-service.ts` 第 9 行 `recordsAllowed` 要求环境允许 **并且** `arkCeiling().includes(sn)`。合进同一进程后，记录准入会跟着本树的 ceiling 变，这不是文本冲突能看出来的。
6. `src/index.ts` — 无标记，结果留本树第 3 与第 51 行：`allowed:arkAuthorizedSubjects`。360 第 51 行仍是 `ARK_FACTS_PROXY_SN_ALLOW` 拆分。覆盖本树 `index.ts` 会退回环境名单。360 没有改这一行相对基线的另一套逻辑，所以算法没有报标记。
7. `src/routes/admin-data.ts` — 无标记，结果留本树第 1 行 `storageRoute` 与约第 2192–2203 行 `/analytics/storage`、`storageRevision`、四参数 `saveAnalyticsPolicy`。360 的 `admin-data.ts` 没有这条路由。本树工作区又在该路由上加了 `archive` / `saveArchive`（未提交）。
8. `src/ark/contracts.ts` 第 29 行 — 无标记，结果是 `subjects.max(1000)`。基线和 360 都是 `max(32)`。同文件另有 `.max(32)` 用在奖励数组上，那不是设备配额，不要一起改。
9. `src/routes/ark.ts` — 无标记。360 第 1 与第 10 行把 `recordsDeviceRoute` 挂到 `arkRoute`。本树这份文件相对基线没改，合并会保留这两行。用本树旧文件覆盖会拆掉 `POST /v1/device/ark/records:batch` 和 `GET /v1/device/ark/records/context`（`records-routes.ts` 第 17–18 行；`index.ts` 第 68 行挂在 `/v1/device/ark`）。与 T3 的 `POST /state`、`/admin/*` 路径不重叠。
10. `src/ark/routes.ts` — 无标记，留下本树的 `STORAGE_CAPACITY_LIMIT` → 409。工作区未提交改动在 `/state` 的 `catch` 里增加 `archive_buffer_full` → 503 且 `Retry-After: 60`。不要在加 503 时删掉 409。

同一数据库上的锁锚点（两边表名不撞，连接会抢锁）：

- 360 `records-store.ts` 第 17–19 行：第二条 `DatabaseSync(arkPath)`，`busy_timeout=40`，`ATTACH` devices。第 13–14 行注明 ATTACH 参加 `BEGIN IMMEDIATE`，事务内不做等待 IO。第 21–44 行表：`ark_record`、`ark_record_resource`、`ark_record_item`、`ark_record_usage`、`ark_record_rate`。第 47 行 `transaction()` 使用 `BEGIN IMMEDIATE`。
- 本树 `store.ts` 同一默认文件，`busy_timeout=15`。未提交 `archive.ts` 第 12–22 行表：`ark_archive_baseline`、`ark_archive_outbox`、`ark_archive_batch`、`ark_archive_stats`。`appendArkCheckpoint` 注释写明由调用方持有 Ark 事务，函数内不访问网络。
- 记录配额在 `records-contract.ts` 的 `limits()`（约第 35–40 行）：`PER_SN_RECORDS` / `GLOBAL_RECORDS` 默认 10000，载荷字节默认 33554432。这不是 T1 的设备台数，也不是 T3 的 `spool_limit_bytes`。
- 家长对话不打开 `ark.db`。它自己的 `BEGIN` 在对话库上，并只读检查 devices。不要把 `CONVERSATION_DB_PATH` 指到 `ark.db`。

语义不要混用：360 `records-store.ts` 的 `summaries()` 对 `resource_changes` 里 `family_coin` / `stardust` 的 delta 做聚合。T3 `archive.ts` 的 `signature()` 用的是快照 `wallets`、`M-CARD-001`、`next_reward`、`logical_day`。家长 dashboard 的键是 `ark`、`records`、`conversations`、`usage`。归档状态应留在管理端 `/api/admin/analytics/storage`，不要写进这个 dashboard。

## 不可覆盖

不要用 360 覆盖本树这些路径（T1 配额 + 进行中的 T3）：

- `src/ark/store.ts`、`src/ark/service.ts`、`src/ark/routes.ts`、`src/ark/contracts.ts`（`settingsSchema` 的 1000）
- `src/ark/archive.ts` 及 `scripts/ark-archive*.ts`、`scripts/storage-ark-*`、`scripts/storage-archive-control.test.ts`、`scripts/storage-nas-verify.mjs`
- `src/storage/policy.ts`、`src/storage/routes.ts`、`src/config-store.ts`
- `src/routes/admin-data.ts`、`apps/web/public/admin/index.html`、`apps/web/scripts/test-analytics-admin-ui.cjs`
- `src/index.ts` 的 `arkAuthorizedSubjects` 事实代理
- `package.json` 里的 `test:storage` / `test:archive` / `test:archive-complete`
- `src/routes/custom-llm.ts` 里本树的 `arkConversationPolicy` 进口（合并时还要保留 360 的 `resolveArkUsageQuestion`，不能整文件替换）

不要用本树覆盖 360 这些路径：

- `src/routes/telemetry.ts`（只能按上面的锚点并入，不能整文件换成 `ee876889`）
- `src/routes/ark.ts` 第 1 与第 10 行
- `src/ark/records-contract.ts`、`records-store.ts`、`records-routes.ts`、`records-service.ts`
- `src/parent-conversations.ts`
- `scripts/ark-records.test.ts`、`ark-records-race-worker.mts`、`ark-records-summaries.test.ts`、`parent-conversations.test.ts`
- `apps/miniapp/**`（在 `203b63ad` 进入版本库）
- `apps/server/docs/records-r1/**`、`apps/server/docs/parent-history-20261116/**`

不要整分支把 360 合并进 T3。相对基线，360 删除了 `src/economy-shadow/**`、`src/search-canary-guard.ts`、`src/search-canary-main.ts`、`src/tools/amap-weather.ts`、`src/tools/search-simple-fallback.ts`、`src/tools/search-source-scope.ts`。那些删除会在整分支合并时落到本树。T3 不需要那些删除。

T3 不要新建或删除名为 `ark_record*` 的表，不要改 `records-*` 与 `parent-conversations.ts`，不要把归档状态塞进家长 dashboard。

## 最小兼容同步

T3 继续只改本树已在改的配额/归档入口。不要为了“对齐 360”去拷文件。以后若要同一进程同时具备两边，只做下面这些，并且先重读 360 HEAD：

1. `telemetry.ts`：留下本树的 `dashboardArk`、`usage`、owner 复查和 `dashboard_dependency_unavailable`；补上 360 第 1、9、200、203、209、232–233、255–256、264–266 行。`recordsDashboard` 内部已吞掉错误（`records-service.ts` 第 20–21 行）。不要让 `dashboardArk` 在 NAS 失败时抛错，否则同一个 `try` 会把记录和对话一起变成 503。
2. `routes/ark.ts`：在本树 `createArkRoutes(...)` 之后保留 `arkRoute.route('/', recordsDeviceRoute)`。
3. 其余 `records-*`、`parent-conversations.ts`、miniapp、records 文档原样保留，不参与 T3 编辑。
4. `store.ts` / `service.ts` / `contracts.ts` / `storage/*` / `admin-data.ts` / 管理端 `index.html` 以本树（含未提交 T3）为准。归档布尔走单独 CAS；`target_devices` 的 PUT 不改设备开关。
5. `custom-llm.ts` 仅在将来合运行时时手工并上 `resolveArkUsageQuestion`，保留 `arkConversationPolicy`。T3 本阶段不改它。
6. `package.json` 保留本树测试脚本。360 没有等价的 storage/archive 脚本可替换它们。

## T3 应独立验证的兼容用例

用合成身份和临时库。不要扩大真实设备范围，不要靠 T2 验收或 360 的现场结论代替。

1. `POST /v1/device/ark/state`：名额超额仍是 409 `STORAGE_CAPACITY_LIMIT`；`stale` / `conflict` / `before_grant` 仍是 409；`clock_invalid` 仍是 400。`archive_buffer_full` 为 503、`Retry-After: 60`，且 `ark_current` 与 outbox 一起回滚。duplicate 不增加 outbox。噪声不刷新 300000ms 基线。
2. 同一 `ARK_DB_PATH` 上，记录 `POST /v1/device/ark/records:batch` 与 `/state` 并发。两条连接的 `BEGIN IMMEDIATE` 串行；任一边持锁期间不访问 NAS。忙等失败不得写出半截 `ark_current`，也不得丢掉已有 `ark_record` 行。`installArkArchive` 与记录建表都能 `CREATE IF NOT EXISTS`，互不 DROP。
3. `GET /v1/parent/devices/:publicId/dashboard` 在归档开关关、开、以及 NAS 不可达时，仍返回 `ark`、`usage`，并在记录允许时返回 `records` 与 `conversations`。记录依赖失败保持 `recordsDashboard` 的降级对象，不把整个 dashboard 打成 503。对话读取不打开 `ark.db`。
4. `GET /v1/parent/devices/:publicId/ark/records` 与 `.../conversations` 仍要家长令牌；`Cache-Control: no-store` 仍在。分页游标失败不改 `ark_current`。
5. 记录准入：`ARK_RECORDS_SN_ALLOW` 与 **本树** `arkCeiling()`（在册 active）同时满足才写入。只在允许名单里、但不在 active ceiling 里的 SN 不能因为开了归档而写入。关归档不删除 `ark_record*`。
6. 管理端 `GET/PUT /api/admin/analytics/storage` 仍只改规划台数（1–1000，CAS revision）。新的归档 CAS 不得改 verified profile、设备上传开关或 Ark grant。默认归档关闭。关闭后已接受的 outbox 仍可排空；排空不得删除记录行或家长对话。
7. `settingsSchema` 的 subjects 上限保持 1000。记录 `limits()` 的条数/字节上限保持 360 的默认与环境变量名，不要改成 T1 台数或 T3 spool。
8. `/internal/ark-facts` 仍走 `arkAuthorizedSubjects`（当前 grant），不要退回 `ARK_FACTS_PROXY_SN_ALLOW`。语音查询与 `/state` 不读 NAS。
9. 换绑：归档行插入时固定的 sn / account / epoch / grant 不级联删除；记录行的 `origin_*` 同样保留。家长对话范围只认显式配置，不从“当前主人”推断。归档恢复不复活 grant。
10. `custom-llm.ts` 在本阶段字节不变：用法问答与 `arkConversationPolicy` 都不被 T3 diff 碰到。

## 本树审计结束时的未提交范围

这些是主 13 的 T3 工作，不是 360 的脏文件。360 工作树是干净的。

已修改：`package.json`，`scripts/storage-nas-verify.mjs`，`src/ark/routes.ts`，`src/ark/service.ts`，`src/ark/store.ts`，`src/config-store.ts`，`src/routes/admin-data.ts`，`src/storage/policy.ts`，`src/storage/routes.ts`，`apps/web/public/admin/index.html`，`apps/web/scripts/test-analytics-admin-ui.cjs`。

未跟踪：`src/ark/archive.ts`，`scripts/ark-archive-http.test.ts`，`scripts/ark-archive-schema.test.ts`，`scripts/ark-archive.test.ts`，`scripts/storage-archive-control.test.ts`，`scripts/storage-ark-export.py`，`scripts/storage-ark-export.test.py`，`scripts/storage-ark-nas.test.mjs`，`docs/prnas-storage-50/t3/`。

`telemetry.ts` 在本树工作区当时没有未提交改动。一旦主 13 改它，第 1 节的三处标记立即再次生效。
