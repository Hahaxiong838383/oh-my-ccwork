# P003 T1 最终增量定向复验

模型：Grok 4.7。最终候选 `7fa6ed8b265e3095c70231d930e8041164d2c12a`。父提交 `25bb3141ceb689fd55f8fe57ebe195df03db866c`。分支 `codex/p003-prnas-storage-50-20261116`。`git merge-base --is-ancestor 25bb3141 HEAD` 退出码 0。HEAD 就是该候选，只有这一笔提交。未改业务源码或测试，未委派。Node `/Users/fu-121/.local/node-v24/bin/node` v24.19.0。

结论：**PASS_ISOLATED**。主实现复现的关闭后原设备不能恢复，已在本候选的首次种子路径上闭合。`legacy_limit` 取自首次见到的 grant 数，并被规划配额卡住；无 Ark 验证档时上限停在原规模，界面仍标未验证。磁盘门仍在 `legacy` 之前把上限打成 0。这不是 50 台负载通过，也不是生产通过。

## 命令与退出码

工作目录均为 `2-Projects/P003GameDemo20260513/apps/server`，`PATH` 把上述 Node 放在最前。下表是改到该目录后的结果。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run test:storage` | 0 | policy / HTTP / 6 轮双进程竞争 PASS；新 `storage-legacy-scope` PASS：真实服务，3 个旧 grant，关闭、新进程再恢复，环境种子不覆盖，第 4 台拒绝，配额降到 2 后只能恢复 2 台 |
| `ASSET_DIR=/Users/fu-121/.local/state/p003-admin-credential-view-20261109/assets node ../web/scripts/test-analytics-admin-ui.cjs` | 0 | 55 项验收检查 PASS |
| `node node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false` | 2 | stdout 与 `baseline-tsc.log` 字节一致，sha256 `4ab70e064cd2ef96dc8bea4b5e2f32dca1c83e2d1f5f52d013f3aa05b9f559f7`，1267 字节，12 条 `error TS`。`cmp` 退出码 0 |
| `node --experimental-sqlite --import tsx` 同目录 `repro-ark-reenable.mts` | 0 | `before 1` / `after_stop 1` / `PASS reenabled original device`。同脚本在修复前的日志是 `after_stop 0` 且 `STORAGE_CAPACITY_LIMIT` |
| 临时公式探针 | 0 | `min(规划, max(当前, legacy, 验证档))`：legacy 3、验证档 0、规划 1000 得 3；规划 2 得 2；验证档 14、规划 50 得 14。缺 `legacy_limit`、1.5、1001、version 2 均为 `INVALID_ARK_LEGACY_ALLOWANCE` |
| 临时规模探针 | 0 | 环境名单 10 个合法 SN、实际 3 个 grant：种子 `legacy_limit=3`，名单长度仍是 10。关闭后上限仍是 3。规划改到 1000 后第 4 台 `STORAGE_CAPACITY_LIMIT`。`validated_devices=null`，`ark_devices=0`，`limiting_factors` 含 `not_validated` |

先在工作树根目录跑过这三项，storage 与 UI 退出码 1（找不到脚本或路径），tsc 退出码 1 且不是基线日志。上表不包含那三次。

## 7 文件增量

`25bb3141..7fa6ed8b` 共 7 个文件，+86/−12。运行时只改 `src/ark/service.ts` 与 `src/storage/policy.ts`。

首次 `arkStore()` 若还没有 `ark.scope-seed.v1`，把当时 `settings().subjects.length` 写成 `legacy_limit`，并记下过滤后的环境名单。种子写入不创建 grant。之后环境名单再变，已有种子不覆盖；官方新进程用例已覆盖这一点。

准入是 `diskOk ? min(target, max(currentCount, legacyLimit, profile.ark_devices)) : 0`。`diskOk` 仍是可用空间至少 4.5 GiB。`legacy_limit` 因此：

- 不能抬过规划配额。官方用例把配额降到 2 后，第 3 台恢复被拒绝；独立探针把配额抬到 1000，上限仍是 3。
- 无验证档时停在原 grant 数，不升到规划值。`validated_devices` 在 `ark_devices=0` 时仍是 `null`，限制原因仍含 `not_validated`。
- 验证档更高时，上限取验证档与原规模的较大者，再被规划配额卡住。公式探针里验证档 14、legacy 3、规划 50 的结果是 14。
- 磁盘不足时上限为 0，计算发生在把 `legacy` 送进 `arkAdmissionLimit` 之前。

`ArkStore` 未改。生产单例仍把 `arkCapacity().max_enabled_devices` 传进 admission。新授权在 `subjects.length >= limit()` 时拒绝。已有同一 grant 的再次 `authorize` 沿用原比较，不重新问上限。

UI 只增加限制原因文案，以及迟到存储响应、`0`/`1.5`/`1001` 不发 PUT、revision 冲突 409 的断言。55 项脚本已跑过。这些断言不改变服务端准入。

## 旧种子残留

父提交写出的 `ark.scope-seed.v1` 没有 `legacy_limit`。本候选看到该 flag 已存在时不回填。独立探针保持该 JSON 后：`arkCapacity()` 抛 `INVALID_ARK_LEGACY_ALLOWANCE`；清空 grant 后再授权原 SN 同样抛这个错误。这是失败关闭，上限没有被放宽。修复说明写明 25bb3141 未部署、生产未写入该 flag。本轮没有做生产或设备核验。

## 继承的首轮边界

沿用 `REVIEW-GROK.md` / `REVIEW-GROK.json` 的未验范围：没有把磁盘压到 4.5 GiB 以下；没有 50 台真实负载、NAS、真人语音、生产 SSH、短信、设备或开关；T2–T6、小程序、搜索/倾听整套回归、owner 查询套件没有重跑。全仓 tsc 仍是基线 12 错，不能算类型通过。

`BASELINE-FAILURES.json` 里的 search-canary、ble-binding、pairing、sms-auth 四组旧失败，本任务不复跑、不修。工作树在复验期间出现未纳入本提交的 `docs/prnas-storage-50/IMPLEMENTATION.md` 与 `TEST-EVIDENCE.json` 改动，以及原有未跟踪文档。它们不是 `7fa6ed8b` 的内容，本轮没有改它们，也不把它们当实现审查。
