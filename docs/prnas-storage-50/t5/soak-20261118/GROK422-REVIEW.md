# T5 混合脚本拓扑复核

结论：HEAD `9a5ac270dca8e63b16eec83fe7d599500e33fe32` 的 soak 把 `createArkRoutes` 挂在 Analytics 接收进程上，和现役拓扑不一致。现役设备 Ark HTTP 在主 Brain 进程，历史 SQL 在 `127.0.0.1:3006` 的 Analytics 进程。本轮 `mixed-query-1794950174754-0` 的同步历史请求墙钟 926.867ms 期间，同一接收进程上的 Ark POST（actor 1，round 6）测得 2183.638ms 且仍返回 200。这 2183ms 是接收方事件循环被同步 SQLite 堵住后的排队，不能当成现役 Brain 上的 Ark POST 延迟。

最小修正是必要的：把 Ark HTTP 放进已经 fork 出来的 Brain 测试子进程，并让连续 POST 的发起和计时也离开接收方事件循环。不新开进程，不新开 cgroup，不放宽 120/125/100ms 查询门和 Ark 的 200/`accepted` 门。历史冷读 20/150 超时和导出写锁 503 仍是本轮真实失败。

只读。未改业务源码，未部署，未压测，未另启代理。行号来自 `git show HEAD`。工作区里三份脚本相对 HEAD 有未提交差异，本复核不采用、不验收那份差异。

## 现役拓扑

主服务入口加载 Ark 路由，Analytics 是另一个监听。

- `apps/server/src/index.ts:69`：`app.route('/v1/device/ark', arkRoute)`。同文件 `:48` 的端口是 `PORT`，缺省 8787。`:98-99` 在对外服务前调用一次 `warmArkHistory`，内部 URL 缺省 `http://127.0.0.1:3006`。
- `apps/server/src/routes/ark.ts:5-7`：`arkRoute` 就是 `createArkRoutes`，store/runtime 来自 `src/ark/service.ts`。
- `apps/server/src/ark/service.ts:26-40`：进程内一份 `ArkStore`、一份 `ArkRuntime`，`internalUrl` 缺省 `http://127.0.0.1:3006`。
- `apps/server/src/ark/runtime.ts:29-35`：历史请求剩余预算 `max(1, 120 - elapsed)` 后 abort；只有 `performance.now()-started<=125` 才采纳返回的历史。
- `apps/server/src/analytics/index.ts:154-166`：`startAnalyticsServer` 只允许 `3006|3306`，缺省 3006，绑定 `127.0.0.1`。监听前对这份 HTTP 连接执行 `PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA shrink_memory`。`:75-84` 的 `POST /internal/analytics/ark-summary` 和 `:103` 的 `POST /v1/device/analytics/events:batch` 在同一个 Analytics app 上。
- `apps/server/deploy/analytics-start.ts:1-8`：PM2 入口调用 `startAnalyticsServer`，不进入 `src/index.ts`。

线上审计材料是仓库里已有回执，不是这次新探活。`docs/P003_ANALYTICS_SERVER_JOINT_RECEIPT_20261014.json` 的 `pm2` 同时列出 `p003-voice` PID 2817417 与 `p003-analytics` PID 3084873。`docs/P003_ANALYTICS_SERVER_DEPLOY_RECEIPT_20261013.md` 把公司后台记为 3001、采集进程记为回环 3006。源码合同 `docs/analytics-server-contract-v1.md:5` 写明 Analytics 只绑定 `127.0.0.1:3006`，入口不导入主服务。3001 与 8787 的差别来自部署 `PORT`，不改变「Ark HTTP 不在 Analytics 进程」这一条。

## 本轮 harness 在 HEAD 上做什么

证据目录是这次 `systemd-run` 的拷贝。`control/SCHED-CADENCE-START.json` 的单位是 `p003-t5-soak-sched-cadence-01`，`CPUQuota=50%`，`MemoryMax=768M`，候选与 `runtime_candidate` 都是上述 HEAD。启动环境没有 `T5_DIAGNOSTIC_GENERIC_READER`。`T5_DIAGNOSTIC_WAL_RECLAIM=64MiB` 只影响 checkpoint 回收目标。

HEAD `scripts/storage-capacity-load.ts`：

