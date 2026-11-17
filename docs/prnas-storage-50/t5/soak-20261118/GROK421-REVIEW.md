# 审查：assets_cover_v2 是否是下一处最小修复

判断：可以离线另加这只覆盖索引，它不改变这组 SQL 在 SQLite 3.53.3 上已经测到的行集和历史归约结果，也能在匹配行超过 513 时停住扫描。它不是这次 580ms 的修复。当前每个设备大约 316 条资产事件，少于 513，冷读本来就会把整段索引读完。证据查询已经走按 `received_at_ms` 排序的覆盖索引，仍然是 325ms、45056 字节。不要先做 worker 隔离，也不要为了这次失败放宽 0.5 CPU、768MiB、FULL、单 writer、Ark 80ms、查询 120–125ms、P99 100ms。

这次只读。没有改业务源码，没有部署，没有新的云压测，没有另启代理，没有 commit。

## 依据

审查开始时工作区是 `9a5ac270dca8e63b16eec83fe7d599500e33fe32`。写完本文时 `HEAD` 已被同目录里的后续提交推到 `9c5154e767dc5e16d7235d82c4d1c1d63ae081a1`。`git diff 9a5ac270..HEAD` 对 `src/ark` 和 `analytics/store.ts` 是空的。历史 SQL、索引安装和 `busy-retry.ts` 仍是 9a5ac270 的文本。新提交把浸泡的 Ark 生产者挪到已有 Brain 子进程，不改变这条资产 `SELECT`。那次拆分没有在本次重跑。

证据包 `sched-cadence-evidence-9a5ac270.tar.gz` 的 SHA256 是 `10bf9d9e22f4ce9b6aae3f5cec7e089832843fed04968d0a6bcc91ce560a5fa7`，与指定值一致。解包目录里 `INDEX.json` 的 35 个成员逐一复核，SHA256 全部一致。

`SCHED-CADENCE-OBSERVED-1794950778459.json` 与包内原件：

- 50×6000 混合提前失败。`client-result.json` 的 `completed_batches` 是 1470，`attempts` 是 4173。`requests.jsonl` 里 HTTP 200 有 1471 行，HTTP 503 有 2702 行，503 的 `error` 全是 `ANALYTICS_OVERLOADED`。
- Ark 连续请求 303 行：302 次 200，1 次 503。失败行 `at_ms=1794950177386`，actor 2，round 6，客户端 578.715ms，`ark_dependency_unavailable`。
- `ark-accept-errors.jsonl` 两条，都是 `ERR_SQLITE_ERROR`、`sqlite_code=5`，时间 `1794950177843` 和 `1794950177880`，相距 37ms，落在这次 503 的寿命里。`busy_timeout=0` 已经立刻返回，索引改不掉这两次。
- 第三查询窗 `mixed-query-1794950174754`：50 个样本，客户端 20 次没有 HTTP 状态且 `body_complete=false`，p95 121.397ms，p99 148.271ms，`pass=false`。同一窗 `shared-reader.jsonl` 50 次全是服务端 200。服务端超过 120ms 的只有 4 次：910.1、585.5、375.3、449.3ms。另外 16 次客户端超时对应的服务端处理是 6.5–79.7ms。
- 最慢的一条，`mixed-query-1794950174754-0`：资产 `all()` 579.990ms，`thread_read_bytes=135168`（正好 33 个 4096 字节页），`thread_read_calls=40`，`thread_cpu_ms=2.967`。证据 `all()` 324.773ms，45056 字节，15 次读，CPU 1.879ms。请求墙钟 926.867ms，主线程 CPU 9.612ms。
- 这条请求的窗口 `1794950175205`–`1794950176132` 内，接收进程 2499903 有 9 个采样，`wchan` 全是 `folio_wait_bit_common`。时间花在等页，不在排序 CPU。

目录 `event-property-schema-v1.json` 有 57 种事件，资产三种各一条。6000 条一轮是 `6000*3/57=315.8` 条资产事件。1470/1500 批完成后大约仍是 310 条量级，低于 `LIMIT 513`。33 页冷读和这个规模相符：查询把窗口里的资产行都带回来了，没有被 LIMIT 截断。

## 语义

现行资产索引是 `(device_key, event_name, received_at_ms DESC, occurred_at_ms DESC, clock_suspicious, properties_json, batch_attempt_id, session_id, client_event_id)`，部分谓词是那三个事件名。查询是 `ORDER BY occurred_at_ms DESC, received_at_ms DESC LIMIT 513`，所以 3.53.3 的计划是覆盖扫描加 `USE TEMP B-TREE FOR ORDER BY`。

