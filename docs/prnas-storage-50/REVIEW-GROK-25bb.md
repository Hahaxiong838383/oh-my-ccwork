# P003 T0/T1 独立复核

模型：Grok 4.7。固定候选 `25bb3141ceb689fd55f8fe57ebe195df03db866c`。父提交 `6612b736ef3c0ac9a0bd2b85bc2aeba176b07392`。分支 `codex/p003-prnas-storage-50-20261116`。`git merge-base --is-ancestor 6612b736 HEAD` 退出码 0。`git diff HEAD` 无已跟踪改动。未改业务源码，未委派。Node `/Users/fu-121/.local/node-v24/bin/node` v24.19.0。

结论：**PASS_ISOLATED**。没有复现出规划配额、已验证档或生产 `arkStore()` 准入被绕过。T2–T6 未做。

## 命令与退出码

工作目录均为 `2-Projects/P003GameDemo20260513/apps/server`，`PATH` 把上述 Node 放在最前。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run test:storage` | 0 | policy / HTTP / 6 轮双进程竞争均 PASS |
| `npm run test:analytics-control` | 0 | policy 与 control HTTP PASS |
| `node --experimental-sqlite --import tsx scripts/ark-proxy.test.ts` | 0 | 4 项 PASS |
| `node --experimental-sqlite --import tsx scripts/ark-proxy-service.test.ts` | 0 | 1 项 PASS |
| `node --experimental-sqlite --import tsx scripts/ark-http-sse.test.ts` | 0 | 9 项 PASS；LLM 是本机 stub，`DEEPSEEK_BASE_URL` 指向 127.0.0.1 |
| `node node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false` | 2 | stdout 与 `baseline-tsc.log` 字节一致，sha256 `4ab70e064cd2ef96dc8bea4b5e2f32dca1c83e2d1f5f52d013f3aa05b9f559f7`，1267 字节，12 条 `error TS` |
| `ASSET_DIR=/Users/fu-121/.local/state/p003-admin-credential-view-20261109/assets node ../web/scripts/test-analytics-admin-ui.cjs` | 0 | 48 项 mock API 浏览器断言 PASS |
| `node --experimental-sqlite --import tsx /tmp/grok-t01-counter.mts` | 0 | 见下 |

先在工作树根目录跑过 storage、control、Ark 与 UI，因找不到脚本或 `tsx` 退出码 1。反例第一次因自拟 SN 日期非法在 `parseUploadChange` 抛 `INVALID_POLICY`，退出码 1。以上表是改到 `apps/server`、改用合法 SN 后的结果。

## 反例

临时目录已删除。默认规划 50、revision 0、Analytics 已验证 14、Ark 已验证 0。保存规划 100 后 `config_meta`、`device_config` 与上传策略快照不变。多余字段和 1001 为 `INVALID_STORAGE_POLICY`。已开启 2 台时降到 1 为 `STORAGE_ENABLED_CONFLICT`。

事务内 `admission.limit=1000` 仍拒绝 15 台，错误 `CAPACITY_LIMIT`，策略回滚。过期 revision 和 `checked_at_ms` 超过 120 秒均为 `STORAGE_POLICY_CONFLICT`。带 `storageRevision` 的真实路由：容量 revision 过期或缺失返回 409；容量上限 100 时 15 台仍 409 `CAPACITY_LIMIT`，已保存名单保持 2 台。

`ARK_CONTEXT_SN_ALLOW=BJP00300000000000001,not-a-sn,BJP00300000000000002` 只写入种子 flag 两个合法 SN，`ark_grant` 为 0。空库 `authorize` 为 `STORAGE_CAPACITY_LIMIT`。直接写入 3 条既有 grant 后，`arkCapacity()` 为 `max_enabled_devices=3`、`validated_devices=null`、`limiting_factors=["not_validated"]`、`free_bytes=73753989120`。第 4 台 `authorize` 和 `configure` 都是 `STORAGE_CAPACITY_LIMIT`。规划改到 1000 后第 4 台仍被拒绝。上传名单仍是原来的 2 台，小时仍是 22。

接收端 `storageControls()` 立刻读到 target 1000、Analytics 14、Ark 0。

同一计数换 3 个新 SN 的 `configure` 成功，授权数仍是 3。这是显式管理替换，不是数量扩张。`authorize` 新增第 4 台仍然失败。

`new ArkStore(path)` 不传 admission 时连续授权了 2 台。`src` 里只有 `ark/service.ts` 的 `arkStore()` 构造 `ArkStore`，并且传入了 admission。管理路由走的是这个单例，没有走到 `??1000` 回退。

## 未作为阻断的阅读结论

配额只写 `storage.policy.v1`。Analytics 新增在容量 HTTP 之后核对 revision，并在配置库事务内再次核对 revision、120 秒新鲜度和 `min(规划, 已验证14, 容量上限)`。关闭不调用容量服务。Ark 变更经 `withStorageAdmission` 先拿配置库写锁，再拿 Ark 写锁；官方 6 轮双进程竞争通过。容量公式每次用当前 policy/profile，磁盘采样仍可缓存 60 秒。搜索与倾听派单源文件不在 `6612..25bb` 差异里。代理客户端不再用 `SEARCH_CANARY_SN` 预过滤；主端 `/internal/ark-facts` 用当前 identity 加 grant，并在异步读取后重核。Ark HTTP 测试注入的是合成 `ark_devices:2`，不是负载验证。

## 未验

本机空闲约 73GiB，没有把 Ark 盘压到 4.5GiB 以下。没有 50 台真实负载、NAS、真人语音、生产 SSH、短信、设备或开关。小程序、搜索/倾听整套回归、owner 查询套件没有重跑；这些路径不在本次差异里。UI 的 `storage-delay` 分支没有被 48 项断言调用；保存规划不覆盖上传小时已在这 48 项里，跨登录丢弃用的是与 overview 相同的 epoch 和 token 判断。工作树另有未跟踪的 `docs/prnas-storage-50/*.json/md`，不属于候选提交，未当实现审查。全仓 tsc 仍有基线 12 错，不能算类型通过。
