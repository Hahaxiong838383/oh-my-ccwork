# P003 mini003：服务端适配回执与实机小程序测试说明

**结论：服务端兼容已完成并于2026-11-05 17:20:35（北京时间）上线，具备 mini003 联调条件。安卓沿用现有 mini003；小程序按本文v2合同接入即可配合实机测试。三方实机闭环尚待现场验收，不将服务端通过写成真机已通过。**

本轮以安卓已交付的 `371_mini_003` 为合同基线，服务端兼容 `ble-enroll-v2`。不需要工位签发、声明JSON导入、手工建台账/登记公钥或逐台开启策略；不再设固定14天首绑开放窗。家长正常短信登录，手机与设备完成本机确认，后台自动建档、绑定及开通小可大脑。保留原归属、密钥和已有数据。

这是**服务端可联调**回执，不能代替微信真机、Android Keystore/弹窗、Wi-Fi、凭据重启保存的现场验收。小程序请使用已接入本页v2流程的体验版，不能继续使用此前V3的`bind-sn + pairing_protocol:2`编排。

## 一、版本、对象和地址

- 设备：C机 `BJP00326081002000031`，请现场回读完整MCU SN，不能仅看ADB标识。
- 安卓：`371_mini_003` / versionCode **371**，源码 `75c7dea1e520f400a0ec78d1ab8b9e83262b9343`。这是独立小程序联调包，不按主线版本号高低判定能力，不要求OTA主线或更新PCK。
- 客户端回执声明APK SHA256：`0287a36d91a3da86cd071ebfd834e3c7b0232cb04c71645cecfc4f7a53fec5ea`。服务器未持有APK核包，现场安装后需核实际版本与SHA；不清应用数据、不换长期密钥。
- 服务端候选：`a92bd8f342144d6253cbb9a928925639ffa597cc`，分支 `codex/p003-auto-enrollment-20261104`。
- 统一 API Base：`https://kidshub-ai.hahaxiong.cc`。所有parent接口使用现有短信登录返回的 `Authorization: Bearer <token>`，归属取token账号，不接受请求中另给手机号替别人绑定。
- 小程序体验版需配置相同HTTPS request合法域名；现场实机登录、微信权限及BLE可用性仍需确认。二维码用于打开正确体验版/入口，设备身份仍以当前BLE会话的真实SN与公钥材料核对。

## 二、已适配的服务端合同

### 1. 能力发现

`GET /api/parent/device-enrollments/capabilities`

```json
{
  "ok": true,
  "binding_protocol": "ble-enroll-v2",
  "supported_protocols": ["ble-enroll-v2", "ble-enroll-v1"],
  "enabled": true,
  "identity_statement_required": false,
  "window_starts_at_ms": null,
  "window_expires_at_ms": null,
  "challenge_ttl_s": 120,
  "claim_protocol": "ble-key-v1",
  "request_id": "<本次RID>"
}
```

v2不读取旧声明配置；旧配置关闭、过期或不存在也不挡v2。`supported_protocols`表示实现支持，不表示旧v1窗口已开放；历史v1客户端可用`?binding_protocol=ble-enroll-v1`查看自身窗口。mini003一轮流程不要混用v1、pairing2或先bind-sn。

### 2. 八字段挑战

`POST /api/parent/device-enrollments/challenge`

```json
{
  "binding_protocol": "ble-enroll-v2",
  "sn": "<READY.device_sn>",
  "device_key_id": "<READY.device_key_id>",
  "ble_session_id": "<同一次HELLO_REPLY.session_id>",
  "ble_transcript_hash": "<原v0.3算法SHA256，小写64hex>",
  "pairing_nonce": "<READY.pairing_nonce>",
  "credential_pk": "<READY.credential_pk>",
  "identity_public_key_spki": "<READY.identity_public_key_spki>"
}
```

恰好8字段，不加`identity_statement`。SPKI为91字节P-256 DER的无padding base64url，key_id必须为`p003_`＋该DER SHA256前48位小写hex。公钥来自设备自动读取，不需要人工导出/上传群聊。

成功200返回 `binding_protocol`、`challenge_id`、`expires_at_ms`、`expires_in_s=120`、`signature_alg=ECDSA-P256-SHA256-P1363`、`signing_payload_b64url`、`request_id`。此时只产生待确认挑战，尚未写owner或启用设备身份。

签名原文与安卓回执一致：ASCII、LF、13行，无BOM/CR/尾换行：

```text
P003-BLE-ENROLL-V2
kidshub-ai.hahaxiong.cc
<challenge_id>
<server_random_nonce>
<account_id>
<sn>
<device_key_id>
<完整SPKI SHA256>
<ble_session_id>
<ble_transcript_hash>
<credential_pk>
<pairing_nonce>
<expires_at_ms>
```

小程序原样转发返回的base64url，不重拼文本。沿同一BLE连接发：

```json
{"command":"prove_enrollment","challenge_id":"<id>","signing_payload_b64url":"<服务器原值>","signature_alg":"ECDSA-P256-SHA256-P1363"}
```

