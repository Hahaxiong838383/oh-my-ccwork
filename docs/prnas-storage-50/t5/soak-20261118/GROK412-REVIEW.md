# 混合查询拓扑只读复核

结论：同意这版最小测试修正。第 300 秒 `mixed-query-1794939406717` 的 `database is locked` 是测试进程在现役写入期间再次 `new ArkStore` 做 DDL，不是现役 `ark-summary` 查询路径的产品故障。修正后更接近现役「常驻 store + 同一个 HTTP 端同时接收上传和 `ark-summary`」。它不能把本轮预验收成通过，也不能追认已有冷启动失败。

只读。未改 `src`，未跑负载，未 SSH。工作树 HEAD `b5bb1cbf562aad44b46fed9753541c3f73f9c3a4`。`b1ce23aecf2a699c55f81942c76ee05ca48fa5f1` 是 HEAD 的祖先，其间 `apps/server/src` 无差异。

## 现场和代码是否同一件事

正式频率由 `scripts/storage-soak-schedule.ts` 固定：预验 50 设备 × 6000 事件，维护间隔 300000ms，首次维护 2000ms，方舟快照间隔 50000ms，时长 600000ms。

`1794939406717 - 1794939104414 = 302303` ms。本地 `REAL-CADENCE-OBSERVED-1794939720243.json` 记录这次预验 `started_ms=1794939104414`，候选就是 `b5bb1cbf`。302303ms 对上「启动后 2 秒第一次维护 + 300 秒间隔」。同一观察在更早时点只收进 2 份成功查询结果；这个 id 没有结果 JSON。子进程 stderr 不在本机 D 目录，锁定点是按源码和这个时间对齐的，不是按子进程原文。

查询脚本在区分 reader 之前就执行：

- `scripts/storage-ark-query-load.ts` 第 16 行 `new ArkStore(ark.db)`
- `src/ark/store.ts` 构造函数接着执行 `PRAGMA journal_mode=WAL`、`PRAGMA busy_timeout=15`、`CREATE TABLE`、`INSERT OR IGNORE`、`PRAGMA table_info`，以及 `installArkArchive` 的建表、插入和触发器
- 这些语句在 fork reader 之前，也在 `ArkRuntime.preview` 之前

所以锁定发生时还没有查询请求。node:sqlite 把这段 `SQLITE_BUSY` 报成 `database is locked`。15ms 的 `busy_timeout` 撞上父进程 `accept()` 的 `BEGIN IMMEDIATE` 就会失败。第 300 秒同时是第 6 轮快照（50s×6）和导出周期，锁窗口比前两轮大。前两轮能写出 `pass:true`，不能说明第 300 秒的构造是安全的。

父进程最后抛出的是 `Ark export failed`（`storage-capacity-load.ts` 的 `archiveCycle`）。查询失败被 `maintain()` 收进 `maintenanceError`，不会立刻变成这条断言。导出脚本 `storage-ark-export.py` 用 `timeout=0.1` 再拿 `BEGIN IMMEDIATE`。它和查询 DDL 会互相加重锁，但导出失败本身另有记录。去掉查询 DDL 之后仍要看 `ark-export-*.stderr`。

## 和现役拓扑比

现役查询不构造第二份 `ArkStore`。

- 脑侧 `src/ark/service.ts` 把一份 `ArkStore` 和一份 `ArkRuntime` 留在进程里。`preview` 只对这份 store 做 `grant` / `current`。
- 历史走 HTTP `POST /internal/analytics/ark-summary`。`src/analytics/index.ts` 的 `startAnalyticsServer` 用同一个应用接收 `/v1/device/analytics/events:batch` 和 `ark-summary`。`readArkHistory` 读的是 Analytics store，不是 `ark.db`。
- 生产授权是 `AnalyticsDeviceReader.readArkAuthorization`：只读短连接，`busy_timeout` 15ms，没有 DDL。失败变成依赖不可用，不是再建 schema。
- `src/index.ts` 在对外服务前调用一次 `warmArkHistory`。返回 `degraded` 只记日志，不取消后续真实请求。运行时仍用 120ms 截止，并且只接受 125ms 内回来的历史。

当前测试相反：每 300 秒新起查询进程和独立 Analytics reader，两边都 `new ArkStore`；reader 再 `new AnalyticsStore`（构造同样有 DDL）并另开 HTTP。查询打到这个新 reader，不打本轮正在接收上传的那个 app。源进程的 `ArkStore` 负责收快照和归档写入，不是一条常驻查询连接。

因此「启动一次常驻查询子进程；producer 之前完成唯一一次 `ArkStore` 初始化和生产 warmup；查询打本轮同一个 ingest app 的 `ark-summary`；不另造 reader；不每 5 分钟重启或 DDL」比现拓扑接近现役。源业务 `src` 不需要改。

仍有三处不能写成已经等于生产：

