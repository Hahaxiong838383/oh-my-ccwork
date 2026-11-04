# P003 自动首次接入：安卓、初始化工具与小程序联调合同

结论：服务端自动接入已于 **2026-11-04 15:35 CST** 部署，固定运行源码 `60485d45e566eba7b6e26277e925b8e68852a16b`。可以按本合同开发、联调。C 机现有 `371_mini_001` 未证明支持新增协议，不能直接重试原 challenge 就认定修复。本文取代此前“手动录入 SN/公钥再开策略”的方案。

生产地址：`https://kidshub-ai.hahaxiong.cc`。
接入窗口：**2026-11-04 15:35:07.605 ～ 2026-11-18 15:35:07.605（北京时间，14 天）**。截至时间不包含在开放区间内；只限制新的声明签发、挑战和首次确认。已成功绑定设备的回执、领证和正常鉴权继续按各自有效期工作。

## 1. 这次打通的链路

```text
受控初始化工具自动读取设备 SN + 长期公钥
  → 后台签发公开身份声明 → 初始化工具自动保存到同一设备
  → 小程序短信登录 → BLE 读取公开身份及本次会话材料
  → 新 enrollment challenge → 设备核对材料、本机确认并签名
  → enrollment confirm → 后台事务内自动建档、登记公钥、启用策略、绑定当前账号
  → 配 Wi-Fi → 设备 claim 领证并保存 → 设备真实鉴权 → activated
  → 原账号读取真实数据，其他账号不可读取
```

签发声明、创建 challenge **都不创建永久设备台账、不分配 owner**；首次正确签名确认才登记和绑定。无需运营逐台抄录 SN、公钥或点击启用。已有 owner、停用记录和删除/撤销历史均不自动覆盖。

三类材料必须分清：

| 材料 | 来源与用途 | 是否可以公开转发 |
|---|---|---|
| 长期 P-256 身份密钥 | 设备自己生成并保护私钥；公钥用于证明当前设备持有对应私钥 | 仅公钥可转发；私钥绝不离开设备 |
| `identity_statement` | 后台授权初始化工具提交可信公共身份后签发；绑定 SN/key_id/公钥指纹 | 可由设备、小程序保存/转发；不是登录 token |
| Device Bearer | 绑定后由后台通过 claim 加密下发，设备解密保存，用于现有设备接口 | 凭据，不得写入联调日志或群消息 |

初始化工具的专用 Bearer 仅留在受控工位，不放进 APK、小程序、BLE 广播或交接文档。不能让任意手机号账号拿任意 SN/公钥直接成为可信设备。本实现的可信来源是授权初始化工具，不宣称具备芯片硬件证明能力。

## 2. 安卓/初始化工具要做什么

1. 保留设备现有长期密钥，不重新生成 C 的私钥以绕过冲突。初始化程序通过可信 USB/工位连接，自动读取当前设备的完整 SN、key_id、SPKI DER 公钥。
2. 将下面四字段 JSON 通过 stdin 传给已交付的 `provision-device-identity.mjs`；收到成功结果后，自动把公开声明及期限保存到**同一台设备**。本次无需人工把公钥发给服务端登记。
3. 设备向小程序返回 `ble-enroll-v1` 能力、完整公钥及声明，并继续提供原有本次 BLE 会话材料。旧的 `ble-key-v1` 路径保留，不能把新 14 行签名原文送给只支持旧 12 行协议的处理器。
4. 为新用途实现独立的本机确认及签名分支。建议 BLE 命令名 `prove_enrollment`，沿用已实现的加密会话和分包，不改变原 `prove_binding`。命令名属于端侧协议适配；服务端冻结的是下文 HTTP 字段和待签名字节。
5. 对照实际 READY/命令包络核查分包长度；不能只依据服务端样例长度。设备取消、超时或材料不匹配时不得签名。
6. 绑定后按原 `ble-key-v1` claim 协议领证、解密、安全落盘，重启后用该凭据鉴权。保留领证使用的临时私钥和 nonce 至领证/恢复完成。

工具已经安装在 Air：`/Users/rayman.chen/.config/p003/provision-device-identity.mjs`；其专用配置为同目录 `identity-provisioner.json`，权限 0600。工具只做“公共 JSON → 受控签发 → 公共结果”；**USB 读取与设备保存由安卓初始化程序调用完成，当前没有冒称这部分已在 C 真机运行**。工位迁移由服务端安全安装配置，不通过聊天复制凭据。

调用形式（由初始化程序连接管道；不是人工编辑每台设备 JSON）：

