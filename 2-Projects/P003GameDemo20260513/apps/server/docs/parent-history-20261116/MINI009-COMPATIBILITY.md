# mini009 R1 最小兼容方案与现状核查

**结论：可以兼容。服务端增加一个已知格式适配分支，接收 mini009 已有事实；端侧只修正常续 token 导致队列身份变化的问题。无需先让 Runtime/Godot 全量改成服务端 v1 格式。**

2026-11-16 用户明确要求“按照兼容模式设计，避免过度工程化”，本方案取代此前“优先端侧全面适配现役 v1”的方向。**后续用户已授权实施，本方案于23:11:30完成服务端部署并打开单C cfg-182上传；接口验证通过，设备真实补传仍待明天。** 具体结果见[实施交接](../records-r1/compat-20261116/HANDOFF.md)。 第 2 节记录的是现有代码直接对接的结果，第 5 节是消除这些差异的最小实现。已上线的两个摘要及 C 历史对话入口不受影响。

核查日期：2026-11-16。只读对比 Android 仓库提交 `75378716195bda8e7414af97ffd8dbd0b109212b` 与当前服务端源码；本文件不代表已执行实机上传测试。未修改生产源码、配置、设备、凭据、队列或业务数据。

## 1. 核查对象与状态修正

- Android 仓库：`/Users/fu-121/mycc/2-Projects/kidshub-ai---godot`，以上述 Git 对象为准，不以工作区 HEAD 或旧回执代替。
- 客户端合同：`docs/miniapp-ble/P003_ARK_RECORDS_CLIENT_R1_20261116.md`，请求/响应 schema 为同目录 `ark-records-r1.request.schema.json`、`ark-records-r1.response.schema.json`。
- 原生源码目录：`android_injection/livekit_sdk_probe/payload/src/main/java/com/futurus/p003/launcher/voice/livekit/`，下文简称“原生”。
- Runtime：`rust_runtime/src/g1_business_records.rs`。
- 服务端：[SERVER_CONTRACT_R1.md](../records-r1/SERVER_CONTRACT_R1.md)、[records-contract.ts](../../src/ark/records-contract.ts)、[records-routes.ts](../../src/ark/records-routes.ts)、[records-store.ts](../../src/ark/records-store.ts)。

新证据已经取代“端侧尚未实现”的旧判断。准确状态为：**候选客户端已实现，上传默认关闭；其 wire 与已部署服务端合同不兼容，三方真实对账仍未完成。** 客户端文档本身也明确不表示服务端接受或上线其新增合同，并要求回签后再启用。

## 2. 现有代码直接对接的差异（适配前）

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

Runtime 原记录没有 origin 字段，因此上传时不能证明原归属。但这不等于不能接入历史：本轮用户已要求 C 历史可见，可以单独记录明确的兼容历史授权，区分“当前允许谁读取”与“原发生归属未验证”，不伪填 origin。正常续凭据只需使用稳定的本地绑定代际键；不要求先把完整 context 传入 Runtime。

## 4. 还需明确的语义与边界

1. **baseline 接收但不算收入或新获得。** Runtime 首次生成 baseline（`g1_business_records.rs:76`），兼容分支保留它并展示接入时已有状态；不强塞现役 v1 事务类型。
2. **混合事务保留完整commit。** 一次记录可能含多奖励、卡与状态变化；兼容表不强套现役v1单reason约束。利用已有grants来源作只读分类，无法确认的部分仍接收并标未知，不要求端侧重造业务分类；不重复分摊钱包delta或改子ID制造收入。
3. **资源须显式映射。** 候选使用 `C-FAMILY-001/C-STARDUST-001`，线上使用 `family_coin/stardust`，卡仍为 `M-CARD-001`。仅对已知语义映射；物品 kind 同样需明确映射，例如 Runtime 测试中的 `ecotank_part` 与线上 `tank_component`。
4. **时间、ID与数值不能截断。** 兼容解析使用候选的 96 字符 ID 等已知边界，不截成 v1 的 80；非安全整数拒绝，异常时间原样保留并标可信度，不能改写旧事实去满足摘要。
5. **保留覆盖缺口。** 候选 Rust outbox 满 2048 后递增 dropped_records 并继续业务（`g1_business_records.rs:54`）。兼容接收 coverage_from_ms/dropped_records，保存累计 dropped 最大值，保留基线前未知和序号缺口；不要求先修改游戏满队列政策，不把 pending=0 当完整历史。
6. **已有 ACK 与重试可保留。** 候选 16 条/64KiB、单条 32KiB；accepted/duplicated、batch_id、集合互斥、缺项保留基本相容。兼容分支临时故障/容量不足整批 503、限流 429 并带 Retry-After，不发送可重试 rejected，旧客户端即可保留原 ID 退避；不要求先改客户端 retryable。

