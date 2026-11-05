# P003 mini002 自动授权、签发、绑定：服务端验收与三方联调回执

**结论：服务端自动链路已通过完整入口验收，相关接口已经部署上线。安卓和小程序按本文适配即可，不需要服务器人员逐台录入 SN、公钥或 owner，也不需要在群里传 JSON 后等待人工签发。**

本轮以现役服务完整 `src/index.ts`、真实 HTTP/SQLite/密码学跑通；未代替 C 机签名或制造 C 机成功记录。C 真机端到端验收仍由下一轮完成。

## 1. 两种凭据及自动化边界

| 材料 | 自动发放方式 | 谁保存 |
|---|---|---|
| 公开身份声明 `identity_statement` | 一次性可信初始化：工位自动读取同机公共身份 → 调后台签发 → 自动导回同机并回读 | 设备持久保存；可输出公开回执/RID |
| 设备业务凭据 Device Bearer | 小程序完成绑定、设备联网后自动 `claim`，设备解密并保存，再实际鉴权 | 设备保存；不要传群或交给小程序 |

受控工位程序可以由工程师启动一次，材料读取、签发请求、导入和核对均应由程序串联。后台不能仅凭匿名自报 SN 认定这是一台真实设备；当前可信初始化来源就是受控工位。量产时将该步骤并入烧录/出厂初始化，最终用户只需短信登录、蓝牙连接、本机确认和配网。

**“自动授权”不省略设备本机确认，也不把工位 Bearer 放进 APK/小程序。** 当前 Air 已安装后台签发适配器；安卓负责让其初始化程序自动调用适配器，并将成功输出自动导回同一设备。本文不声称 USB 自动编排已在 C 机验过。

## 2. 线上状态与适用范围

- 服务地址：`https://kidshub-ai.hahaxiong.cc`。
- 自动接入业务版本：`60485d45e566eba7b6e26277e925b8e68852a16b`；2026-11-04 15:35 CST 已发布。
- 2026-11-05 11:58 CST 再核：六个自动接入运行文件 SHA 与已发布版本一致；公网 `/api/`、`/v1/` 均进入现役主服务；保留后续 v384 等现役修改。
- 接入窗口：**2026-11-04 15:35:07.605 — 2026-11-18 15:35:07.605，北京时间**。窗口限制新签发/首次登记，不是设备业务凭据有效期。
- 与 `versionCode=371 / versionName=371_mini_002` 兼容；服务端按协议和身份校验，不另加该 APK 版本门；此为协议侧兼容，不代表已验证该 APK 的所有功能。
- 当前遥测 allowlist 与故障注入项均为空；新设备在完成有效绑定、取得凭据后，可按现役权限上报遥测，无需逐台额外建 scope。
- 本轮没有业务源码修复需求，未重复部署或重启生产。主服务 PID 4186397 / restarts 51；埋点 3937833 / 9；个人服务 1626403 / 0，前后保持。
- 历史 C 身份：`BJP00326081002000031`。11:58 只读核验仍无台账、无签发声明，因此**没有真实签发 RID 可回传**。必须由受控程序处理同机真实身份后产生，不用测试 RID 顶替。

## 3. 三方职责与下一次实际顺序

| 责任方 | 交付及操作 | 通过条件 |
|---|---|---|
| 服务端 / 会话13、37 | 已提供签发、自动建档绑定、领证鉴权、读取接口及本轮证据；按 RID 协助对账 | 本文服务端验收已通过；不人工预建 C |
| 安卓同事 | 把 USB 公共身份读取、调用受控签发适配器、同机导入、读回、重启读回接成一个初始化入口；保留长期私钥 | 真实签发 RID；同机导入成功；重启后声明仍可读 |
| 小程序同事 | 短信登录；读取新 READY 能力/公开材料；新 challenge → 设备确认签名 → confirm → 配网 → 轮询回执 | 自动绑定成功，最终 `activation_state=activated`；A/B 权限隔离通过 |
| 安卓同事 | 保持原 `ble-key-v1` claim/ECIES 解密/持久化/实际鉴权链；产生一条真实遥测数据 | claim 与实际鉴权成功；数据上传 ACK 与后台/小程序值一致 |

1. 安卓在 **C 的 USB 实际连接工位**运行完整初始化入口。签发子命令若在 Air，需由获授权的工位程序安全调用；USB 不在 Air 时，不把“已导出文件”等同于远程调用已接通。
2. 程序取得公开回执后核 SN、key_id、SPKI 指纹与当前 USB 设备一致，再自动导入并回读。工程师重启 C 后再次回读核同，不清数据、不换长期密钥。
3. 小程序重新建立 BLE 会话，拿新 READY 材料，走新登记接口；设备显示/处理本机确认后签名。
4. `confirm` 成功才完成云端绑定；它会自动创建台账、公钥、BLE 策略、owner 和稳定 public_id。设备 Brain 账号/画像随后幂等初始化。
5. 配 Wi-Fi，设备自动 `claim`；解密并保存凭据，调用设备鉴权接口。小程序只在后台回执为 `activated` 时显示激活成功。
6. 设备产生一条真实遥测，账号 A 在页面读取；账号 B 不可读取。回传下述公开证据即可。

