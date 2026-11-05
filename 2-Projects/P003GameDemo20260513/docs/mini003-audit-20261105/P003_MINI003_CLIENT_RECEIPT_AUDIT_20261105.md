# 371_mini_003 客户端回执审计｜尚未贯通

**结论：当前不能整体收口，也不能把此前V3测试说明直接给mini003执行。客户端与已上线服务端选择了不同的简化协议，服务端和小程序仍需对齐；从附件合同看，暂未发现要求安卓重写已完成方案的必要。**

本轮仅做附件核对、线上只读核查和隔离复现，没有更改生产、owner、设备开关或APK。不是新协议发布回执。

## 1. 材料与实际状态

已完整读取单独MD与ZIP内全部4件，ZIP内主回执与单独MD逐字节一致。ZIP仅含3份Markdown和1份JSON，**不含APK或完整源码**。APK SHA/签名/1775项原生测试/1194项Python测试属于客户端交付声明，本轮未独立重跑或核验APK字节。

客户端声明：独立分支 `codex/g1-miniapp-ble-provisioning-20261028`，源码 `75c7dea1e520f400a0ec78d1ab8b9e83262b9343`，版本 `371_mini_003`、versionCode=371，APK SHA256 `0287a36d91a3da86cd071ebfd834e3c7b0232cb04c71645cecfc4f7a53fec5ea`。它不是正式主线版本，不能按主线versionCode高低推断是否支持本协议。回执明确未安装真机、三方v2验收PENDING；这只代表出具回执时点，现场当前安装状态仍需回读。

2026-11-05 **16:35 CST** 服务端只读快照：相关8个源文件均与审查源码SHA一致；p003-voice PID157492/restarts52、Analytics PID157401/restarts10，均online。C `BJP00326081002000031` 台账为空，长期密钥0条、BLE receipt0条；因此当前没有C完成这套首绑的云端证据。旧enrollment窗仍为11月4日至18日，V3 SN自动建档功能开启。

## 2. 不匹配点

| 环节 | mini003已实现合同 | 当前服务端/既发V3说明 | 判断 |
|---|---|---|---|
| 首绑入口 | `/api/parent/device-enrollments/*`、`ble-enroll-v2` | 该入口仍只接受`ble-enroll-v1`；V3走`/api/profile/bind-sn` | 不匹配 |
| 首绑字段 | 8字段，删identity_statement | 旧登记入口严格9字段并验证声明及签发表 | 不匹配 |
| 设备证明 | `P003-BLE-ENROLL-V2`、13行、本机确认后签名 | 旧登记生成V1目的、14行；V3不走prove_enrollment | 不匹配 |
| 后续领证 | `binding_protocol=ble-key-v1`，需要BLE receipt | V3创建pairing_session并用`pairing_protocol:2`；不创建BLE receipt | 不能混用 |
| 激活轮询 | 既有BLE `binding_id` / `activation_state` | V3使用pairing `session_id` / `state` | 小程序要选对状态接口 |
| 工位/开放窗 | 不需要声明/工位/固定开放窗 | V3已去除，但旧enrollment入口仍依赖原配置/窗 | v2入口需要单独解除依赖 |
| 小程序版本 | 附件明确要求同步 | 没有本轮已发布体验版源码/验收回执 | 未验，不能假定已改完 |

这是**对接合同没有统一**，不是“换上mini003就自然兼容”。我上一份V3适用于pairing2实现，不能作为这个mini003包的联调合同；需要在服务端对接上收敛，避免要求客户端来回改协议。

## 3. 已实际复现的结果

实际Hono业务路由＋全新隔离SQLite＋合成账号/SN/随机密钥；不向生产造设备事件或绑定。线上源哈希与复现源8/8核同，但以下HTTP状态是**隔离复现实测**，不是伪称C机公网测试。

| 操作 | 实测 |
|---|---|
| 调现有enrollment capabilities | 200，仅声明`ble-enroll-v1` |
| mini003精确8字段v2 challenge | **400 `bad_request`** |
| 试图改v1并塞空声明 | **403 `device_identity_invalid`**；不能用空值搭桥 |
| 先走已上线V3 bind-sn | 200，说明V3路径本身可用 |
| 随后按mini003方式ble-key-v1 claim | **404 `pairing_pending`**，因为没有对应BLE receipt |
| 关闭隔离旧enrollment窗后取挑战 | **503 `enrollment_closed`**，说明该入口仍依赖旧窗 |

源码锚（相对apps/server）：`device-enrollment-proof.ts:71`严格字段/协议/声明；`:79`V1 14行；`routes/device-enrollments.ts:56`capabilities仍读旧窗；`device-enrollment-store.ts:45`签发表trusted校验、`:61`prepare；`ble-binding-store.ts:235`claim依赖BLE receipt。不能只把字符串v1改成v2或只删一个字段。

## 4. 最小收敛建议

**以mini003已经完成的“SN＋公钥、本机确认”合同为本轮三方统一方向，补服务端兼容，不要求安卓先退回pairing2。** 仍不增加工位/出厂声明/新PKI/新库；公钥证明是客户端现成流程，不能再包装成厂家真伪认证。

