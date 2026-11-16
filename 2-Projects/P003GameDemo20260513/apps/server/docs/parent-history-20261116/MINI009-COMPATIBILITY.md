# mini009 候选业务流水与线上 R1 兼容性核查

**结论：mini009 已实现业务事实采集、原生持久队列和候选上传链，但当前不能直接连接线上 R1；禁止直接下发开启配置。需要协议修订与端侧适配，不能只改合同名称或放宽服务端校验。C 机历史对话接口及小程序历史展示走独立数据源，不受此阻断影响。**

核查日期：2026-11-16。只读对比 Android 仓库提交 `75378716195bda8e7414af97ffd8dbd0b109212b` 与当前服务端源码；本文件不代表已执行实机上传测试。未修改生产源码、配置、设备、凭据、队列或业务数据。

## 1. 核查对象与状态修正

- Android 仓库：`/Users/fu-121/mycc/2-Projects/kidshub-ai---godot`，以上述 Git 对象为准，不以工作区 HEAD 或旧回执代替。
- 客户端合同：`docs/miniapp-ble/P003_ARK_RECORDS_CLIENT_R1_20261116.md`，请求/响应 schema 为同目录 `ark-records-r1.request.schema.json`、`ark-records-r1.response.schema.json`。
- 原生源码目录：`android_injection/livekit_sdk_probe/payload/src/main/java/com/futurus/p003/launcher/voice/livekit/`，下文简称“原生”。
- Runtime：`rust_runtime/src/g1_business_records.rs`。
- 服务端：[SERVER_CONTRACT_R1.md](../records-r1/SERVER_CONTRACT_R1.md)、[records-contract.ts](../../src/ark/records-contract.ts)、[records-routes.ts](../../src/ark/records-routes.ts)、[records-store.ts](../../src/ark/records-store.ts)。

新证据已经取代“端侧尚未实现”的旧判断。准确状态为：**候选客户端已实现，上传默认关闭；其 wire 与已部署服务端合同不兼容，三方真实对账仍未完成。** 客户端文档本身也明确不表示服务端接受或上线其新增合同，并要求回签后再启用。

## 2. 精确阻断