安卓现有初始化脚本的实际 CLI 以其源码/`--help` 为准；本文不编造 `--export`、`--import` 等参数。小程序最新构建是否已完成以上编排，由小程序同事给出构建标识和实际结果；不能用旧本地源码作结论。

## 4. 受控签发程序合同

Air 签发子命令（不是完整 USB 初始化命令）：

```text
node /Users/rayman.chen/.config/p003/provision-device-identity.mjs
```

stdin 严格四字段 JSON：

```json
{"sn":"<同机完整SN>","model":"P003","device_key_id":"<同机key_id>","identity_public_key_spki":"<P-256 SPKI DER的无填充base64url>"}
```

工具自动调用 `POST /v1/device/provisioning/identity`。工位配置存受保护目录，权限0600，不通过命令参数、APK、小程序或聊天传递凭据。

成功 stdout 是 JSON，严格包含：`ok`、`sn`、`device_key_id`、`identity_fingerprint`、`identity_statement`、`identity_expires_at_ms`、`request_id`。重复同一身份幂等返回同一声明；每次请求有自己的 RID。适配器 stdout **不包含** `idempotent`，客户端不要依赖它。

失败：非零退出码，stdout 不输出成功声明，stderr 给安全错误及可用 RID；不得继续导入或显示成功。公网默认 HTTPS 固定服务地址、15秒超时；本轮测试使用的 `--allow-loopback` 仅是隔离验收参数，不用于现场生产。

## 5. 小程序与设备固定接口

均为相对上述服务地址的路径。家长令牌来自现有 `POST /api/auth/sms/send`、`POST /api/auth/sms/verify`；无需另造登录体系。

| 调用方 | 接口 | 认证/用途 |
|---|---|---|
| 工位 | `POST /v1/device/provisioning/identity` | 工位专用 Bearer；签公开声明 |
| 小程序 | `GET /api/parent/device-enrollments/capabilities` | 家长 Bearer；读取接入窗口/协议 |
| 小程序 | `POST /api/parent/device-enrollments/challenge` | 家长 Bearer；新设备14行证明 |
| 小程序 | `POST /api/parent/device-enrollments/confirm` | 家长 Bearer；自动登记和绑定 |
| 设备 | `POST /v1/device/pairing/claim` | 新绑定的 nonce/recipient；无旧 Device Bearer |
| 设备 | `POST /v1/device/session/prefetch` | 新 Device Bearer；真实鉴权并记录激活 |
| 设备 | `GET /v1/device/config` | 新 Device Bearer；读取配置 |
| 小程序 | `GET /api/parent/ble-bindings/{binding_id}` | 家长 Bearer；查询绑定/Brain/激活状态 |
| 小程序 | `GET /api/profile/bound-devices` | 家长 Bearer；我的设备 |
| 设备 | `POST /v1/device/telemetry` | Device Bearer；上报真实数据 |
| 小程序 | `GET /v1/parent/devices/{public_id}/dashboard` | 家长 Bearer；读取属于本账号的数据 |

新 challenge 请求严格九字段：

```json
{
  "binding_protocol":"ble-enroll-v1",
  "sn":"<同机完整SN>",
  "device_key_id":"<同机key_id>",
  "ble_session_id":"<32位hex>",
  "ble_transcript_hash":"<64位hex>",
  "pairing_nonce":"<32字节随机数的base64url>",
  "credential_pk":"<33字节压缩P-256公钥的base64url>",
  "identity_public_key_spki":"<SPKI DER的base64url>",
  "identity_statement":"<同机持久化声明原文>"
}
```

响应含 `challenge_id`、`signing_payload_b64url`、`signature_alg=ECDSA-P256-SHA256-P1363`、`expires_in_s=120`、`request_id`。新签名载荷14行、LF分隔且末尾无LF；以服务端返回原字节为准，设备校验用途/SN/密钥/本地会话及本机确认后，SHA256签名一次，输出64字节 `R||S` 的无填充base64url，不用DER、不二次哈希。

confirm 请求：

```json
{"challenge_id":"<challenge返回值>","device_signature":"<设备本机确认后的P1363签名>"}
```

成功回执包含 `binding_id`、`binding_state=bound`、`binding_version`、`device.sn/public_id`、`brain_state`、`activation_state`、`request_id`。台账/公钥/owner/绑定回执在同一 devices.db 事务提交；Brain 账号/画像是随后跨库幂等初始化，**不是跨库原子事务**。若 `brain_state=initializing`，保留绑定，按回执查询重试，不清归属重绑。

设备 claim 请求沿旧协议：

```json
{"binding_protocol":"ble-key-v1","sn":"<同机完整SN>","pairing_nonce":"<本次绑定nonce>"}
```

成功返回 `enc` 加密包、`binding_id/version`、`credential_expires_at_ms` 等；设备用本次 `credential_pk` 的私钥按现有 ECIES 合同解密，持久化令牌。小程序不解密、不代存 Device Bearer。

状态：`pending_network` → `pending_device_auth` → `activated`；轮询也可能直接看到最终态。Wi-Fi 已就绪、PROOF_READY 或 bound 均不能替代 activated。