```text
当前设备初始化程序的公共身份输出
    | node /Users/rayman.chen/.config/p003/provision-device-identity.mjs
    | 当前设备初始化程序的身份声明保存入口
```

以上两侧是责任接口说明，不是凭空定义了安卓现有 CLI 命令。安卓同事应把两个程序调用接入现有初始化工具。

### 受控签发接口

`POST /v1/device/provisioning/identity`

Header：`Authorization: Bearer <工位专用凭据>`，`Content-Type: application/json`。不接受家长登录 token。请求必须且仅包含四字段：

```json
{
  "sn": "BJP00326081002000031",
  "model": "P003",
  "device_key_id": "p003_63f1a6bcaa09b57eea56ae03cddbbe9e68f7f47708b69111",
  "identity_public_key_spki": "<设备实际SPKI_DER的base64url，不带等号>"
}
```

`model=P003` 是固定产品域，**不要填硬件型号 MAX**。SPKI 必须是 P-256/prime256v1、规范 DER 91 字节；不是 PEM 文本、不是 SHA 指纹，也不是 33 字节临时公钥。

成功 HTTP 200（占位值仅说明格式）：

```json
{
  "ok": true,
  "identity_statement": "<后台签发的紧凑JWS>",
  "identity_expires_at_ms": 1825313707000,
  "identity_fingerprint": "63f1a6bcaa09b57eea56ae03cddbbe9e68f7f47708b6911167645eed7da53cc7",
  "device_key_id": "p003_63f1a6bcaa09b57eea56ae03cddbbe9e68f7f47708b69111",
  "idempotent": false,
  "binding_protocol": "ble-enroll-v1",
  "request_id": "<服务端RID>"
}
```

同一可信身份重复调用可复用声明；声明有效期 365 天，精确到秒，响应以毫秒表示。不同公钥/key_id 不会自动覆盖既有记录。JWS 为服务端 HS256 签名，设备/小程序无需也不得持有验签 secret，后台验证签名和未撤销签发行。

## 3. 小程序要做什么

- 沿现有短信登录 `POST /api/auth/sms/send`、`POST /api/auth/sms/verify` 获取返回的 `token`，以下家长接口统一 `Authorization: Bearer <token>`。不另建微信身份，不改变 A/B 原账号。
- 读取设备声明与新协议能力后，选择新 `/api/parent/device-enrollments` 路径。转发设备真实字段，不能用页面输入或缓存的另一个 SN 替换。
- challenge 返回后，将**原封不动**的 `signing_payload_b64url`、challenge_id 和算法传到该 BLE 会话；设备本机确认签名后提交 confirm。
- 先显示“已绑定/等待联网”，配网完成后继续查激活状态。只有 `activation_state=activated` 才显示云端激活成功。不能用“Wi-Fi 已就绪”替代云端鉴权成功。
- 对跨账号错误保留原 owner，不触发自动解绑；切 B 登录后的列表/回执/数据读取都必须重新鉴权，不显示 A 的缓存数据。

### 3.1 能力与窗口

`GET /api/parent/device-enrollments/capabilities`

```json
{
  "ok": true,
  "binding_protocol": "ble-enroll-v1",
  "enabled": true,
  "window_starts_at_ms": 1793777707605,
  "window_expires_at_ms": 1794987307605,
  "challenge_ttl_s": 120,
  "request_id": "<服务端RID>"
}
```

必须登录。`enabled=false` 时不开始新登记；尚未成功登记的设备不得通过旧接口降级绕过。已经成功登记的设备按第3.5节保留原账号恢复领证路径。

### 3.2 创建挑战

`POST /api/parent/device-enrollments/challenge`

请求必须且仅包含九字段：

```json
{
  "binding_protocol": "ble-enroll-v1",
  "sn": "BJP00326081002000031",
  "device_key_id": "p003_63f1a6bcaa09b57eea56ae03cddbbe9e68f7f47708b69111",
  "ble_session_id": "<本次会话32位小写hex>",
  "ble_transcript_hash": "<本次会话64位小写hex>",
  "pairing_nonce": "<32字节随机值的base64url>",
  "credential_pk": "<本次领证P256压缩公钥33字节的base64url>",
  "identity_public_key_spki": "<长期SPKI_DER91字节的base64url>",
  "identity_statement": "<初始化时持久化的公开声明>"
}
```

所有 base64url 无 `=`，不得混入普通 base64 的 `+`、`/`；key_id 1–64 位 `[A-Za-z0-9_-]`；不要增加未约定字段。nonce 用于本次领证，完成后不能用于另一次绑定。

成功 HTTP 200：

