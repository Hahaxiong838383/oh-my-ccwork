# P003 小程序 × Android：手机号与 SN 简化绑定联调合同 V3

状态：服务端已于2026-11-05 16:01 CST上线，独立17项与完整main链路验收通过，运行候选c412d67f；详细证据见P003_SIMPLE_BINDING_SERVER_RECEIPT_20261105.md。此版替代旧自动登记及 QR V2 文档中的普通绑定前置。C 机完整链路尚待两端适配后实测；现有 371_mini_002 不能直接当作新合同已经实现。

## 1. 两端如何配合

用户操作：**设备显示小程序入口二维码 → 微信扫码 → 手机号登录 → 连接目标设备 → 自动绑定 → Wi-Fi 配网 → 设备自动领证保存 → 显示已激活。**

普通内测绑定不需要：导出/导入公共身份 JSON、Air 工位签发、identity_statement、长期 SPKI 公钥登记、prove_enrollment、14 行签名或限时开窗。现有旧 BLE 身份协议保留兼容，不是本次 C 机的前置。

手机号已经在短信登录时验证，服务器从当前 token 的账号读取；绑定业务输入只有 SN，不把请求体 phone 当作他人账号的归属依据。若设备已有其他 owner，返回 409，不自动清掉旧归属。

C：`BJP00326081002000031`。服务器不会替真机预先制造绑定、领证或激活记录。第一次真实绑定请求会自动建台账。

| 团队 | 本轮必须调整 |
|---|---|
| 小程序 | 登录后通过 BLE 读取当前设备 SN、nonce、recipient 公钥；先 bind-sn，后 pairing/confirm，再发 Wi-Fi；改为轮询 pairing/status 的 session_id；显示服务器真实 activated 状态。 |
| Android | 缺 identity_statement 不阻止简单模式 READY/连接；跳过 prove_enrollment；提供现有 pairing2 临时 nonce/recipient 公钥；联网后按 pairing_protocol:2 claim，复用 ECIES 解密、凭据持久保存、重启恢复和实际 prefetch 认证。 |
| 服务端 | 未知 SN 自动建档并绑定当前手机号账号，初始化 Brain；同账号幂等、其他账号冲突；自动加密发凭据，真实认证后记录激活；提供父账号数据隔离。 |

二维码只负责打开小程序入口，不承载凭据、Wi-Fi 密码、声明或私钥。小程序团队提供已发布/体验版入口二维码，Android 负责显示；若入口不带设备定位信息，扫码后仍须通过 BLE 选择并核对目标 SN，不能仅凭附近第一台设备就绑定。二维码参数格式由两端沿现有入口约定，本次服务端没有新增二维码签发服务。

## 2. 地址与认证

Base：`https://kidshub-ai.hahaxiong.cc`

- 发验证码：`POST /api/auth/sms/send`，`{"phone":"<家长手机号>"}`。
- 校验并登录：`POST /api/auth/sms/verify`，`{"phone":"<同一手机号>","code":"<6位验证码>"}`。
- 成功取得 `token` 后，家长接口统一 `Authorization: Bearer <token>`。A/B 测试使用两个实际短信登录账号，不把设备 credential 用于家长接口。
- 原账号按手机号复用，首次手机号自动建号；验证码 300 秒、默认重发间隔 60 秒，限流沿当前短信接口返回的 `retry_after_s`。本轮不重复发送真实短信，不能把合成验证码测试说成运营商送达测试。

绑定/confirm/claim/status 的响应头 `X-Request-ID` 用于对账；短信 RID 在 JSON `request_id`。记录状态码与 `error`/`code`，不要只记录一个“失败”。未登录的 bind-sn 可能在鉴权时直接返回401而没有 X-Request-ID，此时记录北京时间与HTTP状态。

## 3. BLE 阶段：先完成账号归属

### 3.1 绑定 SN

`POST /api/profile/bind-sn`，家长 Bearer：

```json
{"sn":"BJP00326081002000031"}
```

成功示例（public_id 为实际响应生成值）：

```json
{"ok":true,"sn":"BJP00326081002000031","public_id":"dev_<服务器生成>","already_bound":false,"brain_opened":true,"brain_state":"ready","synced_profile":false}
```