超时：challenge120秒；首次claim600秒；首次领取后的幂等恢复900秒；不会随14天联调窗口放宽。已登记原账号超时恢复用旧 `/api/parent/ble-bindings/challenge` → `/confirm` 的12行证明重新取得绑定回执，再claim；新登记闸关闭后该恢复路径仍可用。未登记设备不能走旧路径绕过可信初始化。

完整签名逐行/ECIES及错误合同同时附带 `P003_AUTO_ENROLLMENT_CLIENT_CONTRACT_20261104.md`，与本文一致。

## 6. 关键错误与动作

| 状态/错误 | 动作 |
|---|---|
| 401 unauthorized | 核对调用方令牌；家长令牌不能用于工位签发 |
| 400 bad_request / invalid_identity_public_key | 核字段、P-256编码和协议，不改设备密钥绕过 |
| 403 device_identity_invalid | 核同机声明、SPKI、签发状态及有效期；先停止绑定 |
| 403 device_proof_invalid | 核14行/原字节/P1363/本机会话；保留 RID |
| 404 device_not_available / binding_not_found | 提交 RID 由后台查具体条件，勿清库 |
| 409 device_already_bound | 沿原 owner 处理，禁止自动抢绑或清绑定 |
| 409 identity_key_conflict / binding_changed | 身份或状态变化；重新读取并排查，不覆盖长期密钥 |
| challenge_expired / claim_expired | 按新挑战或原账号12行恢复流程处理 |
| 429 rate_limited | 按 Retry-After 退避，禁止循环猛试 |
| 503 enrollment_closed / enrollment_unavailable | 核窗口或服务状态；停止首次接入，保留现有材料 |

## 7. 本轮服务端取证

| 项目 | 实测结果 |
|---|---|
| 完整现役 main 入口、真实 HTTP、SQLite、密码学 | 9组通过；在生产主机独立网络命名空间和全新数据库运行 |
| 家长短信核验登录 | HTTP真实签发parent JWT并自动建A/B账号；合成验证码预置，未发送短信 |
| 自动工位签发 → 新证明 → 绑定 → 加密领证 → 实际鉴权 | 通过；签发/challenge不提前登记设备 |
| Brain初始化故障 | 隔离SQLite真实注入失败；bound/owner保留，回执查询自动恢复ready |
| 设备数据 → 数据库 → 家长查询 | 合成亮度7、距离0.42准确读回；A可查、B404 |
| 服务重启与幂等 | 声明/owner/绑定/遥测保存，重复不会重复建档 |
| 关闸、过期claim、原账号恢复、owner变化 | 通过；旧凭据随版本变化失效 |
| 既有边界回归 | 新登记17/17、BLE核心26/26、守卫19/19、新旧HTTP链通过 |
| 公网与已部署源码 | 六文件SHA核同；接口返回对应JSON鉴权/格式错误，非SPA假200 |

正向全链是隔离合成身份，不冒称公网 C 正向。Air工位此前已用真实工位授权+无效公共输入取得预期400，证明授权通路可用但不是 C 签发。C USB、物理确认、Wi-Fi、安卓重启保存、真实页面及真实短信送达不计入本轮通过项。

保留两项工装首试问题：BLE核心回归快照漏CLI依赖，补齐后26/26；公网 `/health` 返回HTML（SPA），改用实际 `/api/` 与 `/v1/` JSON路径核验。没有为这些工装问题修改业务代码。全仓既有typecheck问题未宣称全过。

证据：仓内 `acceptance-20261105/SERVER_ACCEPTANCE.json`、`main-test.stdout`、`regression-results.json`；主机原始隔离目录 `/opt/p003/_acceptance/auto-enrollment-20261105-120340`。会话37独立审核结论另随本轮归档。

## 8. 回滚与下一轮回执

原发布回滚点：`rollback/p003-auto-enrollment-pre-20261104`；生产备份 `/opt/p003/_backup/auto-enrollment-20261104T073507Z`。优先将新登记配置 `enabled=false` 停新接入，保留既有绑定与领证恢复。代码回退必须逐文件核漂移后使用原rollback脚本，不整库回灌、不覆盖后续v384源码；完整说明见 `DEPLOY_ROLLBACK.md`。本轮仅新增验收脚本和文档，不改变现役业务，无新增生产回滚动作。

请安卓/小程序完成后回传公开结果（凭据、nonce、私钥和用户正文不回传）：

```text
C当前SN末8位、APK版本/校验：
USB自动初始化命令/结果：
真实工位签发RID：
同机导入、立即回读、重启回读：
小程序构建版本：
challenge RID / confirm RID / binding_id：
claim及实际鉴权结果（不含token）：
activation_state / brain_state：
真实数据ID、账号A页面值与更新时间、账号B隔离：
失败项及对应RID（如有）：
```

**交付口径：服务端已就绪且在线；下一轮按自动流程适配和联调，不再要求人工逐台登记/签发。C机尚未成功签发或绑定，最终真机链路以真实RID和双方回执收口。**

署名：codex（OpenAI）| 2026-11-05