- `:61-64`：未开 generic 诊断时，前台连接是 `query_only=1`、`cache_size=-8192`，并写入 `reader_cache_kib:8192`。本轮 `config.json` 为 `reader_query_only:true`、`reader_cache_kib:8192`、`generic_reader_diagnostic:false`。
- `:65-67`：`T5_DIAGNOSTIC_WAL_RECLAIM=64MiB` 把 `checkpoint_reclaim_target_bytes` 设为 `64*1024**2`。`writer_wal_hard_limit_bytes` 仍是 `256*1024**2`。本轮 config 为 67108864 与 268435456。
- `:82-83`：`createAnalyticsApp` 之后无条件 `app.route('/t5/ark', createArkRoutes(...))`。
- `:88`：这一个 `serve()` 同时接上传、`ark-summary` 和 `/t5/ark/state`。
- `:100`：`startSharedQuery` 把同一个 URL 交给子进程。
- `:136-137`：`produceArk` 在接收进程里 `fetch` 自己的 `/t5/ark/state`，并 `assert.equal(r.status,200)`。失败栈在 `control/sched-cadence.log`，位置 `storage-capacity-load.ts:137`。

HEAD `scripts/storage-shared-query-service.ts` 已经是单独进程：`:9-11` 构造 `ArkStore` 和稍后的 `ArkRuntime`，`:29` 自述拓扑是 `persistent Brain client -> same Analytics HTTP receiver`。`:49` 的 configure 只回 `{id,exit:0}`，没有 `listen`。`scripts/storage-shared-query-client.ts:6` 用 `fork` 拉起它，exec 只有 `--max-old-space-size=128` 与 `tsx`，没有第二个 systemd 单位。子进程因此留在父单位的 0.5 CPU / 768MiB cgroup 里。本轮 `shared-query.startup.json`：查询 pid 2499940，接收 pid 2499903。

`node:sqlite` 的 `DatabaseSync` 在接收进程主线程上同步执行。`runtime.ts` 的 abort 取消不了已经进入的 `all()`。客户端在约 120ms 放弃之后，接收进程仍把这条历史读跑完，并挡住同一条事件循环上的 Ark POST。

## 本轮时间对齐

第三轮查询 `mixed-query-1794950174754`。SQL profile 与 `ark-continuous.jsonl` 对得上。

| 记录 | 时刻或耗时 | 结果 |
| --- | --- | --- |
| profile `...-0` 请求 | start 1794950175205，end 1794950176132，`wall_ms` 926.866808，主线程 CPU 9.612ms | 同步历史读整段 |
| 同请求两条 analytics `all()` | 324.773ms / 45056 字节；579.990ms / 135168 字节 | 926ms 是整段请求墙钟，不是单条语句 |
| Ark POST actor 1 round 6 | `at_ms` 1794950175202，`ms` 2183.638 | HTTP 200，`accepted` |
| profile `...-1` `...-2` | 墙钟 585.458ms、375.344ms，止于 1794950177154 | 仍在同一接收线程 |
| Ark POST actor 2 round 6 | `at_ms` 1794950177386，`ms` 578.715 | 503，`ark_dependency_unavailable` |
| `ark-accept-errors.jsonl` | 1794950177843、1794950177880 | `ERR_SQLITE_ERROR`，`sqlite_code` 5 |
| 导出 `ark-export-1794950176162` | began 1794950176162，done 1794950178358，exit 0 | stdout：`busy_retries` 1，`published` 3 |

actor 1 的 POST 比 926ms 请求早 3ms 开始，2183.638ms 后大约落在 1794950177386，也就是 actor 2 的 503 和 profile `...-3` 的起点。这 2183ms 跨过了 profile 0、1、2 三段同步历史读。它返回的是 200。杀死进程的是下一条 503。

查询侧三轮合计 150 条。前两轮 `history_transport_failures` 为 0，p99 45.976ms 与 42.127ms。第三轮 50 条里 actor 0–19 共 20 条没有 status、没有 body、没有 `receiver_pid`，客户端 `ms` 从 119.741 到 148.271。这 20 条就是 120ms abort 没拿到响应。第三轮 p99 148.271ms，`pass:false`。进程在 `produceArk` 的 503 断言处退出，没有走到 HEAD `:200` 的预验断言；第三轮 JSON 已经记下这 20 条和 p99。

导出写锁是另一件事。`src/ark/routes.ts:51` 把未分类异常收成 503 `ark_dependency_unavailable`。`src/ark/store.ts:59-63` 的 `tryAccept` 在操作期间把 `busy_timeout` 设为 0。`src/ark/busy-retry.ts:4-14` 只对 sqlite code 5 重试，预算 80ms、最多 6 次。两次 code 5 落在这条 503 的 578ms 窗口内，导出事务当时还开着（`storage-ark-export.py:42` 的 `BEGIN IMMEDIATE`，`:18` 的重试预算 1.0s，exit 仍为 0）。把 2183ms 的 200 和这条 503 写成同一次排队，会把写锁失败说没。