同账号重试 `already_bound=true`，public_id 与归属不变。Brain 暂时初始化失败仍返回绑定成功，但 `brain_opened=false, brain_state="initializing"`，保留 owner，稍后由同账号重试此接口；不要让用户反复解绑重绑。

### 3.2 确认当前配网会话

`POST /api/parent/pairing/confirm`，同一家长 Bearer：

```json
{"sn":"BJP00326081002000031","nonce":"<当前BLE会话nonce>","pk":"<当前设备临时recipient压缩公钥base64url>","pairing_protocol":2}
```

成功：`{"ok":true,"session_id":"<服务器会话ID>","relation":"owner"}`。

- `nonce`：设备生成的本次随机串，使用至少 16 字节随机数的 base64url，无 padding；当前 API 形状范围 16–128 字符，推荐 32 字节随机数。
- `pk`：P-256 临时 recipient 公钥，33 字节压缩点（02/03 前缀）base64url，无 padding。**不是长期 SPKI 公钥，不是预置 JSON**。若现有 BLE 字段叫 `credential_pk`，小程序转为此请求的 `pk`。
- nonce、临时私钥、pk 在当前配网/重试期间保持一致，私钥留在设备。confirm/claim 不能混用不同会话的值。
- 会话有效期内，同账号同 nonce/pk 重试返回同一 session_id，不延长会话；配网确认有效期 600 秒。换一轮配网就生成新 nonce/临时密钥并重新 confirm。
- 收到成功后再交 Wi-Fi 配置。Wi-Fi 失败不回滚 owner；同账号重新配网即可。

## 4. 设备联网后自动领证

`POST /v1/device/pairing/claim`，此时无设备凭据，不带家长 token：

```json
{"sn":"BJP00326081002000031","pairing_nonce":"<与confirm完全相同的nonce>","pairing_protocol":2}
```

本模式不发 `binding_protocol:"ble-key-v1"`，不携带 statement/signature/binding_id。

成功响应：

```json
{"ok":true,"code":"claimed","idempotent":true,"enc":{"alg":"ECIES-P256-HKDF-SHA256-A256GCM","server_eph_pk":"<base64url>","iv":"<base64url>","ciphertext":"<base64url>"},"credential_expires_at_ms":1825400000000,"brain_state":"ready"}
```

以上过期时间仅为示例，实值以响应为准，等于 JWT exp×1000，当前有效期 365 天。`idempotent=true` 也可能是先 bind-sn 后首次领证（表示归属已存在），判断领证成功用 `ok` 和 `enc`。

沿用现有 ECIES：P-256 ECDH；salt=SHA256(nonce传输字符串的UTF-8)；HKDF-SHA256 info=`p003-pairing-v2`、32字节；AES-256-GCM，12字节IV，ciphertext尾拼16字节tag，AAD=规范化大写SN的UTF-8。设备必须用当前会话临时私钥解密，保存得到的完整 device credential；不要求解析或生成 JWT 内部 session/version 字段。

首次成功后 15 分钟内，同 nonce 重试可返回 `code="idempotent_recovery"`；密文可能不同。每次恢复仍检查当前 owner/归属代际，不会因旧会话重试改绑别人。

## 5. 实际认证与状态

Android 原子保存凭据后：

`POST /v1/device/session/prefetch`，`Authorization: Bearer <设备credential>`，body `{}`。

成功为 HTTP 200：`{"status":"warming","prefetch_id":"...","expires_at_ms":...}`。这一步验证设备已持有可用凭据，不会开房或让小可发声。

小程序用家长 Bearer 轮询：

`GET /api/parent/pairing/status?session_id=<confirm返回值>`

| state | 含义 |
|---|---|
| pending | 会话已确认，等待设备联网 claim；不能显示已激活。 |
| expired | 未领证会话已过期；生成新会话重新 confirm。 |
| bound | 已绑定且领证成功，尚无该凭据实际认证记录。 |
| initializing | 已领证，Brain 初始化尚待重试；不能替代设备认证。 |
| activated | 此会话签发的凭据已成功完成 session/prefetch 或 session 认证。 |

激活响应含 `activated:true`、`activated_at_ms`、`sn`、`public_id`、`brain_state`。activated 表示已有认证成功证据，不代表设备此刻永远在线；实时在线状态看 dashboard。claim成功、Wi-Fi就绪、旧凭据活动均不能点亮另一新会话。服务器重启后该状态保留。