```json
{
  "ok": true,
  "binding_protocol": "ble-enroll-v1",
  "challenge_id": "<挑战ID>",
  "expires_in_s": 120,
  "signature_alg": "ECDSA-P256-SHA256-P1363",
  "signing_payload_b64url": "<原文base64url>",
  "request_id": "<服务端RID>"
}
```

### 3.3 待签名字节与设备校验

解码后为以下 **14 行 ASCII，以 LF 拼接，末尾没有换行**：

```text
P003-BLE-ENROLL-V1
kidshub-ai.hahaxiong.cc
challenge_id
server_random_nonce_base64url
account_id
sn
device_key_id
sha256(SPKI_DER)，小写hex
sha256(identity_statement的UTF8原字节)，小写hex
ble_session_id
ble_transcript_hash
credential_pk
pairing_nonce
expires_at_ms的十进制整数
```

设备必须核对用途域/服务器域名、本机 SN/key_id、公钥指纹、声明摘要、本次 BLE 会话/transcript、临时公钥和 nonce，以及未过期；展示本机确认。签原始解码字节，使用 ECDSA P-256 + SHA-256 **一次哈希**；输出 IEEE P1363 `R||S` 固定 64 字节，再做 base64url。不得直接提交 ASN.1 DER 签名或先哈希一次再让 SHA256withECDSA 哈希第二次。

服务器验私钥持有证明；真实物理确认由设备实现，服务器不能仅从签名推断用户点击/按键动作已发生。

### 3.4 确认并自动建档

`POST /api/parent/device-enrollments/confirm`

```json
{
  "challenge_id": "<挑战ID>",
  "device_signature": "<64字节P1363签名base64url>"
}
```

成功 HTTP 200：

```json
{
  "ok": true,
  "binding_id": "<绑定回执ID>",
  "binding_state": "bound",
  "binding_version": 1,
  "device": {"sn": "BJP00326081002000031", "public_id": "<dev_开头ID>"},
  "already_bound": false,
  "brain_state": "ready",
  "activation_state": "pending_network",
  "bound_at_ms": 1793777708000,
  "enrollment_protocol": "ble-enroll-v1",
  "claim_protocol": "ble-key-v1",
  "request_id": "<服务端RID>"
}
```

示例不代表 C 已绑定，version 不能硬编码。相同有效 confirm 可幂等重试；窗口关闭、声明到期后仍可回读已提交回执，但 owner/key/version 改变后不会返回过时成功。`brain_state` 为 `ready`、`initializing` 或 `unavailable`。`initializing` 可经回执查询重试初始化；`unavailable` 表示当前 Brain 映射/账号等异常，不承诺自动恢复，按 RID 交服务端核验。不可仅凭 bound 显示“设备完全激活”。

### 3.5 配网、领证和查询

设备联网后：`POST /v1/device/pairing/claim`（无需旧业务 JWT）：

```json
{"binding_protocol":"ble-key-v1","sn":"BJP00326081002000031","pairing_nonce":"<同一次nonce>"}
```

**这里必须用 `ble-key-v1`，不是 `ble-enroll-v1`。** 复用既有 ECIES 封装、HKDF/AES-GCM 及安全落盘代码，不改加密合同。返回含 `ok/code/idempotent/binding_protocol/binding_id/binding_version/enc/credential_expires_at_ms/brain_state`，`enc` 为既有加密封装；请勿把它或解密 token 发到群里。

首次 claim：从确认绑定起 **600 秒**内；成功领取后的幂等恢复：从首次领取起 **900 秒**内。到期由原账号重新建立 BLE 会话、nonce 和临时密钥，不清 owner。业务 Device Bearer 当前有效期 365 天，仍受 binding_version、owner、停用/撤销校验。

**已登记设备的原账号恢复领证**：如claim超期，由原账号重新建立BLE会话，用新nonce和临时密钥调用 `POST /api/parent/ble-bindings/challenge`。请求严格七字段：`binding_protocol=ble-key-v1`、`sn`、`device_key_id`、`ble_session_id`、`ble_transcript_hash`、`pairing_nonce`、`credential_pk`，不带公钥/声明字段。设备走现役 **12行 `P003-BLE-BIND-V1`** 签名，再向 `POST /api/parent/ble-bindings/confirm` 提交 `challenge_id/device_signature`，取得新binding_id后claim。安卓需保留旧12行 `prove_binding` 能力。

该路径只接受后台已经登记的active公钥和有效原归属/版本，**不受新登记窗口关闭影响**；未登记设备不能用它绕过自动准入，也不能改走裸SN或SoftAP绑定。重新签名恢复会生成新回执，应保存最新binding_id。

