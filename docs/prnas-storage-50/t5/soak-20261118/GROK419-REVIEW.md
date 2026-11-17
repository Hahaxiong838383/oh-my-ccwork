# 有界复核 16716936 相对 5be3fb4b

结论：这不是混合通过，也不是生产发布验收。权限重检、同一快照的已提交重放、非 BUSY 不重试、最多 3 次尝试，在源码和本机探针里成立。真实写锁冲突在本机 Node 24.19.0 / SQLite 3.53.3 上到不了第二次尝试。`PRAGMA busy_timeout=15` 读回 15，但第二次连接的 `BEGIN IMMEDIATE` 要过约 0.5 秒才以 errcode 5 返回；共享 80ms 预算把这一次等待算进窗口后直接抛出。新增 8 项 HTTP 测试抛的是合成错误，没有锁等待，所以它们是绿的，并不能证明 CLAIM8 那 1 次 Ark errcode 5 会被重试。

候选 `16716936d57315dc529d9aac25f3432cde3d1e0c`，基线 `5be3fb4b63ca96ccf7465217cd9582e10f56e7a5`。只读 `git show` / `git diff`。未改源码，未 SSH，未打云负载，未启动其他代理。测试只用 `/Users/fu-121/.local/node-v24/bin/node`（v24.19.0）。本机默认 `/usr/local/bin/node` 是 v22.14.0，没有用来跑探针。

## CLAIM8 口径

`docs/prnas-storage-50/t5/soak-20261118/CLAIM8-MIXED-INDEPENDENT.json` 的候选是 `5be3fb4b`，状态 `FAIL_INTERRUPTED_MIX_ARK_BUSY_AND_HISTORY`。

- `ark_failure` 长度 1：HTTP 503，`ark_dependency_unavailable`，客户端耗时 875.45ms。
- `ark_errors` 长度 1：`ERR_SQLITE_ERROR`，`sqlite_code` 5。
- `history_failures` 是 18，单独计数。
- `http.503` 是 1980，`http.200` 是 1500。这是文件里的另一组 HTTP 计数。本复核不把它加成 Ark 失败，也不把它说成 1849。
- 1849 来自更早的 WAL64 证据（候选 `10d0dc55`，见 `GROK418-REVIEW.md`），不是本文件的 Ark 次数。1 次 Ark 503 与那 1849 次 Analytics 503 不是同一件事。

`full_600s_completed` 为 false，`24h` 为 `NOT_STARTED`。18 次历史失败的 SQL 不在本 diff 里。Analytics 页缓存缩小没有混合测量。

## 真实 BUSY 走不到重试

`src/ark/store.ts` 仍是 `PRAGMA busy_timeout=15`，该文件不在 `5be3fb4b..16716936` 的 diff 里。`src/ark/busy-retry.ts` 在每次失败后看 `performance.now()`：下一次 10ms 或 20ms 让出加上 15ms 预留若超过起点后的 80ms，就抛出原来的错误。`attempt>=2` 时也会抛出，所以源码上界是 3 次。

本机同一 Node 二进制、SQLite 3.53.3，一个连接 `BEGIN IMMEDIATE` 占着写锁，另一个连接读回 `busy_timeout=15` 后执行 `BEGIN IMMEDIATE`：

| 设置 | 读回 | errcode | 墙钟 |
| --- | --- | --- | --- |
| 0（默认构造） | 0 | 5 | 0.2ms |
| 15 | 15 | 5 | 442–562ms，多次 |
| 1 / 5 / 20 / 100 / 250 | 与设置相同 | 5 | 56 / 273 / 695 / 1380 / 2327ms |

超时 0 立刻返回，说明慢的是忙等回调，不是锁调用本身。墙钟随设置增大，但远大于设置值。把这个真实错误交给 `retryArkBusy`：尝试次数是 1，事务标志为 false，错误仍是 errcode 5。80ms 窗口在第一次等待之后已经关闭，10ms 让出不会发生。

