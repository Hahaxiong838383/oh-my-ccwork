# mini003 小程序最短接入步骤（固定候选a92bd8f审核版）

本页按候选a92bd8f固定源码核对，供13合并正式合同；37已完成候选独立审核，部署验收仍由13给出。mini003附件为客户端自报，未替代APK/真机实测。

1. 设备展示小程序入口QR；微信扫码打开本次体验版并短信登录，保存家长token。QR不代替设备身份核对。
2. BLE连接目标，核完整MCU SN；保留READY的key_id、SPKI、pairing_nonce、credential_pk、capabilities以及HELLO session_id/原v0.3 transcript。缺statement正常，不再有连接5分钟硬超时。
3. 请求server capabilities，确认服务端与设备均支持ble-enroll-v2。缺支持应停在“接口尚未就绪”，不能静默改走pairing2或14行v1。
4. 带家长token向既有device-enrollments/challenge提交八字段；原样把返回challenge_id/signing_payload_b64url/signature_alg经BLE prove_enrollment转交。HTTP字段如转camelCase须显式映射回BLE snake_case，不重拼签名字节。
5. 显示“请在设备确认”；LOCAL_CONFIRMATION_REQUIRED是等待态，PROOF_READY才取签名。取消/断连/超时清当前等待并明确提示，不直接重发确认或切协议。120秒服务端截止不因设备本地计时而延长。
6. 用同账号调用device-enrollments/confirm，仅传challenge_id与device_signature；得到binding_id、device.public_id、binding_state和brain_state。不要预先调用bind-sn或pairing/confirm；归属在此完成，早于Wi-Fi。
7. 再交Wi-Fi。设备自行ble-key-v1 claim→解密保存→真实prefetch认证；手机轮询/api/parent/ble-bindings/{binding_id}，按pending_network/pending_device_auth/activated显示，Brain状态独立。不能把PROOF_READY/NETWORK_READY当成功。
8. 已激活后显示我的设备与真实dashboard；记录版本、SN、北京时间、challenge_id/binding_id、RID/HTTP/error/public_id，不记录验证码、Bearer或私钥。
9. Wi-Fi失败保留owner；同owner/同key恢复沿正式合同，冲突不自动清绑定/换钥。已有BLE恢复保留原12行流程；不要用prove_binding冒充未知设备首次登记。

现场闭环仅一轮：QR/短信→BLE→本机确认→归属→Wi-Fi→领证保存→认证→设备重启→真实数据→A/B隔离。服务端就绪回执必须区分这轮真人实测尚未完成。

## 已固定HTTP入口与字段

家长三接口均带登录Bearer，手机号由已验证账号映射，不再传手机号指定owner：

- `GET /api/parent/device-enrollments/capabilities`：默认v2，`enabled:true`、`identity_statement_required:false`、`claim_protocol:ble-key-v1`、`challenge_ttl_s:120`、窗口null。旧v1明确加query，不能当v2退路。
- `POST /api/parent/device-enrollments/challenge`：严格八字段 `binding_protocol:ble-enroll-v2`、`sn`、`device_key_id`、`ble_session_id`、`ble_transcript_hash`、`pairing_nonce`、`credential_pk`、`identity_public_key_spki`。SPKI为91B P-256 DER的base64url，key_id为`p003_`加完整DER SHA256前48位小写hex；不用PEM或statement。
- challenge响应`challenge_id/signing_payload_b64url/signature_alg/expires_in_s/expires_at_ms/request_id`；算法`ECDSA-P256-SHA256-P1363`。BLE原样转交，不自行双重hash或改换行。
- `POST /api/parent/device-enrollments/confirm`仅`challenge_id/device_signature`。成功返回`enrollment_protocol:ble-enroll-v2`、`claim_protocol:ble-key-v1`、`binding_id`、`device.sn/public_id`、`binding_version`、`binding_state:bound`、`brain_state`、`activation_state`、`already_bound`、`request_id`。
- 设备`POST /v1/device/pairing/claim`仍传`binding_protocol:ble-key-v1/sn/pairing_nonce`，解密并持久保存凭据，真实调用`/v1/device/session/prefetch`。首次claim600秒，已claim幂等恢复15分钟；逾期由原家长新nonce重新证明，不延长旧会话。
- 手机`GET /api/parent/ble-bindings/{binding_id}`。`pending_network`等待设备联网领证；`pending_device_auth`等待本回执凭据实际认证；`activated`只表示认证完成。`brain_state:initializing/ready/unavailable`独立显示，Wi-Fi失败不解除owner。

失败统一保留北京时间、SN、版本、HTTP、error、request_id、challenge_id/binding_id；401重新登录，409核owner/key/代际不可强覆盖，410重新发起挑战/原账号恢复，429按响应节奏等待，503按RID交后台。无RID时同时记录路径和精确时间。不能保存/转发验证码、登录Bearer、设备凭据或私钥。取消只取消本次操作；不要擅自解绑已完成的confirm。

放行条件：13确认部署一致、小程序体验版已走上述路由、现场核目标完整SN和mini003包版本；然后A绑定读取真实数据，B独立登录无设备且直接读目标返回拒绝；设备重启后仍用保存凭据认证并上报。全链实际数据能由RID/时间/设备public_id在DB与手机对应后才宣布闭环。