小程序：`GET /api/parent/ble-bindings/{binding_id}`。`activation_state`：

| 值 | 实际含义 |
|---|---|
| `pending_network` | 已绑定，尚无成功 claim |
| `pending_device_auth` | 已 claim，尚无设备成功鉴权证据 |
| `activated` | 设备凭据已被实际设备接口成功校验 |

设备保存凭据后调用现有 `POST /v1/device/session/prefetch` 等真实鉴权接口，再查回执。此步骤不要求打开语音房间或人为制造游戏数据。业务数据读取仍用原账号 token，例如 `GET /v1/parent/devices/{public_id}/dashboard`；真实数据到账及 A/B 隔离需要现场验收，不用空接口成功代替。

## 4. 错误码与重试

统一失败 JSON：`{"ok":false,"error":"…","message":"…","request_id":"…"}`。保留 HTTP 状态、error、RID、客户端北京时间，勿收集凭据或用户原文。

| HTTP | error | 处理 |
|---|---|---|
| 400 | `bad_request` / `invalid_identity_public_key` | 检查精确字段、编码、model、长度；不是重试网络即可解决 |
| 401 | `unauthorized` | 家长重新登录；工位检查安全配置；两类凭据不能混用 |
| 403 | `device_identity_invalid` | 声明伪造、过期、撤销、不匹配或未签发；初始化工具重取/核验同一设备 |
| 403 | `device_proof_invalid` | 签名字节/用途/格式/密钥不正确；重新核对 BLE 会话 |
| 404 | `device_not_available` | 当前设备停用、删除/撤销历史等不可接入状态；交服务端按 RID 查，不手动清数据 |
| 404 | `binding_not_found` | 不存在或非当前账号挑战/回执；不泄露他人记录 |
| 409 | `identity_key_conflict` | SN/key_id/公钥来源冲突；保护旧身份，禁止自动换钥 |
| 409 | `device_already_bound` | 已有其他 owner；沿原归属处理 |
| 409 | `binding_changed` | nonce 已消费或设备/归属版本发生变化；原账号重建会话 |
| 410 | `challenge_expired` | 120 秒已过，重新 challenge，重新本机确认 |
| 410 | `claim_expired` | 600/900 秒窗口已过，原账号重建领证会话 |
| 404 | `pairing_pending` | 设备 claim 尚无匹配绑定回执；先完成 confirm |
| 429 | `rate_limited` | 按 Retry-After 等待，避免轮询风暴 |
| 503 | `enrollment_closed` | 接入窗口未开始/已结束/总开关关；禁止切旧路径绕过 |
| 503 | `enrollment_unavailable` | 新登记配置或依赖暂不可用；保留 RID，有限退避重试 |
| 503 | `binding_temporarily_unavailable` | 旧BLE/claim暂不可用；保留RID，有限退避重试，不清owner |

限制：工位总计 60 次/分钟；家长新接入路由每账号 90 次/分钟，其中 challenge 12 次/分钟；每账号最多 12 个未消费挑战，全局 4096 个。限流桶为进程内限流，重启会重置；待处理挑战容量在数据库内。body 限制：工位 4096 字节、家长新接口 8192 字节。旧 claim 按 SN 12 次/分钟、按 IP 60 次/分钟。正常联调不需要触发这些上限。

## 5. C 机固定核验信息与交付边界

- SN：`BJP00326081002000031`。
- 本次已知实机版本：`371_mini_001` / versionCode 371，待安卓升级适配并报告实际版本。
- key_id：`p003_63f1a6bcaa09b57eea56ae03cddbbe9e68f7f47708b69111`。
- SPKI DER SHA256：`63f1a6bcaa09b57eea56ae03cddbbe9e68f7f47708b6911167645eed7da53cc7`。
- 本次部署后 C 仍无业务台账/owner，没有代造声明/签名或人工清绑定。首次真实链路必须验证自动建档。
- 11:12 旧 RID `b297967c-bb4a-4cde-882a-12b844a8d791` 未在历史日志中唯一恢复具体分支；已核实 C 缺台账/可信公钥，旧代码的预登记要求阻断自动首次接入。不能把新接口的结果冒充对旧 RID 的完整追溯。

服务器已完成代码、隔离真 HTTP/数据库测试、独立复审及部署。安卓负责初始化读取/持久化与新签名用途，小程序负责新接口编排和状态显示。**这些端侧适配、C 本机确认、Wi-Fi 后领取凭据、重启鉴权及真实业务数据隔离仍须真机验收，不在服务端已通过范围内。**

署名：codex（OpenAI）| 2026-11-04
