# P003 mini002 扫码、绑定、配网与激活：三方联调回执 v2

**结论：服务端自动签发、绑定、领证链路已验收且在线。下一轮真机联调从“安卓设备显示二维码 → 微信扫码打开小程序”开始，连续完成登录、BLE连接、本机确认、绑定、配网、激活及真实数据读取。扫码入口和整条C机用户流程尚未验收通过。**

本版按川哥2026-11-05确认的用户流程更新，作为安卓与小程序同事下一轮执行回执；替代前版回执的操作顺序。服务端接口、既有验收结论和窗口不变，本次仅补文档，未部署新代码、未新增扫码接口、未重新执行服务端测试。

```text
提前准备（出厂/开发工位，普通用户不操作）：
同机公共身份 → 工位程序请求后台签发 → 自动导入同机 → 重启回读确认

用户完整流程（下一轮必须从这里起测）：
安卓设备显示小程序绑定入口码
  → 微信扫码打开小程序绑定页
  → 未登录则短信登录，登录后继续绑定流程
  → 小程序通过BLE发现、选择并核对这台设备
  → 读取同机身份声明，向后台申请challenge
  → 安卓本机确认并签名 → 小程序提交confirm → 后台自动建档绑定
  → 小程序引导Wi-Fi配网 → 设备自动claim、解密保存凭据并实际鉴权
  → 小程序看到activated → 首页读取本账号设备的真实数据
```

本轮以现役服务完整 `src/index.ts`、真实 HTTP/SQLite/密码学跑通；未代替 C 机签名或制造 C 机成功记录。C 真机端到端验收仍由下一轮完成。

## 1. 两种凭据及自动化边界

| 材料 | 自动发放方式 | 谁保存 |
|---|---|---|
| 公开身份声明 `identity_statement` | 一次性可信初始化：工位自动读取同机公共身份 → 调后台签发 → 自动导回同机并回读 | 设备持久保存；可输出公开回执/RID |
| 设备业务凭据 Device Bearer | 小程序完成绑定、设备联网后自动 `claim`，设备解密并保存，再实际鉴权 | 设备保存；不要传群或交给小程序 |

受控工位程序可以由工程师启动一次，材料读取、签发请求、导入和核对均应由程序串联。后台不能仅凭匿名自报 SN 认定这是一台真实设备；当前可信初始化来源就是受控工位。量产时将该步骤并入烧录/出厂初始化，最终用户从设备二维码进入小程序，再完成短信登录、蓝牙连接、本机确认和配网。**工位初始化在出厂或开发机准备阶段提前完成，不放进普通用户扫码流程，不要求用户接USB、搬JSON或导入声明。**

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

### 3.1 各方先交付什么

| 责任方 | 交付及操作 | 通过条件 |
|---|---|---|
| 服务端 / 会话13、37 | 沿用已上线的签发、自动建档绑定、领证鉴权及数据读取接口；按RID对账 | 服务端验收已通过；不人工预建C，不把扫码当设备身份验证 |
| 小程序同事：入口 | 提供当前可真机访问的绑定入口码、实际小程序构建版本及入口页面；如体验版，确认参测微信有访问权限 | 微信从设备屏幕扫码可进入绑定流程；登录后仍可继续，不跳入无关页面 |
| 安卓同事：工位准备 | 自动读取同机身份→调用受控签发适配器→核同机→自动导入→立即及重启读回；保留长期私钥 | 有真实签发RID，声明持久化核同；普通用户不用操作此步骤 |
| 安卓同事：屏幕与设备 | 在绑定/配网页面展示双方核同的入口码及必要提示；支持BLE、本机确认/取消、claim与凭据持久化 | 能从实际设备屏幕扫码；确认前不签名；激活后重启仍可鉴权 |
| 小程序同事：绑定流程 | 短信登录、BLE发现/连接和同机核对；读取READY；新challenge→设备确认签名→confirm→配网→回执查询 | SN与C一致；状态不误报，最终activated；不靠工程师预先连接BLE |
| 双方联测 | 产生一条真实遥测，核上传ACK、后台数据及账号A页面值；账号B尝试读取 | 同一数据和时间可对账；账号B不可读取或抢绑 |

### 3.2 二维码入口的范围

二维码用于进入小程序绑定流程。真正的可信身份仍取自BLE握手/READY、同机公开声明及设备私钥证明；不能因扫到了某个SN就直接认定归属。

首轮复用小程序同事提供并验证的绑定入口码，由安卓展示。**不要求本轮另建二维码服务或动态票据系统。** 若当前是通用入口码，扫码后在小程序中选择并核对C机即可；只有最新两端实际支持并验证了设备参数传递，才可声称“扫码自动选中这台设备”。二维码形式、实际入口页及已有参数由两端核同并记入回执，本文不编造AppID、页面路径或已发布码。

二维码不承载工位Bearer、Device Bearer、私钥或Wi-Fi密码；工位签发声明不通过扫码替代初始化。附近存在多台设备时，必须能核对连接的是C，不能静默绑到别台。

### 3.3 联调前准备（工程师操作，不计入用户步骤）

1. 安卓在 **C的USB实际连接工位**运行完整初始化入口。若签发子命令在Air，由已获授权的工位程序调用；不是把JSON发群后等人工签。
2. 程序取得公开回执，核SN、key_id、SPKI指纹与当前USB设备一致，再自动导入、读回；工程师重启C后再次核同，不清数据、不换长期密钥。
3. 小程序同事给出实际体验/发布版本和可访问入口码；安卓显示该码。双方记录C版本和扫码入口版本。缺声明时先修复工位准备，不让普通用户走USB补材料流程。

