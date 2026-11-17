# T5 工具候选独立复核（Grok stream-v3-review）

固定 SHA：`e0931608b26586f79e6c27f8743c313b5a567d3f`  
提交：`test(p003): bound T5 load evidence and verify fifty-device fact isolation`  
复核人：Grok 4.6（主13授权只读，会话本目录）  
目标：工具补项独立复核。**不是部署验收，不是 50 档登记，T5 整体未通过。**

本轮只读源码。未改 `src/`、未部署、未 SSH、未打生产、未装依赖、未覆盖主13 `grok-gates-audit/` 与 `t5/stream-v3/`。六份复核文件开工/收尾 blob 相同。

---

## 结论

**工具候选本地补项：通过本复核。** 流式 ACK↔DB 全量对账、异常夹具失败闭合、短样本不能写成 24h、Mac `supported=false` 记未验，均有本轮复跑证据。

**T5 整体：未通过。** 已验证档仍 14。本轮只证明隔离 2×601 工具路径 + 三个单测。600k、成熟盘、Ark 查询 p99、NAS 1h 断线、24h 墙钟、语音 AB、完整 A15 回归都不在本候选证据里。

对会话 374 A01–A15：本候选闭合的是工具侧本地缺口（有界证据、维护子项字段、50 事实矩阵、配置回滚演练）。其余门保持 374 原状态。

---

## 固定候选

| 项 | 值 |
|---|---|
| 全 SHA | `e0931608b26586f79e6c27f8743c313b5a567d3f` |
| 开工 HEAD | 同上 |
| 候选 HEAD（单测/smoke 时） | `e0931608b26586f79e6c27f8743c313b5a567d3f` |
| 落盘时仓库 HEAD | `1b6c1495`；六文件 blob 仍等于候选 |
| 六文件 porcelain | 空 |
| Node | `/Users/fu-121/.local/node-v24/bin/node` v24.19.0 |
| `node_modules` | 现树符号链接，未安装 |
| 原审计 | `/Users/fu-121/.local/state/p003-prnas-t5-20261117/grok-gates-audit`（会话374） |

Blob / SHA-256：

| 文件 | git blob | SHA-256 |
|---|---|---|
| `scripts/storage-capacity-load.ts` | `59b23d3befd6f261b7fb3f892edd51b444e4c306` | `7972535613ce976a2a3bf86d084d240aff9bae40fbf4ab9e4236e5f1277becb3` |
| `scripts/storage-load-ledger.ts` | `3e4779a70932a556b60c1d198c81acf8da866b02` | `160b6f81e333f618f05ed1f1aa6c2fbffe9e91add0ccbd2b9828cb444f3d48fa` |
| `scripts/storage-load-ledger.test.ts` | `4f322c73df6d7f4b122b981b2106aac929868385` | `2f8b8eff92aa04b655a40cef2de2a6baf8163bd5ccd2c0f9af8850b883eefc33` |
| `scripts/storage-load-resources.ts` | `e8a665488c884448c17b2175bfe40362caf4cf10` | `6a6e3b79580a9effe4ceaacf7440dce1d4ade0aa28457aba691d6101da142439` |
| `scripts/storage-load-resources.test.ts` | `418adc81e6d784dc58fea4b81151254c57f9d0c9` | `f2e01e95dbb307a2c91db180fb413ee3c6114fbd60c78d1db87a1a1cbe203410` |
| `scripts/storage-fifty-facts.test.ts` | `858b9dc6f734ba81a2c944b97cc0d0db08144b49` | `009dfccbb8b09692dabd68b488d49b65b78394ec96e39ad97c84137e02fa1912` |

收尾时工作区另有他人改动，本复核未读作证据、未还原：`docs/prnas-storage-50/t5/STATUS.md`（已修改）、`scripts/storage-ark-query-load.ts`（未跟踪）、`docs/prnas-storage-50/t5/grok-gates-audit/`（未跟踪）。

---

## 本轮复跑

命令均在 `2-Projects/P003GameDemo20260513/apps/server`：

