# Grok 独立评审：R1 固定候选

评审人：grok。日期：2026-11-16。对象提交 `fe76919cda3a7df4491796844bbb344b0f09bd46`，分支 `codex/p003-mini008-realdata-20261111`。只读业务树，隔离临时库，未部署，未连接生产、C 机或绑定开关，未发同事消息，未 commit / push。

## 结论

本地隔离验证通过。端侧可以按本报告的边界并行编写上传、可靠队列和家长分页。

发布保持关闭，由主13汇总后决定。三方合同仍未冻结。散文版 `SERVER_CONTRACT_R1.md` 不能直接当作冻结文本。整树、旧 Telemetry、旧语音路由和旧 tsc 不在本次通过范围内。来信和 Codex 自检报告没有被当作通过证据。

不需要为已验证的安全属性再改运行时代码。冻结前要改的是合同散文，使第6节和第8节与 DIFF、可执行 schema、以及 context 实际返回值一致。不要把云端默认容量从代码里的 10,000 条 / 32MiB 抬到散文里的 100,000 条 / 256MiB。

## 固定提交与发布范围

工作树干净，HEAD 等于候选。父链为：

- `fe76919c` 修复引用校验并完成交接
- `0af91808` R1 业务实现
- `9d8dd399` / `49ae826e` / `959f1d4b` 现役 Ark、daily、history、币种依赖回流

`9d8dd399..fe76919c` 的 `apps/server/src` 只有这 6 个文件。`release/MANIFEST.json` 的 after SHA256 与工作树逐字节一致：4 个新增记录源文件，`src/routes/ark.ts` 与 `src/routes/telemetry.ts` 两处路由增量。清单要求保持不变的 8 个依赖，包含 `src/index.ts`，哈希全部一致。本地 `production-source` 快照里的 `routes/ark.ts`、`routes/telemetry.ts` 与清单 before SHA256 一致。本评审没有再连生产机。

回流提交还改过 `answer.ts`、`context.ts`、`contracts.ts`、`history.ts`、`language.ts`、`memory-policy.ts`、`xiaoke-kb.ts` 等现役文件。这些文件不在六文件清单里，不能随 R1 整树发布。现役 Ark、mini008、daily、history 部署保持不动。C SN `BJP00326081002000031`、原 owner、grant、凭据和队列没有被本评审触碰。

路由增量只挂上已有进程里的记录路由和 dashboard 的 `data.records`。没有新进程、新钱包、新发币路径或新 PKI。家长游标使用现有 `AUTH_JWT_SECRET` 派生 AES-256-GCM 密钥。允许名单 `ARK_RECORDS_SN_ALLOW` 默认空，并且必须同时落在原 Ark ceiling 内。

## DIFF 两项

`item_references` 必要，并且和端侧提案相容。

端侧要求获得和激活分开，激活不能再算一件新获得，未齐的引用不能伪装成已摆放。原散文只说“查询暂标引用未齐”，没有字段。DIFF 在家长分页上为每条 `activated` 增加 `{item_instance_id, acquired_record_id, status: pending|resolved}`。解析要求同一 save、同一原 owner / device account / epoch / grant，获得序号小于激活序号，且获得记录落在本页游标高水位内。`item_changes` 保持原事实。上传 schema 是严格对象，不接收这个字段。独立探针把 `item_references` 放进上传体，得到单条 `invalid_record`，库内记录数不变。

并行时上传端不要发送该字段。小程序读分页时要容忍这个数组。`status=pending` 只表示引用目标还没进入当前高水位或尚未匹配，不是 `pending_activation`，也不是当前库存或当前缸证明。`resolved` 只表示目标记录已按原归属对齐，不增加数量，也不形成收入。

动态 limits 必要，并且和端侧“先冻结有限额度”的要求相容。

批次 50、原始 body 256KiB、单记录 32KiB、资源 3 行、物品 32 行是代码常量。频率、条数、字节、磁盘余量、游标 TTL 和未来时钟阈值来自 `ARK_RECORDS_*`，缺省为 DIFF 表，非法值直接 503 `records_configuration_invalid`。context 返回实际生效值。独立探针在未改环境时读到与 `schema.mjs` 的 `LIMITS` 相同的对象：每 SN / 全局 10,000 条、33,554,432 字节、8GiB 余量、每 SN 6 次/分钟与 120 次/小时、全局 12 次/分钟与 240 次/小时、context 6 次/分钟、游标 1,800,000 毫秒、未来时钟 300,000 毫秒。随后把额度写成 `0`，context 返回 503，已有分页和旧 Ark 余额仍可读。

散文第8节仍写云端单 SN“100,000 条或 256MiB”。那不是运行默认值。端侧本地待确认队列里的 10,000 条是另一层预算，不能拿来证明云端已经是 10 万条。冻结文本应以 DIFF 和 context 为准。客户端不能自行把额度调大。服务端也不会为了绕过合同自动放大。

两个产品摘要保持 `available=false`、`reason=policy_pending`、币和星尘为 null、物品为空。这不阻止 context、批量上传和分页。允许名单为空时，dashboard 仍返回原 `data.ark` 与 `data.usage`，记录区为 `not_enabled`。独立探针先写入钱包为 0 的 Ark 快照，再上传 `family_coin` delta +2 的奖励记录：分页能读到记录，dashboard 收入仍为 null，Ark 钱包和补勤卡库存仍为 0，非 `ark_record*` 表内容不变。真实业务记录没有用余额差造收入，也没有新钱包或发币。