提议的 `analytics_ark_assets_cover_v2` 用 `(device_key, occurred_at_ms DESC, received_at_ms DESC, event_name, clock_suspicious, properties_json, batch_attempt_id)`，保留同一部分谓词。`SELECT` 用到的列都在索引里。3.53.3 的计划变成 `USING COVERING INDEX ... (device_key=? AND occurred_at_ms>? AND occurred_at_ms<?)`，静态字节码里没有 `Sort` / `SorterSort`，也没有 `SeekRowid`。`received_at_ms` 的范围留在扫描中过滤，不打乱 `occurred_at, received_at` 的顺序。

本机 `/Users/fu-121/.local/node-v24/bin/node` 是 v24.19.0，SQLite 3.53.3，与浸泡健康检查里的版本相同。合成库使用同样的表约束、WAL、`synchronous=FULL`。两边插入同一批行后跑同一条 SQL，再按 `history.ts` 的水位、GM、时钟、截断、冲突和 `facts[512]` 边界做归约。

行集和归约都相同的情形：

- 300 条唯一键，加未来行、14 天之外的行、非资产事件。两边都返回 299 行。`occurred_at_ms=now` 且 `received_at_ms=now+5` 的那一行被 SQL 上界排除。
- 2000 条唯一键。两边都是 513 行，同一顺序，边界 `occurred_at_ms` 都是第 513 行的值。更新的家族币被留下，边界上的旧值被置空。
- 316 条、时间交错的三种资产事件。两边 316 行，顺序相同，边界是 null。
- 窗口内的错误时间：`received < occurred-2000`、`clock_suspicious`、`truncated` 仍进入 SQL 结果，归约后丢掉，留下更旧的有效值 42。`received` 或 `occurred` 落在绝对窗口外的行，两边都不返回。
- 授权水位取 `now-2d`。窗口内、水位前的行两边都没有；水位后的行两边都有，顺序相同。
- 同一 `(occurred_at_ms, received_at_ms)` 上两条家族币，值不同：两边都冲突置空。值相同、`content_version` 不同：两边都保留先出现的那条，版本同为 `version-a`。
- 511 条更新的行，再加两条同一时间戳、不同字段的行，正好卡在 512/513。两边边界都是这个时间戳，家族币、星尘、补勤卡都是 null。
- GM 行不在资产 SQL 里。把它放进证据侧之后，两边都把当天资产置空。
- 部分谓词被改短后再 `INDEXED BY` v2，SQLite 报 `no query solution`。`occurred_at_ms` 插入 NULL 被 `NOT NULL` 拒绝。v2 没有另开一条 NULL 通道。

并列键：SQL 没有第三排序键。3.53.3 上把插入顺序反过来、让 inventory 和 makeup 共用同一时间戳，两边仍然都是 inventory 在前。v2 的后续列是 `event_name, clock_suspicious, properties_json, batch_attempt_id`，所以相同时间戳会按这些列在 B 树里排。v1 的 filesort 只承诺前两列。这次没有做出两边不一致的行序，这是这次引擎的观察，不是 SQL 契约。值不同且两条都在保留前缀里时，现有冲突逻辑会置空。卡在第 513 行的同一 `occurred_at_ms` 会被边界置空。不要把 `rowid` 加进查询的 `ORDER BY`，那会把今天没有承诺的次序写成新语义，并可能改掉并列时的 `content_version`。

快照：`readSnapshot` 是 `BEGIN` 加回调里的第一条读。延迟事务的快照从第一条读开始，不是从 `BEGIN` 那一行开始。先读一次再让另一连接提交，打开的快照仍只看见旧行；提交并重新查询后才看见新行。v2 没有把快照拉宽，也没有代替 `not_before_ms`。水位仍是查询参数 `max(notBefore, now-14d)`，不是 SQLite 快照水位。

14 天边界按 SQL 的闭区间执行。正好 `now-14d` 的行留下，早 1ms 的行不在结果里。大窗口本身不改变谓词。超过 513 行时，两边截出的是同一有序前缀，只要排序键没有并列。

## 页读

静态计划在 3.53.3。运行时步数和缓存未命中用 SQLite 3.54.1 打开这些 3.53.3 库，冷连接、`cache_size=-65536`，读的是同一条 SQL。`dbstat` 的页数在 3.53.3 上点过，和未命中一致。