```text
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/storage-load-ledger.test.ts
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/storage-load-resources.test.ts
/Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/storage-fifty-facts.test.ts
T5_DEVICES=2 T5_EVENTS=601 T5_BATCH=200 T5_SEED=17 T5_MAINTENANCE=1 T5_BACKUP=1 T5_COVERING_INDEX=1 \
  /Users/fu-121/.local/node-v24/bin/node --experimental-sqlite --import tsx scripts/storage-capacity-load.ts run \
  /Users/fu-121/.local/state/p003-prnas-t5-20261117/grok-stream-v3-review/p003-t5-grok-v3-review-2x601
```

| 套件 | 退出码 | 日志 |
|---|---|---|
| ledger | 0 | `LEDGER.log` PASS：精确 ID/设备/seen/delta、丢失 ACK、非满批、行界、损坏证据、重试顺序、磁盘分位 |
| resources | 0 | `RESOURCES.log` PASS：加速计数器；`summary(3600000).complete_24h_evidence===false`；OOM/重启/缺口/过短/缺测/内存/磁盘 fail-closed |
| fifty-facts | 0 | `FIFTY-FACTS.log` PASS：50 行事实矩阵 + 配置回滚保数据 |
| 2×601 smoke | 0 | `SMOKE-2x601.log`；独立目录 `p003-t5-grok-v3-review-2x601` |

独立 smoke 只读复核（`SMOKE-VERIFY.log`）：

- `stage=T5_INCREMENTAL_LOAD_NOT_FULL_ACCEPTANCE`，`evidence_version=3`，`duration_ms=13501`
- DB：events/seen/settlement=1202，batches=8，dirty=0，facts=2404；JSONL completed=8，requests=9（200=8，503=1 保留）
- `integrity.complete=true`，`evidence_consistent=true`，ACK p95=p99=131.14ms
- Ark 2/2 `source_mode=normal`（负载路径仍只核 family_coin 与 M-CARD-001）
- 维护两轮 `code=0`，含 `pruned.elapsed_ms` / `max_transaction_ms` / `remaining_dirty_days=0`；CLI 墙钟 420ms / 406ms
- Backup API `exit=0`，`spool/published/0948d5eb6c6c4037920570433adaadd0`；备份清单拍到摄入中途（event=600），与终态 1202 并存，符合重叠备份
- 资源 14/14 `supported=false`，`platform=darwin`，`complete_24h_evidence=false`，`local_resource_gate=false`，`required_ms=86400000`；进程仍 exit 0
- `client-result.json` 无整包 `requests`/`completed` 数组；health 尾 14≤256

Mac `supported=false` 按未验记录，不记生产缺陷。13.5s 样本不能当作 24h。

---

## 阻断项（本工具候选）

**无。** 声称范围内的本地工具行为本轮复跑成立。

T5 整体仍被 374 未闭合项挡住，见文末。那些不是本六文件的假绿。

---

## 非阻断建议（精确、可复现，不做大改）

1. **A14 若用本 recorder，CPU/可用内存分层不对。** `linuxResources()` 采主机 `/proc/stat` 与 `MemAvailable`，cgroup 只写入 `cgroup_memory_bytes` / `oom` / `oom_kill` / `pid` / `boot_id`。`summary()` 的 `cpu_average_percent` 与 `mem_available_min_fraction` 不用 cgroup 配额余量。Linux 上可能出现主机 RAM≥20% 而 unit 已近 `MemoryMax`。补法：`cpu.stat` 的 `usage_usec` 差分，`memory.current` 对 `memory.max` 的最小余量写入 summary；缺字段则 `complete_24h_evidence` 保持 false。本轮 darwin 全 `supported=false`，未跑 Linux 路径。

2. **重叠维护异常未接入 run 失败。** `storage-capacity-load.ts` 第 52、55 行 `void maintain()`。`maintain()` 在 stdout 非单行 JSON 时会 throw，该 throw 不写入 `monitorError`。终轮 `await maintain()` 会失败；300s 定时器中的失败在 Node 24 默认 `unhandledRejection=warn` 下仍可让增量负载 exit 0。另：`maintenance[].code!==0` 或 `report.ok===false` 不使 harness 失败，只看终态 `dirty===0`。补法：`void maintain().catch(e=>{monitorError=e})`，并对已记录轮次要求 `code===0`。2×601 两轮均 code 0，本轮未打到该分支。