服务端沿用原模块补齐，不另起一套系统：

1. capabilities明确支持v2；v2严格解析8字段，SPKI规范化并核key_id=`p003_`＋指纹前48位；不读取工位声明，不要求旧声明配置/开放窗。保留现有账号鉴权和限频即可。
2. v2使用独立目的`P003-BLE-ENROLL-V2`和精确13行；挑战记录绑定自己的协议/公钥/账号/会话，confirm按该记录验签，不能改全局常量使已发v1挑战变义。
3. 复用现有同库事务：建台账/公钥/owner/策略/BLE receipt，再沿现有Brain初始化、`ble-key-v1` claim和认证激活。保留同owner幂等、不同owner/公钥冲突409、停用/撤销不复活。已上线pairing2留给对应旧客户端兼容，**mini003一轮流程不同时走两套首绑**。
4. 补齐BLE凭据与本次绑定回执的关联，避免旧凭据把新绑定误报成已激活。保持外部`ble-key-v1`请求/响应合同，在新签发JWT内部关联binding_id并精确标记认证回执；历史凭据可继续兼容，但不能代替新回执的认证证据。具体实现需要回归旧领证/恢复路径。

**附加缺陷已复现，而非仅静态推测。** 会话37指出同owner再次绑定可能沿用binding_version；主13于16:46 CST用真实业务路由、独立SQLite及随机密钥复现：两份不同BLE receipt均为version=2，第二份已claim但完全没有解密、保存、使用新凭据；用第一份旧凭据调用prefetch，第二份状态竟从`pending_device_auth`变成`activated`。这是隔离环境的状态归因缺陷，不是C机现场事故，也不是跨账号接管。原pairing2的会话隔离测试不覆盖它，修复v2时必须加入“旧凭据不能激活新回执”的反例验收。证据见`BLE_ACTIVATION_REPRO.json`。

小程序需核实并调整：

- READY材料检查不再要求statement，不把`TRIAL_UNAUTHENTICATED`误报安卓初始化失败；识别`ble-enroll-v2`能力。
- 取v2 challenge，原样转发`prove_enrollment`；等设备本机确认及`PROOF_READY`后HTTPS confirm，成功再配Wi-Fi。
- 保存confirm的`binding_id`与public_id，沿`GET /api/parent/ble-bindings/<binding_id>`看`activation_state`；不要误轮询V3的pairing session_id。
- 显示准确阶段/HTTP/error/RID；Wi-Fi就绪、签名就绪、claim成功都不能提前显示已激活。

会话37读取的**本地历史小程序缓存**尚未保留READY全部公钥材料、未处理`LOCAL_CONFIRMATION_REQUIRED/PROOF_READY`，仍有连接5分钟强制超时；这不能代表当前微信体验版。需要对实际体验版固定提交/构建核实这些项，并保留原v0.3 transcript算法；HTTP键名转换后转BLE时显式映射，签名原文不重拼。不需要重做短信账号、设备列表或数据接口。

安卓本轮先保持mini003，不清数据、不换长期密钥、不改Godot/Rust/PCK，不用正式OTA覆盖。是否还有实现缺陷，要靠真实设备联调证明，不能仅凭本地测试数下结论。

## 5. 能发“实机开测说明”的前置

当前这些条件尚未满足，因此本文件是审计回执，不是准许直接开跑的测试通知：

- 服务端v2已实现、隔离验收、部署，回执明确固定候选SHA；真实13行签名→confirm事务→ble-key-v1解密→prefetch认证→BLE activated→家长数据/A-B隔离完整通过；旧凭据不能激活新receipt，关闭旧声明窗口不影响v2。
- 小程序给出已更新体验版/提交/接口协议回执，确认不再要求声明，确认使用BLE binding_id状态。
- 现场回读C版本、完整SN、原key_id/指纹；APK实际SHA对应mini003，保持mini002原身份和已有凭据，不用清档绕过问题。

补齐后真机说明应按单一路径覆盖：扫码/短信登录 → READY → challenge → 本机确认 → confirm → Wi-Fi → claim解密保存 → 真实认证 → activated → 重启恢复 → 一条真实数据A可读/B不可读；另测拒绝/超时/断连重连/已有owner与公钥冲突。测试失败时留北京时间、版本、SN、RID、challenge_id/binding_id与错误码，不外发Bearer/凭据/私钥。

## 6. 本轮核验与交付状态

主13完成附件/ZIP全读、线上8文件SHA核对、6项协议不兼容隔离复现、1项BLE激活归因反例；会话37独立审计结论一致，其原始报告保留在`REVIEW-37.md`和`REVIEW-37.json`。37原报告的“静态风险”已由主13后续运行证据补实，未改写独立报告原文。

本轮只新增审计文档及证据，没有实现/部署v2、没有改设备或账号归属。建议先完成服务端兼容与激活修复，再对齐小程序体验版；安卓保持mini003等统一合同就绪后真机验收。**本报告不能作为“服务器已就绪、请现场开测”的通知。**

署名：codex（OpenAI）| 2026-11-05 16:48 CST