| 范围 | mini009 实现 | 线上服务端要求 | 结果与源码定位 |
|---|---|---|---|
| 开关与版本协商 | config 必须为 `ark_records.enabled=true`、`contract_id="p003-ark-records-r1"`；直接 POST | 先 GET `/v1/device/ark/records/context`，确认 `contract_version="p003.ark.records.r1"` 并持久化原上下文 | 原生 `ArkRecordsContracts.kt:7,87`、`ArkRecordsCoordinator.kt:120`、`ArkRecordsClient.kt:9`；服务端 `records-routes.ts:17`、`records-store.ts:79`。客户端新 records 模块没有 context 请求实现。两个合同不是同一协议的别名。 |
| 批次信封 | 必含 `schema_version,contract_id,batch_id,save_id,coverage_from_ms,dropped_records,records` | 严格只接 `schema_version,batch_id,records` | 原生 `ArkRecordsStore.kt:90`；服务端 `records-contract.ts:43`。当前合法客户端批次在设备鉴权通过后会因额外字段整批 **400 invalid_envelope**，零业务写入。 |
| 记录结构 | `record_kind=baseline/business_commit`，业务位于 `data.wallet_changes/inventory_changes/grants/...`；另有 config_revision、active_ecotank_id | 每条必须有 `origin_grant_id,origin_epoch,time_quality,reason,business_source_id,tank_id,stage_id,resource_changes,item_changes` 等；严格拒绝多余键 | 原生 `ArkRecordsContracts.kt:41`、Runtime `g1_business_records.rs:64`；服务端 `records-contract.ts:14`。即使只删除信封额外字段，记录仍会逐条 **invalid_record / retryable=false**，不能靠改合同名称解决。 |
| 业务原归属 | 首次原生交接时按当前凭据 scope 落库；没有业务产生时的 grant/Ark epoch | 业务提交时冻结 context 的 `origin_grant_id/origin_epoch`；服务端检查当前授权与原归属一致 | 原生 `ArkRecordsCoordinator.kt:85,109`、`ArkRecordsStore.kt:20`；服务端 `records-store.ts:72,108`。不能证明首次交接前的旧事实属于哪个授权代际。不得由服务端或上传适配器在补传时替旧事实填当前 owner/grant/epoch。 |
| 业务分类及幂等 | 一个 business_commit 包含整次状态差异，可含多个 grants；没有顶层业务原因/来源 ID | 明确 reason 与真实稳定 business_source_id；相同来源防重复，收益只计 normal reward_claim/tank_unlock | Runtime `g1_business_records.rs:86`、`:98`、`:110`；服务端 `records-contract.ts:20`、`records-store.ts:112`。仅把所有正 delta 标为 reward_claim 会扩大收益口径；填 unknown 虽可保留部分事实，也不能让昨日收益成立。 |
| 物品实例与激活 | `inventory_changes` 按 item_id 存 before/after；没有稳定获得实例 ID 及获得记录引用 | acquired 必须有 `item_instance_id`；activated 必须引用 `acquired_record_id`，同 save/原归属/向后 sequence | Runtime `g1_business_records.rs:46,93`；服务端 `records-contract.ts:10`、`records-store.ts:83`。不能只按 item_id 将不同获得混为同实例，也不能把 pending_activation→active 当再次获得。 |
| ACK 可重试拒绝 | 只读取 rejected 的 record_id/reason；全部写成 rejected 终态，退出 pending | `capacity_exceeded` 返回 `retryable=true`，必须保留待重试并至少退避 15 分钟 | 原生 `ArkRecordsContracts.kt:76`、`ArkRecordsStore.kt:107`；服务端 `records-routes.ts:29`。**当前客户端会将可重试容量拒绝误结算为终态。正文仍在死信中，但自动投递资格已丢失。** |

批次路径与 Device Bearer 本身一致：原生 `ArkRecordsClient.kt:10` 使用 `/v1/device/ark/records:batch`，服务端也提供该路径。故阻断不是 URL 或新增认证系统。

## 3. 归属 scope 的额外限制

原生 `ArkRecordsCoordinator.kt:109` 从 JWT 读取名为 `epoch` 的 claim，有值时散列 SN+epoch，否则散列整枚 token。当前服务端配对签发 `routes/pairing.ts:74` 提供 `binding_version`，没有这个 `epoch`；Ark records 的授权 epoch 来自 context，二者不能混同。

按该签发路径，mini009 会落入 token 指纹分支。同一授权正常续凭据也会改变 scope。`ArkRecordsStore.kt:25` 又把 coverage 的 save_id 固定到首次 scope：旧队列不会自动跨 scope 上传，同一 save 的后续交接也会因 `save_identity_changed` 暂停。这是保守隔离，但不能等价于服务端“同 grant/epoch 下续凭据继续上报”。

更关键的是，Runtime 原记录没有 origin 字段；若事实尚未首次交接，就无法仅凭交接时的新 token 证明其原归属。最小修订必须在业务发生之前获得并持久化 context，在事务内将原 context 与事实一起冻结。已产生而没有原 context 的记录只能保留为 unattributed/待核；不得批量套当前授权、改 ID、改 save 或用新发生时间包装成新记录。

## 4. 还需明确的语义与边界