## 5. 最小兼容方向

采用服务端已知格式适配，不新增服务、队列、通用版本平台或计账系统。端侧全量重写 v1 改动过大，严格解析器任意放行又不能保证语义，均不采用。

1. **同接口兼容。** `POST /v1/device/ark/records:batch` 按精确 `contract_id=p003-ark-records-r1` 分支解析；缺该字段走现役 v1，未知合同明确拒绝。复用 Device Bearer、设备授权、限流及 SQLite，不修改原 v1 合同。保留客户端原信封与字段，不要求先 GET context。
2. **一张原始表。** 新增 `ark_record_legacy` 及必要索引，保存原 record_id/save_id/sequence、规范化原文与 SHA、接收时间、兼容授权和覆盖元数据。现役表强制 origin/reason/获得实例，硬塞会逼出伪字段或表重建；单张原始表更小。按 SN+record_id 及 SN+save+sequence 去重，同文 duplicated、异文拒绝覆盖，跨格式同 ID 也不重复展示或计入。只 ACK 已耐久保存记录；部分已写后发生临时失败可整批 503，下次原 ID 重试自然 duplicated，无需新增整批回滚框架。
3. **单 C 历史授权。** 复用历史对话的固定完整元组做法，但单独明确 records 兼容范围：SN/public_id/parent/device-account/binding_version/Ark epoch/grant 及允许的 save/历史范围。用户已要求接入 C 历史，实施时核当时真实元组；不直接沿用旧值或因对话开关而自动开放流水。记录 `authorization_source=legacy_explicit_scope` 和原发生归属未验证，不补造 origin。写入与返回前核权威范围，换绑/换回/重授立即失效，其他设备默认不开放；无需逐条人工审核或全设备迁移。
4. **读时投影，复用小程序页面。** 现分页/摘要增加 legacy 来源，保留授权、高水位、过滤与游标失效语义。baseline 仅显示“接入时已有状态”；wallet_changes 显示真实增减；grants 按真实 reward_instance_id/source_kind/resolved_rewards 投影合格 normal 奖励，按真实到账日计算、同 save 奖励实例去重，并与钱包对账，不双算 grant 与 delta。混合事务无法确认的部分保留明细、摘要标未知/不完整，不重复拆分钱包 delta。
5. **获得不依赖新实例框架。** Runtime 库存是按 item_id 聚合的 BTreeMap；从实际 grant 条目及库存 before/after 确认获得，展示键可由奖励实例+条目位置派生并标明来源。pending_activation→active 只更新状态，不再次获得；缺获得证据时只显示状态变化。同 save 序号、跨 save 真实时间、GM/unknown 不回退旧 normal 等现有摘要规则继续保留。小程序只补兼容记录/基线必要映射，不另做页面。
6. **Native 仅修稳定 scope。** `ArkRecordsCoordinator.credentials()` 用已校验 SN+binding_version 做本地绑定代际键，正常续 token 不变；binding_version 不是 Ark epoch，后者仍由服务器授权检查。若实际已有旧指纹队列，只迁移确认同代际的特定 save，不批量重挂、改 ID 或清队列。mini009 尚未上机时优先下一包入队前修正，不为尚不存在的旧队列先造迁移系统。保留 Runtime/Godot、durable handoff、ACK和重试，与已完成的 4/0 用时修复同包交付。

最小实现范围为：一个服务端解析/投影模块、一张原始表、现路由/分页/摘要接线，以及 Native 稳定 scope 小修。用客户端真实序列化 fixture 验 HTTP→SQLite→家长读取；覆盖原 ID 重放、异文冲突、部分已写后 503、续 token/换绑/换回、多奖励不重复、激活不重获、baseline/GM/未知/缺口，并回归现役 v1。通过后按下一轮实测安排单 C 精确旧格式开关，核同 record_id 端→云→小程序。后续实施已完成：Node24/22各199项与小程序101项通过，7文件部署、单C开关及公网验证完成；未安装修复APK，真实设备/微信验收待明天。

## 6. 与历史对话、使用时长的关系

- **184 条历史对话及分页已由独立 conversation.db 只读链提供。** 此次业务流水 wire 阻断不撤回该能力，也不需要重建历史对话或改变绑定。
- 有效使用时长仍通过原 Telemetry focus_segment，和新 Ark records 是独立链。不能用 mini009 候选业务流水已实现来证明 C 使用时长已有新样本。
- mini009原出包文档“不上机”是先前批次边界；本轮用户已授权实施和开关恢复。服务端接收已上线、cfg-182已开；未取得设备入口，未安装APK、未向生产造业务数据。

署名：codex（OpenAI）| 2026-11-16