因此「15ms 忙等 + 10/20ms 让出 + 最多 3 次」只在忙等真的大约 15ms 时成立。本机不成立。云上 Linux 的同一 Node 版本是否同样拉长，本次按约束没有测。主 13 若只跑合成 HTTP 测试，看不到这条。需要在云 Node 上对真实第二连接计时，而不是用 NAS 镜像或本机曲线推断。

8 项 `scripts/ark-busy-http.test.ts` 已用 Node 24 重跑：8 pass，0 fail，448ms。持久 BUSY 用例断言 `calls<=3`，合成错误不等待，所以能进第 2、3 次。它覆盖不了上面的真实锁。

## 权限、ABA、已提交重放

重试分支在 `routes.ts` 里于再次 `accept` 之前重读凭据、`identity()`、grant、ceiling。生产接线是 `routes/ark.ts`：ceiling 为 `arkCeiling()`，凭据废止读 `credentialNotBeforeSec`。`readArkIdentity` 每次从设备库返回新对象，账号比较不是同一引用自比。

`authorize` / `configure` 在账号或 epoch 变化时删除当前行并写入新的 `grant_id`。重试比较的是进入请求时的 `grant_id`。A 换成 B 再换回 A，grant 仍是新 UUID，比较失败则 403，不会用旧授权写。本机 HTTP 三项（凭据、owner、grant）都是第一次 `accept` 后改状态，状态码 401 或 403，`calls===1`，outbox 不增加。allowlist 移除在同一布尔式里，不在这三项参数化测试中；源码有 `ceiling().includes`，未另做 HTTP。

重检通过之后、`BEGIN IMMEDIATE` 之前仍有原有的窄窗口。窗口里授权消失时，`accept` 在事务内再次 `grant()`，不写；路由把 `not_authorized` 落到既有 503。这是拒绝写，不是放大权限。

已提交重放探针：第一次 `COMMIT` 已经落盘后再抛 errcode 5。`isTransaction` 为 false，既有 catch 不会回滚已提交行。第二次 `accept` 走同一快照的 duplicate 分支。结果 `current=1`、`outbox=1`、事务关闭。插入前抛 BUSY 的探针：第一次插入被拒绝，回滚后第二次接受，同样 `current=1`、`outbox=1`、`isTx=false`。没有残留事务，也没有第二行。

## 非 BUSY、上界、队列、缓存

真实主键冲突是 `ERR_SQLITE_ERROR`、errcode 1555。低 8 位是 19，不是 5。`retryArkBusy` 只调用一次。errcode 10 的合成 IO 错误由 HTTP 测试断言不重试。低 8 位判断会放行 261 / 517 / 773 这类扩展 BUSY；本机这次真实锁返回的是主码 5。

循环在 `attempt>=2` 抛出，预算不重置。没有新的服务队列或待写数组。只有 `POST /state` 包了 `retryArkBusy`。

`analytics-rollup.ts` 在本进程连接上执行 `PRAGMA cache_size=-8192` 和 `shrink_memory`，再把读回值取负，不是 8192 就抛错，维护任务失败退出。本机读回正好 8192。同一文件的第二个新连接仍是编译默认 `-2000`，设置不落盘，也不改其他进程。`store.ts` 的 writer `cache_size=-65536`、`sqlite-policy.mjs` 的 `synchronous=FULL`、`busy_timeout=250`、`wal_autocheckpoint=0`，以及 `rollup.ts` 的默认 1_000_000 事实 / 30_000ms，都不在本 diff 中。

`storage-ark-export.py` 未改。同提交只加了等长正文和跨空隙测试，本复核没有跑 Python。云上 Python 3.12.3 / SQLite 3.45.1 不由本机或 NAS 镜像代替。

## 未验收

Linux 固定候选、完整混合、24h 都还没在本复核中运行。不能把 8 项合成测试或本机探针写成混合通过。CLAIM8 的 1 次 Ark errcode 5 和 18 次历史失败仍然是 5be3 的实测失败。