1. **baseline 不可改成收入或新获得。** Runtime 首次生成 baseline（`g1_business_records.rs:76`），线上 R1 没有基线记录类型。最小接入可继续在本地保留基线，当前 v1 上传仅发送可准确表示的真实事务。若要云端接收基线，需单独出兼容修订，并明确不进入收益或最新获得摘要。
2. **混合事务不能盲目拆成多笔。** 当前候选按整次状态提交记录，可能同时有多奖励、卡变化或状态变化；线上 reason 有方向和组成限制（`records-contract.ts:21`）。应由真实业务操作生成稳定分类/来源，明确完整事务如何表达；无法无损映射的类型应先保留，必要时出正式扩展。不要通过重复分摊钱包 delta 或任意子 ID 制造多笔收入。
3. **资源须显式映射。** 候选使用 `C-FAMILY-001/C-STARDUST-001`，线上使用 `family_coin/stardust`，卡仍为 `M-CARD-001`。仅对已知语义映射；物品 kind 同样需明确映射，例如 Runtime 测试中的 `ecotank_part` 与线上 `tank_component`。
4. **时间与数值不能截断。** 候选 occurred_at_ms 为非负整数，线上未知时间为 `null + time_quality=unknown`，已知时间为 1..8e12；通用 ID 上限为候选 96、线上 80。JSON 安全整数、真实日期、资源正负方向及 1e9 资源边界也需端侧遵守；不可改写旧事实去满足校验。
5. **覆盖和满队列政策未一致。** 候选 Rust outbox 满 2048 后递增 dropped_records 并继续业务（`g1_business_records.rs:54`）；线上合同要求可靠记录提交失败时回滚新资源业务，且不接收候选 coverage_from_ms/dropped_records 信封字段。应先回签容量/缺口政策及暴露方式，不能简单删字段让缺口不可见。线上 coverage.complete=false 仍必须保留。
6. **已有兼容部分可保留。** 候选 16 条/64KiB 比线上 50 条/256KiB 更保守；单条均为 32KiB。accepted/duplicated 的字段、batch_id 校验、集合互斥、部分 ACK 缺项保留基本相容。服务端额外的 schema_version/server_received_ms 不会被现有 ACK 解析器拒绝。真正必须改的是 retryable 的逐 ID 语义，而非另造 ACK 字段名。

## 5. 最小兼容方向

优先让端侧适配已部署的 `p003.ark.records.r1`，保留现有内部业务事实及 durable handoff，不让服务端宽松接收另一种未确认格式。

1. 冻结一份双方同意的 wire 修订与开关版本。Native 先读取现有 context、校验版本/limits，再把已验证原 context 持久交给 Runtime。正常续凭据沿同 context；换 grant/epoch 后旧记录隔离，新事务使用新 context，save/sequence 不重置。
2. 在业务原子提交边界生成明确 reason、稳定 business_source_id、获得实例和激活引用；产出当前严格 schema 的不可变上传记录。资源映射、时间质量、上限校验均在真实语义下完成。基线、无法无损映射的混合事务、缺原 context 的旧事实继续保留，不能“适配”成假正常记录。
3. Native 保留已冻结 body/record_id，batch 仅保留线上允许的信封键。明确 `retryable=true` 留 pending 并退避；只有 accepted/duplicated 可清传输正文，`retryable=false` 才进保留正文的 dead-letter。对缺失/非法 retryable 保守拒绝结算，不推断成终态。
4. 容量溢出/覆盖信息、基线及确实无法表示的业务类型如需改服务端，另出显式版本修订并配套存储/摘要语义；不得在已部署 v1 上静默放宽、补造归属或仅回 ACK。

接入验证至少覆盖：客户端真实序列化 fixture 对服务端 HTTP/SQLite；context 与原归属冻结；同一授权续 token；换绑/换回/换 grant；重复/部分/截断 ACK；capacity_exceeded 可重试；多奖励整笔、获得→激活、GM/unknown、时钟未知、baseline、满队列与缺口。测试通过并完成回签后，才具备考虑单 C 开关及实机逐 record_id 对账的条件。

## 6. 与历史对话、使用时长的关系

- **184 条历史对话及分页已由独立 conversation.db 只读链提供。** 此次业务流水 wire 阻断不撤回该能力，也不需要重建历史对话或改变绑定。
- 有效使用时长仍通过原 Telemetry focus_segment，和新 Ark records 是独立链。不能用 mini009 候选业务流水已实现来证明 C 使用时长已有新样本。
- mini009 文档已说明本轮不上机；本核查未安装 APK、未开启 config、未触发上传或修改生产数据。

署名：codex（OpenAI）| 2026-11-16