`LOCAL_CONFIRMATION_REQUIRED`是等待设备用户确认，不是失败。收到`PROOF_READY`后取64字节P1363签名；`TRIAL_UNAUTHENTICATED`和缺statement均不是初始化失败。HTTP层若转camelCase，转BLE时显式映射回snake_case，签名字符串不变。

### 3. 确认、自动建档和绑定

`POST /api/parent/device-enrollments/confirm`

```json
{"challenge_id":"<本次ID>","device_signature":"<设备返回的无padding base64url签名>"}
```

成功200包含：

```json
{
  "ok": true,
  "binding_id": "<本次绑定ID>",
  "binding_state": "bound",
  "binding_version": 1,
  "activation_state": "pending_network",
  "brain_state": "ready",
  "already_bound": false,
  "device": {"public_id":"dev_<实际ID>","sn":"<实际SN>"},
  "enrollment_protocol": "ble-enroll-v2",
  "claim_protocol": "ble-key-v1",
  "request_id": "<本次RID>"
}
```

上述version=1为新设备示例，恢复时以返回值为准；Brain可暂为`initializing`，不能直接判绑定失败或清owner，按binding_id读状态重试。若返回`unavailable`，保留绑定并向服务器回报RID，不能显示大脑已就绪。注册台账、公钥、策略、owner和BLE回执在devices.db同一事务提交；Brain跨库初始化沿既有幂等恢复，不冒充同一数据库事务。重复同一confirm返回同一binding_id。

### 4. 配网、领证和真实激活

confirm成功后手机才发送Wi-Fi配置。设备联网后沿原接口自动领证：

`POST /v1/device/pairing/claim`

```json
{"binding_protocol":"ble-key-v1","sn":"<真实SN>","pairing_nonce":"<本次READY原nonce>"}
```

成功响应仍为`binding_protocol=ble-key-v1`及原ECIES `enc`结构，不改成v2或pairing2。设备解密、持久保存后带凭据调用 `/v1/device/session/prefetch` 或正常 `/v1/device/session`。

手机用家长token轮询 `GET /api/parent/ble-bindings/<binding_id>`，建议2秒一次并遵守429退避：

| activation_state | 页面含义 |
|---|---|
| `pending_network` | 已绑定，等待设备联网领证 |
| `pending_device_auth` | 已发凭据，等待设备使用凭据认证 |
| `activated` | 本次绑定签发的凭据已实际认证成功 |

联网和认证很快时，轮询可能跳过中间状态；验收看服务端真实状态和端侧保存/认证证据，不要求手机必须逐个展示三个状态。

新签发JWT内部关联本次binding_id，无需安卓改解析合同。旧凭据仍按现有owner/代际兼容使用，但不能把新回执点成activated；Wi-Fi就绪、`PROOF_READY`或claim 200均不能直接显示激活完成。重启后仍须设备回读原凭据并实际认证，云端状态不能代替端侧持久化验证。

## 三、三方现场操作顺序

1. 安卓同事安装/核对mini003，回读C机SN、key_id与SPKI指纹；保留mini002已有身份和应用数据。设备展示入口二维码。
2. 小程序同事提供已接v2的体验版，扫码进入、A手机号短信登录。BLE连到C，核SN，保存READY完整材料及同一HELLO transcript。去掉statement判断及连接5分钟强制失效。
3. 手机取能力、八字段challenge，再发`prove_enrollment`；设备自动弹本机确认，用户确认后才签名。不要加工位初始化或额外“开始配对”步骤。
4. 小程序提交confirm，记录binding_id、public_id、RID；然后配置Wi-Fi。设备自行claim、保存凭据并认证，手机观察`activated`。
5. A查看“我的设备”和一项实际数据。重启C后确认身份/凭据保留、认证与数据继续正常。
6. 手机切换B测试账号：不应看到C；拿C的public_id读数据应404，申请绑定应409，A的owner保持。不得为了测试直接清绑定或抢绑。
7. 每步失败保留北京时间、完整SN、版本、HTTP/error、RID、challenge_id/binding_id；不要发验证码、Bearer、私钥、Wi-Fi密码。服务端按RID/绑定ID核对日志及落库。

数据接口沿用：`GET /api/profile/bound-devices`（设备列表）与 `GET /v1/parent/devices/<public_id>/dashboard`（实际设备数据）。没有数据时保留空值和更新时间，不用演示数冒充设备上报。

## 四、最短实机用例

| ID | 操作 | 通过标准 |
|---|---|---|
| T01 | C无工位声明首次接入 | 能取v2挑战；确认后后台自动登记，不需手工台账/JSON |
| T02 | 设备确认前取消，再重新申请 | 取消不签名、不绑定；新挑战可成功 |
| T03 | 确认并配网 | bound→pending_network→pending_device_auth→activated，端侧已保存凭据 |
| T04 | 激活后重启设备 | key_id/指纹不变；原凭据可读并认证，A仍见同一设备 |
| T05 | 产生一条设备数据 | 设备时间、后台入库、A页面字段/值/更新时间可对应 |
| T06 | B访问/尝试绑定C | 列表无C、dashboard404、绑定409；A归属和数据不变 |
| T07 | Wi-Fi错密码后修正/断连重连 | 不清owner/长期密钥；同账号恢复后能领证认证 |
| T08 | 登录或选网等待超过5分钟再取新挑战 | 无连接级5分钟强退；新挑战按自身120秒有效期工作 |
| T09 | 挑战超过120秒 | confirm410，不自动续期/绑定；重新申请挑战后可继续 |