## 要不要把 Ark HTTP 放进现有 Brain 子进程

要。现役 Ark POST 的事件循环不是 Analytics 的事件循环。HEAD 把二者合成一个 `serve()`，历史冷读会直接加进 Ark POST 的墙钟。查询子进程已经存在，`fork` 不增加 PID，也不增加 cgroup。在这个子进程上听 `/t5/ark/state` 符合「不增加进程、仍是 0.5 CPU / 768MiB」。

只搬家路由、让 `produceArk` 继续在接收进程里 `await fetch`，不够。接收进程停在同步 `all()` 时，它自己的响应回调也不会跑，测得的 `ms` 仍含这段停顿。发起和计时要跟路由一起留在现有子进程。子进程已经持有 `ArkStore` 和 `ArkRuntime`。接收进程应停止再 `accept`，避免 soak 上同时留着两份可写 Ark 连接。导出仍是独立 Python 进程，这和现役导出不是同一条 HTTP 事件循环是一致的。

保持不动的门：

- `src/ark/runtime.ts:29-35` 的 120ms abort 和 125ms 采纳。
- HEAD `storage-capacity-load.ts:200`：预验样本 ≥150、invalid=0、p99≤100、span≥540000、周期间隔 ≤600000。
- `:137` 的 Ark `status===200` 且 `accepted`。503 仍失败。
- `CPUQuota=50%`、`MemoryMax=768M`。本轮 `SCHED-CADENCE-DONE.json` 的 `MemoryPeak=652963840`，没有顶到 768MiB。

这次修正只改验证拓扑。它不把第三轮 20/150 历史超时改成通过，也不把导出期间的 sqlite code 5 改成通过。actor 2 是在被堵住约 2s 之后才进入导出窗口的；拆开事件循环以后，这条 503 还会不会在同一轮出现，本目录没有对照，不能先判它消失。

## 前台缓存是 8MiB，不是 generic 64MiB

当前前台是 `query_only` 加 8MiB。依据是 HEAD `:61-64`、本轮 `config.json`，以及第三轮维护 stdout `cache_kib:8192`（`maintenance-1794950174754.stdout`）。`scripts/analytics-rollup.ts:14-16` 把维护连接也收成 `-8192`。

64MiB 仍在，但不是这条前台连接：

- `src/analytics/store.ts:39-40` 构造时 `cache_size=-65536`。
- `src/analytics/index.ts:163` 和 harness `:61` 在 HTTP 前台连接上把它改成 `-8192`。
- `src/analytics/writer-thread.ts:21-23` 明确保留 writer 连接的 64MiB pager 预算。
- 本轮 64MiB 环境变量是 checkpoint 回收目标，不是 pager。

下面两份旧摘要把 64MiB 前台写成当时或下一轮的当前配置，套到本 HEAD 和本轮证据上是错的：

- `review-history-cold/REVIEW.md` 第 26 行和第 66 行：下一轮「前台缓存保持 64MiB」，并写「其余与 63de 相同（64MiB 前台）」。本轮启动没有 generic reader 开关。
- `review-shared-failure/REVIEW.md` 第 120 行：测试 HTTP 连接的 pager 预算是 64MiB，因为没走 `startAnalyticsServer`。HEAD harness 自己在 `:61` 做了和生产 `:163` 相同的前台覆盖。

`docs/analytics-server-contract-v1.md:27` 仍只写 `AnalyticsStore` 的 `-65536`。这句话对构造函数和 writer 线程成立，不描述 `startAnalyticsServer` 监听前已经改过的 HTTP 连接。

## 限制

- 没有 SSH，没有重读现网 PM2。3001/3006 的进程拆分用的是 2026-10-13 与 2026-10-14 回执加当前 HEAD 源码。
- 926.867ms 是 profile 请求 `wall_ms`。最长的单条 `all()` 是 579.990ms。
- 第三轮查询门的断言没有执行到。失败内容在已经落盘的 query JSON 里。
- 未证明拆开事件循环后导出 503 不再发生。
- 未复核工作区未提交的三份脚本。未跑短 smoke。
- 合成库的 `readArkAuthorization` 仍读父进程里那份 grant，不是现役 `AnalyticsDeviceReader` 的只读短连接。这不是本轮 2183ms 的原因。