安卓初始化脚本以实际源码/`--help`为准；本文不编造其CLI参数。最新两端是否已实现扫码及绑定编排，必须以实际构建和本轮真机结果为准。

### 3.4 用户流程验收（从设备屏幕开始，连续执行）

| 用例 | 实际操作 | 通过条件 |
|---|---|---|
| Q1 扫码入口 | C进入绑定页展示二维码；微信从屏幕扫码 | 打开本次构建对应的小程序绑定流程；记录入口/构建版本；不能用开发工具直接跳页代替 |
| Q2 登录衔接 | 未登录微信账号扫码后短信登录；再验已登录账号扫码 | 两种状态均可继续绑定，不丢失流程；无需工程师改账号或后台补记录 |
| Q3 BLE同机核对 | 在小程序授权蓝牙并连接C；附近有其他设备时核对目标 | READY中的SN/身份与C一致；选错设备可退出重选，不静默绑错 |
| Q4 确认与绑定 | 小程序请求新challenge，C本机确认签名，再提交confirm；另验取消一次 | 确认后才完成绑定，返回bound和binding_id；取消不提交成功绑定；保留真实RID |
| Q5 配网与激活 | 小程序引导Wi-Fi配网；设备自动claim、解密保存并鉴权 | 以后台activated为成功，Wi-Fi已就绪或bound不提前报激活；断开工程USB后仍可运行 |
| Q6 重启恢复 | 重启C并重新打开小程序 | 声明和业务凭据仍可读/可用；设备鉴权成功，原账号仍能看到设备；不重新人工签发 |
| Q7 真实数据及权限 | C产生一条真实遥测；账号A读首页数据；账号B访问同设备数据或尝试绑定 | ACK/后台/页面值与更新时间能对账；B不能读A设备数据或抢绑；不清原owner |

发生阻塞时记录用例编号、两端版本、北京时间和对应RID；没有发到后台的扫码/蓝牙失败记录客户端阶段及错误，不能伪填服务器RID。先完成Q1—Q7，再汇总整个用户链路是否通过；仅从已连好的BLE状态起测不算扫码全链验收。

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

## 7. 已有服务端取证与本版待验范围

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

上表沿用11月5日已完成的服务端验收，**不因本次文档更新扩展为扫码/真机已通过**。Q1—Q7当前均待两端实际联调并回执。

正向全链是隔离合成身份，不冒称公网 C 正向。Air工位此前已用真实工位授权+无效公共输入取得预期400，证明授权通路可用但不是 C 签发。C USB、设备屏幕二维码、微信扫码/登录衔接、BLE同机定位、物理确认、Wi-Fi、安卓重启保存、真实页面及真实短信送达不计入上述服务端通过项。

保留两项工装首试问题：BLE核心回归快照漏CLI依赖，补齐后26/26；公网 `/health` 返回HTML（SPA），改用实际 `/api/` 与 `/v1/` JSON路径核验。没有为这些工装问题修改业务代码。全仓既有typecheck问题未宣称全过。

证据：仓内 `acceptance-20261105/SERVER_ACCEPTANCE.json`、`main-test.stdout`、`regression-results.json`；主机原始隔离目录 `/opt/p003/_acceptance/auto-enrollment-20261105-120340`。会话37独立审核结论另随本轮归档。

## 8. 回滚与下一轮回执

原发布回滚点：`rollback/p003-auto-enrollment-pre-20261104`；生产备份 `/opt/p003/_backup/auto-enrollment-20261104T073507Z`。优先将新登记配置 `enabled=false` 停新接入，保留既有绑定与领证恢复。代码回退必须逐文件核漂移后使用原rollback脚本，不整库回灌、不覆盖后续v384源码；完整说明见 `DEPLOY_ROLLBACK.md`。服务端前轮新增验收脚本与文档；本版仅更新联调说明，不改变现役业务，无新增生产回滚动作。

请安卓/小程序完成后回传公开结果（凭据、nonce、私钥和用户正文不回传）：

```text
C当前SN末8位、APK版本/校验：
USB自动初始化命令/结果：
真实工位签发RID：
同机导入、立即回读、重启回读：
小程序构建版本、参测微信是否具备入口访问权限：
设备实际显示的入口码版本/小程序入口页（不含凭据）：
Q1 从C屏幕扫码进入：
Q2 未登录/已登录衔接：
Q3 BLE连接的设备身份与C核同：
Q4 本机确认/取消及绑定：
Q5 配网/自动领证/activated：
Q6 重启后声明、凭据及鉴权恢复：
Q7 真实数据与A/B隔离：
challenge RID / confirm RID / binding_id：
claim及实际鉴权结果（不含token）：
activation_state / brain_state：
真实数据ID、账号A页面值与更新时间、账号B隔离：
失败项及对应RID（如有）：
```

**交付口径：服务端已就绪且在线；工位提前自动初始化；普通用户从“设备显示二维码→微信扫码”进入完整流程。扫码入口及C机全链尚未通过验收，必须按Q1—Q7提供真实结果，不能只给服务端接口通过或BLE已连接的结论。**

署名：codex（OpenAI）| 2026-11-05