| 数据 | v1 索引页 | v1 未命中 | v1 `vm_step` | v1 sort | v2 索引页 | v2 未命中 | v2 `vm_step` | v2 sort |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 316 行，低于 513 | 25（102400 字节） | 25 | 8597 | 1 | 30（122880 字节） | 30 | 4758 | 0 |
| 2000 行，返回 513 | 110（450560 字节） | 110 | 36650 | 1 | 101（413696 字节） | 28 | 7718 | 0 |

低于 513 时 v2 把排序去掉了，页反而从 25 增到 30，因为整段索引都要读，而按 `occurred_at` 交错的叶子更大。超过 513 时 v1 读完整段 110 页再排序，v2 读 28 页后停止。这才是少读页。

这次浸泡的 135168 字节就是 33 页，和 316 行这一档同一量级。排序 CPU 只有 2.967ms。把计划改成有序，不会把这 33 页的 `folio_wait_bit_common` 变成 100ms 以内。证据侧已经是这种有序覆盖计划，冷读仍是 11 页、324.773ms。

## 要不要先隔离 worker

不需要，也不该先做。

20 次客户端超时里，4 次是查询本身超过 120ms，其中证据一段已经 325ms。把 `SELECT` 挪到 worker，这段页等待还在，这一次调用仍过不了 120–125ms。另外 16 次是主线程停在 folio 上，后面的请求在客户端预算里排队；服务端稍后仍返回 200。worker 只能挪开这 16 次的排队，留不下 P99≤100 和 transport 0。整组仍是 0.5 CPU、768MiB。这次 `MemoryPeak` 是 652963840。再给历史读一条连接和一份页缓存，不会缩短 folio，还会占同一限额。

两条 `sqlite_code=5` 在 Ark 的 accept 连接上，`busy_timeout` 已经是 0。资产索引和历史 worker 都不是这两次锁的修复。

`9c5154e7` 把浸泡里的 Ark POST 放到现有 Brain 子进程，Analytics 与 Brain 仍共用原来的 cgroup。那是测试拓扑，不是这条 `SELECT` 的 worker，也还没有新的混合测量。

## 旧 420 报告里核对过的三处

`review-bounded-root/REVIEW.md` 把慢查询窗口写成 12 个采样。查询 0 的服务端区间是 `1794948684657`–`1794948685775`。`bounded-main-thread-wait.jsonl` 里落在这个闭区间的是 11 个采样：10 次 `folio_wait_bit_common`，1 次 `do_get_write_access`。被算进去的 `R` / `wchan=0` 在 `1794948684655`，比起点早 2ms。

`busy-retry.ts` 第 11–13 行写的是：指数退避会在锁释放之前把 80ms 窗口吃掉，所以每 10ms 看一次，最多六次（`attempt>=5`）。注释是在说明为什么不用指数退避。固定 10ms 不是注释和代码不一致。

保存下来的 Linux 文件 `bounded-linux-physical-busy-v2.log` 仍是 250ms 持锁 → 503、86.603812ms、3 次 BUSY；45ms 持锁 → 200、50.742984ms、1 次 BUSY。本机六次尝试的探针 `ark-zero-busy-physical-macos-v3.log` 是 250ms → 503、73.807ms、6 次 BUSY；45ms → 200、54.420ms、2 次 BUSY。没有找到「45ms 锁、4 次失败、6 次通过」或「503 用了 62ms、200 用了 51ms」的原始记录。`ARK-LOCK-LOCAL.json` 和 `ARK-LOCK-LOCAL-FINAL.json` 是空文件。420 报告把指数注释当成代码错误，这一点不成立。它引用的 Linux 86.604ms / 50.743ms 和那份 v2 日志一致。

## 若以后落地，只保持这些

离线建 v2，读路径在索引存在时指向它。旧库没有 v2 时继续用现有索引。不要在 HTTP 启动时建有数据的索引。安装函数现在用同一套非证据列模板，v2 的列序不同，不能复用那一行字符串。新库不必再同时建 v1，否则每次资产写入维护两套索引。部分谓词、`ORDER BY`、`LIMIT 513`、`not_before_ms`、GM、时钟和边界置空都保持不变。

这只索引可以留作「窗口里资产行超过 513」之后的访问路径。它不替代这次冷页等待，也不构成放宽门限的理由。