## 本轮独立验证

Node `/Users/fu-121/.local/node-v24/bin/node`，版本 v24.19.0。使用仓库里已有的 `tsx`、`hono`、`jose`、`zod`。没有安装新依赖。临时库在 `/tmp`，验证后已删除。schema 脚本会改写旁边的样例文件，所以复制到临时目录运行，业务树里的 `examples.json` 未被改写。

| 证据 | 结果 |
| --- | --- |
| `scripts/ark-records.test.ts`，`--test-concurrency=1` | 31 通过，0 失败，约 16.6 秒。日志 `ark-records-test.log` |
| 复制后的 `docs/records-r1/validate.mjs` | 59 通过。日志 `schema-validate.log` |
| `probe-gaps.mts` | 默认限额、无钱包副作用、非法配置失败关闭、慢 body 超时 503 且零写入。日志 `probe-gaps.log` |

31 组覆盖了同 ID 规范化重放与异内容冲突、同 save 序号和 `business_source` 去重、单记录多行回滚、真实 `SQLITE_FULL`、超过 24 小时历史、grant 之前拒绝、normal / gm / unknown、未来时钟、原 owner / epoch / grant 切换、双连接撤销竞争、跨库锁等待、写前撤销、慢 body 期间撤销、批中撤销不返回半 ACK、游标高水位和过期、激活先到后到与重复获得拒绝。1,000 条激活、每条 32 个引用的校验样本为 106.67 毫秒，heap 从 113,310,808 增到 113,567,408 字节。旧 Telemetry 换绑后 usage 仍可见、新 records 当前代际为空的用例也在这 31 组里，它确认的是已知旧边界仍然存在。

慢 body 有两条独立结果。套件在 body 未完成时撤销，返回 401，零写入。探针把 body 停住直到读取超时，返回 503 `records_dependency_unavailable`，没有 ACK，记录数不变。公开错误码没有新增 408。

## 不计入本次通过

没有重跑 16 个归档脚本的 127 项，也没有重跑 Telemetry 脚本内部 37 项、旧 ark-currency 三个语音路由、或 `listening-content.ts:29` 的 `GeminiLlmClient.abort` 类型错误。这些按主13已有基线复现记录保留，本评审不把它们改判，也不把它们算进 records 通过。没有重测 usage p50 约 141 毫秒。没有真机、公网、真实家长 A/B、真实 focus/normal、安卓 outbox 强杀或小程序页面证据。原 mini008 M01–M07 仍未完成。

## 冻结前要改的文本

1. `SERVER_CONTRACT_R1.md` 第8节云端容量改为每 SN 与全局各 10,000 条、32MiB 规范化 payload，并写上 8GiB 共享盘余量。注明 context.limits 是生效值，协议上限 50 / 256KiB / 32KiB 不变。
2. 第6节 ParentRecord 补上 `item_references`。写明只出现在家长读取结果里；`pending|resolved` 与物品状态 `pending_activation|active` 不是同一枚举；pending 不是库存。

启用单 C 前可以另行把 dashboard 里的记录异常与旧 `data.ark` / `data.usage` 分开。当前允许名单为空时不会走到这条路径。允许名单打开后，`recordsDashboard` 与 `dashboardArk` 在同一个 try 里，记录库异常会让整份 dashboard 返回 503。这不阻止本次并行编码，启用前再决定即可。

## 端侧并行边界

可以并行实现：

- `GET /v1/device/ark/records/context` 读取原 grant、epoch、`not_before_ms` 和 context.limits。它不是新凭据。
- `POST /v1/device/ark/records:batch` 使用原 Device Bearer。身份只来自 Bearer。body 里不放 SN、owner 或家长。
- 一条业务记录一次提交。同 ID 同规范化内容视为 duplicate，同 ID 异内容、同 save 序号复用、五类业务原因的 `business_source_id` 换新 ID，都按原 ID 终态拒绝。
- ACK 以 `accepted_record_ids`、`duplicated_record_ids`、`rejected` 为准。HTTP 200 不能清空整队。503、断网和不完整响应整批按原 ID 重放；已经提交的记录会变成 duplicate。
- 同一原 grant 下超过 24 小时的记录可以上报。早于该 grant `not_before_ms` 的已知时间保留原记录并接受 `before_origin_grant`。未知时间保持 null。不要改时钟重试。
- `normal`、`gm`、`unknown` 原样保留。gm / unknown 不进入收益摘要。
- 家长分页沿现有 Bearer 和 public_id。补传只在刷新第一页进入高水位。换账号时丢掉旧 cursor 和页面缓存。
- 旧 `/v1/device/ark/state` 继续严格 schema。余额和补勤卡库存仍走旧 Ark。

当前不能当作已经接通：

- 服务端允许名单仍为空，候选本身不会接收 C 机上传。部署和单机开关归主13。
- 昨日收益和最新物品摘要保持不可用。页面不能把 null 显示成 0，也不能把分页记录自行累加成收入。
- 没有当前 save / 当前缸指针。列表不能推断当前库存。
- 云端默认按 10,000 条和 32MiB 编写背压。全局默认也同样是 10,000 条，不是 50 台预算。
- 换绑后旧 records 对新 owner 不可见。旧队列隔离，不能改标到新 owner。旧 Telemetry usage 仍可能按 SN 看到换绑前片段，这是旧链路边界，本候选没有改它。
- 安卓 durable outbox、强杀、Launcher 逐条结算、真实 APK 回读和手机页面都还没有证据。

署名：grok | 2026-11-16