T01/T03/T04/T05/T06为首轮必测；T02/T07/T08/T09在同一受控设备补测，不影响其他设备。后台不设本次首绑周窗；**单挑战120秒**和领证TTL仍保留，不能混为“联调窗口太短”。首次claim需在绑定后10分钟内；已claim的恢复重试保留15分钟；超时沿同账号原密钥重新证明恢复，不要求清档。

## 五、错误定位

| HTTP / error | 含义与动作 |
|---|---|
| 401 `unauthorized` | 手机token无效/账号非parent；重新短信登录 |
| 400 `bad_request` | 协议、字段数、SN或会话材料错误；核八字段与编码，不补空声明 |
| 400 `invalid_identity_public_key` | SPKI/P256格式或key_id指纹不一致；核同一次READY，勿换钥绕过 |
| 403 `device_proof_invalid` | 签名/原文字节不一致；按challenge_id核13行、P1363及同机密钥 |
| 404 `device_not_available` | 设备已停用/撤销/墓碑等；服务端查实际状态，不重建或强绑 |
| 409 `identity_key_conflict` | 已有SN密钥冲突或公钥被其他SN使用；保留现场，核原身份 |
| 409 `device_already_bound` | 已有其他owner，沿原归属处理 |
| 409 `binding_changed` | 挑战期间归属/状态改变，或nonce已使用；重新读取状态，不混另一条绑定流程 |
| 404 `binding_not_found` | 账号/绑定ID不对应或回执已撤销，核当前登录账号 |
| 410 `challenge_expired` | 挑战超时，申请新挑战；不能延长旧挑战 |
| 404 `pairing_pending` | 设备claim时还没有对应确认回执，核confirm成功与nonce |
| 410 `claim_expired` | 本次领证/恢复时限过了，沿同账号原密钥重新证明 |
| 429 `rate_limited` | 遵守Retry-After；挑战12次/账号/分钟，parent登记接口90次/账号/分钟；另有每账号12个未完成挑战上限，等待旧挑战到期再重试，不要紧循环申请 |
| 503 | 临时服务/数据库问题；保留RID退避，不能清owner或宣称激活 |

## 六、服务端验证与发布记录

- 发布：2026-11-05 17:20:35 CST，7文件after SHA与固定候选全部一致。主服务与Analytics健康检查通过，连续观察197秒PID和重启计数不变。个人站PID不变；Ark/搜索/倾听相关受保护文件SHA保持，生产环境文件未改。
- 公网：17:22:57 HTTPS携现有账号身份只读查询capabilities返回200/v2、无需statement、无固定窗口；RID `2d1adb3b-4868-499a-84ed-49ea1d934874`。匿名challenge401；显式ble-key-v1缺字段claim400。没有向生产写合成绑定或伪造C机事件。
- C状态：17:22:57只读查询台账/公钥/BLE回执均0，未人工预绑。这是正常首绑起点，后续由本机确认后自动登记；不能继续按旧版“无台账就先人工录入”的办法处理。
- 本地9组相关回归与Analytics全套通过；独立37对固定候选11/11组通过，另复验旧v1/12行BLE/pairing通过。跨实现noble签名→服务端OpenSSL验签、双进程争绑、事务回滚、旧凭据不能误激活均有证据。
- Linux隔离完整主服务：新v2 5组/30请求，pairing2 5组/35请求，旧v1 9组通过；包括真实HTTP数据入库、A可读/B拒绝、服务进程重启。短信验证码由隔离夹具签发，没有冒充短信实际送达；P256由软件密钥签名，没有冒充Android实机弹窗/Keystore。
- 已知基线：全仓typecheck仍有12个既存错误，与上次基线日志逐字节一致；本次相关测试通过，不声称全仓typecheck通过。旧v1完整测试第一次漏辅助脚本、首次公网负向探针未选择BLE协议，修正测试材料后通过，未更改业务代码来绕测试。
- 回滚源码标签：`rollback/p003-mini003-server-pre-20261105`；服务器备份：`/opt/p003/_backup/mini003-v2-20261105T172035`。默认只撤回新增登记入口，保留新凭据接收与激活修复；不回灌库、不清owner/密钥。详见仓内`ROLLBACK.md`。

已完成的主服务/隔离证据不得写成C机现场已通过。客户端自报1775/1194测试数、APK签名与PCK结果不属于本轮服务端独立验收。下一步由两端同事使用本页接口和T01–T09实机验证，回传RID后服务端继续对账。

署名：codex（OpenAI）| 2026-11-05 17:25 CST