若 prefetch 成功但 status 仍未激活，按现有节奏重试 prefetch 并记录 RID；不要伪造客户端 activated 状态。轮询建议 2–3 秒，收到成功/过期/冲突即停止。

## 6. 真实数据读取

家长 `GET /api/profile/bound-devices` 获得该账号的 `public_id`。

家长 `GET /v1/parent/devices/<public_id>/dashboard` 读取云端已有数据。设备上报沿现有 `POST /v1/device/telemetry`。本轮不强迫修改游戏/埋点合同。

新机尚未上报时按接口空值显示，不伪造数据。A 绑定后能读该机，B 列表中没有该机且直接读其 public_id 返回 404。

## 7. 错误处理

| 接口/HTTP | error 或 code | 处理 |
|---|---|---|
| 家长/401 | unauthorized | 重新短信登录。 |
| bind-sn/403 | phone_login_required | 当前账号不是已关联手机号的家长账号，先短信登录。 |
| bind-sn/400 | bad_request / invalid_sn | 只传 sn，检查完整 MCU SN；不要把 ADB ID 当 SN。 |
| bind-sn/404 | sn_not_available | 已停用或删除/撤销历史被保留；联系后台查记录，不自动复活。真正新 SN 会自动建档。 |
| bind-sn/409 | sn_taken | 已归属另一账号，保留原归属。 |
| confirm/409 | sn_bound_by_other / nonce_used | 归属冲突或旧会话不再可用；核账号，必要时发起新配网会话。 |
| confirm/400 | bad_request / invalid_pk | 核 nonce/33字节压缩临时公钥，不能发送 SPKI DER。 |
| claim/404 | pairing_pending | 尚无匹配确认，确认小程序已成功调用 confirm；按2→3→5秒重试。 |
| claim/410 | nonce_expired | 重新发起配网会话。 |
| claim/409 | nonce_used / sn_bound_by_other / binding_changed | 停止旧会话领证，核当前账号并重开会话；不能清掉他人owner。 |
| claim/403 | sn_not_allowed | 台账已停用/移除，查询后台。 |
| 任一旧BLE设备/403 | device_proof_required | 该设备显式保留旧BLE策略；本次不批量降级历史策略。C首次自动创建走普通模式。 |
| status/404或409 | not_found / sn_not_available / binding_changed | 会话不属于当前账号、设备不可用或归属变化；停止旧状态轮询。 |
| claim/429 | rate_limited | 退避重试，勿高频循环。 |
| prefetch/401、403、429 | 现有 code/message | 分别核凭据、设备状态、限流；不得将任意错误都当成“需要解绑”。 |

## 8. 最小真机验收回执

两端适配后以 C 机执行，不需要先补声明或人工台账。正常绑定长期可用，无一周窗口倒计时；单次配网会话600秒/领证恢复15分钟属于重试期限。

| 用例 | 通过证据 |
|---|---|
| Q1 扫码与登录 | 实际APK/小程序版本、C完整SN、短信登录成功；无声明也能进入连接流程。 |
| Q2 BLE与自动归属 | bind-sn RID/HTTP200/public_id，后台owner为A；再次调用public_id不变。 |
| Q3 配网与领证 | confirm RID/session_id、claim RID/HTTP200、解密成功、保存成功；不提供credential/私钥。 |
| Q4 实际激活 | prefetch成功，status由bound变activated，记录activated_at_ms；不能仅报Wi-Fi已就绪。 |
| Q5 重启恢复 | Android重启后原凭据仍可读取并认证，未重新导入任何JSON。 |
| Q6 真实数据 | 设备新产生一条真实数据；设备时间/上传RID、数据库、A页面对应同一值。 |
| Q7 账号隔离与失败恢复 | B读不到A设备；B绑定409不改归属；Wi-Fi失败后A可重新配网恢复。 |

请回传：版本、SN、北京时间、session_id、X-Request-ID、HTTP状态、error/code、public_id、认证/保存结果及页面状态。不要发验证码、Bearer、设备credential、临时私钥或工位凭据。

署名：codex（OpenAI）| 2026-11-05