1. 子进程里那份长期 `ArkStore` 仍是第二条可写连接。现役脑侧只有写入进程自己的那一份。可以接受，因为只在 producer 之前构造一次，之后 `grant` / `current` 是读。不能在每轮 IPC 里再构造。
2. 补在测试 reader 上的合成 `readArkAuthorization` 若直接调用父进程已打开的 `ark.grant`，测不到生产那条只读短连接、15ms 超时。这是本故障之外的边，不要用这次通过去声明 `ark.db` 在负载下不会忙。
3. 本 harness 把上传和 `ark-summary` 放在同一个进程。生产是脑进程加 3006 上的 analytics 进程。打同一个 app 会把上传和历史读放进一条事件循环，延迟只会更严。P99 变差是这条修正要看的结果。

## 最小改动

只动测试脚本。

`scripts/storage-capacity-load.ts`

- 现有 ingest `reader` 补 `arkDeviceKey` 和 `readArkAuthorization`。键必须等于该 reader 已经用来入库的 `sha256(sn)`。生产 HMAC 键不用于这个合成库。授权只读父进程那份已 `authorize` 的 grant，返回 `not_before_ms`；不要再 `authorize`，缺身份返回 null，不要抛进 503。
- server 已经 listen、writer ready、父进程 `ArkStore` 已建好且尚未 `produceArk` 时，启动一次查询子进程并把本轮 `http://127.0.0.1:<port>` 与同一个 internal secret 交给它。
- `maintain()` 里不再 `spawn` 查询脚本。改为向常驻子进程发一轮 IPC，并等待该轮结束。等待点保持在现在的 `maintain()` 里，这样 first ACK 之后的 `Promise.all([maintain(), archiveCycle()])` 仍和日批请求重叠。
- 子进程退出、IPC 拒绝、或该轮不足 50 条，都算 `failed_cycles`。没有结果 JSON 也要记。warmup 的 `/ready` 和 `/internal/analytics/ark-warmup` 不得写入样本 jsonl。

`scripts/storage-ark-query-load.ts`

- 删除每轮 `fork(..., 'reader')`、第二份 `ArkStore`、第二份 `AnalyticsStore` 和第二份 HTTP。
- 进程启动时构造一次 `ArkStore`，做一次 `warmArkHistory`。`degraded` 或 `skipped` 记入 startup 证据，不因此跳过后续批次，也不再用 `status==='ready'` 取消整轮。
- 每条 IPC 仍对 50 台设备调用真实 `ArkRuntime.preview`。逐条写入现有 jsonl 字段（`ms`、`correct`、`status`、`body_complete`、`query_id`）。第一条设备样本照记。
- 不要依赖 `X-T5-Service-Ms`。那是旧 reader 外壳加的，`createAnalyticsApp` 没有这个头。父门用的是样本自己的 `ms`。

不改 `src/ark/store.ts` 的 15ms，不改 `src/analytics/index.ts`，不改导出超时，不改 120/125、P99≤100、ACK、重叠门。

## 通过这次预验不能代表的事

- 不能把 `ACCELERATED-QUERY-FAILURES.json` 或任何「重启后再 `new ArkStore`」的失败改成通过。那种构造期 DDL 失败继续单独保留。
- 连续方舟的金币判定允许快照前后值。`ark-summary` 即使 200 且历史为 unknown，金币仍可能只靠快照通过。键不一致会漏进这个洞。验收要显式核对 `arkDeviceKey(sn)===sha256(sn)`，并且该轮 `status===200`、`body_complete===true`。
- 本轮父进程死因是导出失败。查询拓扑改完后，预验仍要单独核对导出 exit 0 和 stderr 里没有未解释的 `database is locked`。那不是这次查询修正自动覆盖的。
- 这次观察的 `MemoryPeak=805376000`，贴着 768MiB 上限。常驻子进程算进同一 cgroup。要记 `memory.events` 的 `max` / `oom`。不要用少开进程来放宽内存门。

## 验证要点

不跑 24h，不跑全量 50×6000 作为这次复核。实施后先做短 smoke，再单独跑正式频率预验。

短 smoke 要看到：子进程 startup 早于第一条 `ark-continuous.jsonl`；全程只有一次查询进程构造 `ArkStore`；没有 `*.reader.jsonl`；两轮 IPC 各 50 条，首条样本在 jsonl 里；warmup 记录与样本分开；故意让 warmup 走 `degraded` 时批次仍发出，失败样本仍进 `failed_cycles`。

正式 10 分钟预验沿用现门：样本 ≥150、invalid=0、P99≤100、span≥540000、周期间隔 ≤600000；ACK p95≤500、p99≤2000；`maintenance_overlapped_daily` 与 `backup_overlapped_daily` 仍相对 first ACK。120ms 截止和 125ms 采纳窗口留在未改的 `src/ark/runtime.ts`。任一查询子进程非零退出使预验失败。

## 范围外

未核导出失败的 stderr 分类，未改导出脚本，未核 24h、NAS、72h，未看其他项目记忆。