3. **50 矩阵卡库存 0 未出现。** `n%4===0 → card=null`，`n===0` 同时是 GM，故 normal 行没有 `M-CARD-001=0`。家族币 null/0 已覆盖（normal 各 10 行，例如 n=4 coin=0）。星尘恒为 `200+n`。GM/unknown 各 10 行；跨 owner / epoch 0 / 换绑 epoch 2 有断言。若要卡库存 0，把 `n%4` 与 GM 错开一行即可。

4. **配置回滚测试 reopen 无 admission。** `ArkStore` 无 `admission` 时上限默认 1000。测试证明 clearFlag + `archive=false` 后 50 条 grant/current/seen/outbox 仍在，且日志写明这是兼容配置回滚。它没有断言撤档后第 51 台按已验证档 14 拒绝。那是下一小步，不是旧 32 二进制回滚。

5. **1 Hz `/ready` 仍在。** 有界 ring 已修好无界 `health[]`。24h 时仍会在同一 0.5 CPU 盘上制造观测噪声。降到 10–30s 或独立 cgroup 即可，与本增量 smoke 无关。

---

## 相对会话 374 的工具缺口

| 374 缺口 | 本候选 | 本轮证据 |
|---|---|---|
| 无界 health / 整包 ACK JSON | 已改为 JSONL + ring 256 | smoke `client-result` 无数组；health 14 条 |
| ACK 分位排除 503 | `analyseRequests` 只把 200 写入 latency，attempts 含 503 | 9 attempts / 8 success / statuses.503=1 |
| 全量 ID 用内存 Set | `createStreamingAccounting` O(设备数)，DB GLOB + canonical + seen | 单测 wrong-id/owner/seen-missing/extra-row/actor-failure → `complete=false`；丢失 ACK duplicated=2 |
| 维护只存 CLI 墙钟 | 解析 `analytics-rollup.ts` 单行 JSON，含 `pruned.elapsed_ms` | smoke 两轮均有子项；墙钟≠裁剪耗时 |
| 短样本冒充 24h | `complete` 要求 `requiredMs>=86400000 && elapsed>=requiredMs && unavailable===0 && maxGap<=10000` | 单测 `summary(3600000)` 为 false；smoke `complete_24h_evidence=false` |
| Mac 资源当缺陷 | 非 Linux 返回 `supported:false`，计入 `unavailable_samples` | 14/14 unavailable，exit 0 |
| A04 50 行只核 family_coin/SN | `storage-fifty-facts.test.ts` 核双币、卡、下一奖励、进度秒、奖励小计、GM/unknown、owner/epoch | 单测 PASS；负载 Ark 仍两字段 |
| A15 回滚演练 | 配置回滚保 >32 授权/快照/seen/outbox | 单测 PASS；明示不是旧代码发布回滚 |

主13 `stream-v3/RESULT.md` 口径与本复核一致。本轮独立复跑，未复用其目录。

---

## T5 整体仍未过（不缩范围）

沿用 374 矩阵，本轮未重绑：

- A01–A03、A05、A08 成熟净吞吐、A09 p99、A12 NAS 满、A13 成熟恢复、A15 全回归：仍须按 374 命令在固定 SHA 重跑或补多进程/成熟盘
- A06 300k 仍是 COVER01 新鲜日子项；600k 未跑
- A07 84k RSS / 生产 health 增量未测，且禁止打生产 `/health`
- A10 真人语音、A11 1h 真实 NAS 断线、A14 24h 墙钟：未跑
- 云 40GiB 根盘放不下 44.87GB（41.79GiB）成熟夹具

COVER01 / 本 2×601 都是增量负载，`stage` 字段已标明非完整验收。

---

## 收尾戳

| 项 | 值 |
|---|---|
| 单测 | 2026-11-17T03:30:47Z–03:30:49Z |
| smoke | 2026-11-17T03:31:03Z–03:31:19Z，exit 0 |
| 结束时仓库 HEAD | `1b6c149513f16119c501960bb8b2c332b93ea7a3`（主13后续文档/Ark 查询工具，11:36:20 +0800） |
| 六文件相对 e0931608 的 diff | 空，blob 未变 |
| 六文件是否被本复核改写 | 否 |
| 产出 | 仅本目录 `REPORT.md`、`EVIDENCE.json` 与日志 / 独立 smoke 目录 |

回主13：工具候选可继续后续云端子项准备；T5 不得标通过。
