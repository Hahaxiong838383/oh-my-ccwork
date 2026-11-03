# P003 小可手机号短信登录：服务端回执与联调合同

**结论：服务端已于 2026-11-03 16:49:13 北京时间部署，可开始小程序联调。A/B 各实发一条短信，Spug 均返回投递状态 2 / success。手机号持有人实收、真实验证码登录这两项待持有人回执，未写成通过。**

本次复用早期 Demo 的 Spug 通道、原手机号账号与家长端 token，在此基础上补齐并发频控、超时处理、验证码安全存储和明确的接口返回。未更换账号体系，未重新绑定设备。

## 1. 接口地址与调用顺序

- Base URL：`https://kidshub-ai.hahaxiong.cc`
- `Content-Type: application/json`
- 两个登录接口不需要旧 token。先发送，再用短信中的六位码校验；返回 token 后调用原家长设备接口。
- 请求体只传约定字段，不能传 `accountId`、`role` 或设备 SN 选择身份。
- 响应包含业务 `request_id`，发生问题时回传它和北京时间即可；不要回传验证码、token、完整手机号或用户正文。

|用途|方法与路径|
|---|---|
|发送验证码|`POST /api/auth/sms/send`|
|校验验证码并登录/自动注册|`POST /api/auth/sms/verify`|
|读取当前账号的设备|`GET /api/profile/bound-devices`|
|读取某台设备首页数据|`GET /v1/parent/devices/{public_id}/dashboard`|

以下手机号、验证码、token 均为格式示例，不用于真实发送。

### 发送验证码

请求：

```http
POST /api/auth/sms/send
Content-Type: application/json
```

```json
{"phone":"13800138000"}
```

成功响应 `HTTP 200`：

```json
{
  "ok": true,
  "request_id": "smsreq-<uuid>",
  "expires_in": 300,
  "resend_after_s": 60
}
```

`200` 代表短信供应商已受理且服务端已保存验证码，不代表持有人已经看到短信。验证码和 Spug 凭据都不会返回给前端。响应禁止缓存。

频控响应示例 `HTTP 429`，同时返回 `Retry-After: 53`：

```json
{
  "ok": false,
  "error": "rate_limited",
  "reason": "interval",
  "message": "发送太频繁，请 53 秒后再试",
  "retry_after_s": 53,
  "request_id": "smsreq-<uuid>"
}
```

前端按服务端的 `retry_after_s` 倒计时，不固定等待一小时或一天；不要自动循环重试。

### 校验验证码并登录

请求：

```http
POST /api/auth/sms/verify
Content-Type: application/json
```

```json
{"phone":"13800138000","code":"123456"}
```

成功响应 `HTTP 200`：

```json
{
  "ok": true,
  "token": "<JWT，仅保存在客户端认证存储中>",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "account": {
    "id": "acct-20",
    "role": "parent",
    "nickname": "<该账号原昵称>",
    "phone_masked": "138****8000"
  },
  "is_new": false,
  "request_id": "smsreq-<uuid>"
}
```

`is_new=false`：复用该手机号的原账号。首次验证成功的手机号由后台自动建号，`is_new=true`；同号后续登录仍返回相同账号 ID。新账号设备列表为空，不继承其他账号设备。

验证码无效示例 `HTTP 401`：

```json
{
  "ok": false,
  "error": "code_invalid",
  "message": "验证码错误或已过期",
  "request_id": "smsreq-<uuid>"
}
```

错误、过期、未发送、已使用或超过尝试次数均统一为 `code_invalid`。前端不依赖内部细分原因。

### 使用返回的 token

```http
GET /api/profile/bound-devices
Authorization: Bearer <上一步返回的token>
```

从返回的 `devices[].public_id` 选择设备，再请求：

```http
GET /v1/parent/devices/<public_id>/dashboard
Authorization: Bearer <同一个token>
```

沿用现役 parent JWT（issuer=p003、audience=kidshub），有效期 30 天。它适用于家长账号设备读取与现有家长 BLE 绑定接口；不能替代硬件上报用的 Device Bearer。无 token 为 401；访问不属于自己的目标设备返回 404，不披露设备是否存在。token 到期后重新短信登录，本次未新增刷新 token 协议。

## 2. 验证码与频控合同

|项目|当前生效值/规则|
|---|---|
|手机号|中国大陆 11 位手机号，`1[3-9]` 开头|
|验证码|六位数字，服务端安全随机生成|
|有效期|供应商受理后服务端存码起 300 秒，恰好到期即无效|
|重发间隔|同手机号 60 秒|
|同号小时额度|5 次 / 滚动 1 小时|
|同号日额度|10 次 / 滚动 24 小时，不按零点重置|
|同 IP 额度|20 次 / 滚动 24 小时；同一办公出口共享额度|
|错误尝试|每个验证码最多 5 次错误尝试；达到后不能再成功|
|一次性|验证成功立即消费，重放或并发第二次验证拒绝|
|新码覆盖|再次发送成功后，新码覆盖旧码|
|网络超时|Spug 调用最多 10 秒，结果不明不自动再次发送|
|持久化|额度跨重启保留，发送前预占；进程崩溃和临时锁到期不会清除可能计费的发送次数|
|计数口径|已受理、发送结果不明计额度；供应商明确业务拒绝释放预占|

沿用现有内部测试白名单配置；**本次 A/B 不在额度豁免名单内**，按上述完整限制执行。本次未调整白名单或频控环境变量。IP 来自服务器 Nginx 覆盖写入的可信 `X-Real-IP`，不能靠客户端伪造 `X-Forwarded-For` 绕过。

## 3. 错误码与前端处理

|HTTP|error / reason|含义与处理|
|---|---|---|
|400|`bad_phone`|发送接口手机号或请求结构不符合要求，修正输入|
|400|`bad_request`|校验接口字段错误、额外字段或请求体超过 4 KiB，修正请求|
|401|`code_invalid`|验证码无效，检查输入或等倒计时结束后重新获取|
|429|`rate_limited` / `interval`|同号冷却或已有发送进行中，使用 `retry_after_s`|
|429|`rate_limited` / `phone_hour`|同号滚动小时额度已用完|
|429|`rate_limited` / `phone_day`|同号滚动 24 小时额度已用完|
|429|`rate_limited` / `ip_day`|同出口 IP 滚动 24 小时额度已用完|
|502|`send_failed`|供应商拒绝或发送结果未确认；未知结果可能已发出，禁止自动循环重发，尊重返回的 `retry_after_s`（若有）|
|502|`verify_failed`|验证码存储/上游核验异常，保留 request_id 排查，不当成验证码错误|
|503|`sms_not_configured`|短信通道配置缺失，联系服务端|
|503|`auth_not_configured`|登录签名配置未就绪，服务端在付费发送和消耗验证码前拒绝|
|503|`sms_unavailable`|存储忙等未预期服务异常，稍后手动重试；不返回内部错误详情|
|500|`account_login_failed`|验证码已核验但账号登录未完成，回报 request_id；按提示重新获取验证码|

当前实际通道为 Spug。保留的旧 Aliyun 回滚适配可能带 `reason=aliyun_frequency`，本次不是该通道，不要求前端为此新增流程。

## 4. A/B 原身份与权限

|测试身份|手机号（脱敏）|原账号|本次发布后权限|
|---|---|---|---|
|A|138****3227|acct-20|保留 SN 尾号 03800006、02000002 两台设备|
|B|181****2645|acct-27|设备列表为空，无权读取 A 的设备|

发布前后对 accounts、device_registry 的身份/权限快照摘要核同。没有重新建 A/B 账号、迁移游戏数据或修改设备归属。

16:53 北京时间另用服务端签发的 60 秒诊断 JWT 实测公网：A 设备列表 200、2 台，03800006 dashboard 200；B 列表 200、0 台，同一 dashboard 404。**这是现役鉴权/权限的只读诊断证据，不冒充持有人使用真实短信验证码登录。**

## 5. 真实短信发送结果

实发时间：2026-11-03 北京时间 16:50:18–16:50:19。通过本次上线的公网 `/api/auth/sms/send` 发送，每个号码仅主动实发一条。

|身份|业务 request_id|Spug request_id|发送接口|16:52:14 查询状态|
|---|---|---|---|---|
|A|smsreq-5ab914ae-0254-43d8-a0a1-8fe9c7a13f00|WYXwm6ylo9b8b1VZ|200，TTL 300 秒|2 / success，目标尾号 3227|
|B|smsreq-0030d3be-b939-4f0b-a64b-40dd369b380c|od4AjbPDRLd8vW7y|200，TTL 300 秒|2 / success，目标尾号 2645|

状态区分：

- 服务端接口受理：A/B 均已验证。
- 供应商发送状态：A/B 均为成功。
- 手机持有人实际看到短信：已请持有人确认，待回执。
- 持有人用真实码登录，再拿返回 token 完成 A/B 权限对账：待回执。16:57:43 服务端复查尚未观察到本轮 A/B 的短信登录成功记录，不能据此推断手机未收信。

旧码过期后由持有人在前端手动重新获取；服务端不会为了等回执反复实发。可使用现有家长端 `https://p003.hahaxiong.cc/` 的短信登录入口验证，或小程序按本合同接入后验证。仅回报是否收到、时间、脱敏身份、业务 request_id 和 HTTP 状态，**不发送验证码或 token 到群/文档**。

Spug 官方依据：[短信发送](https://push.spug.cc/guide/sms)、[发送状态查询](https://push.spug.cc/guide/request/query)。短信模板编码是发送凭据；指定 RTF 中的账户级凭据与现役状态查询凭据核同。App Key 不应替换短信模板编码，前端无需持有这些凭据。

## 6. 已完成验收与客户端用例

|验证层|结果|
|---|---|
|本地原短信回归|53/53|
|并发、限流、HMAC、原账号/自动建号、异常等加固|17/17|
|真实 localhost HTTP + SQLite + JWT + A/B 设备权限|21 项断言通过；外部短信替身|
|Spug transport|8/8，包含真实等待 10 秒后的超时；未使用真实供应商发送|
|微信 / BLE 回归|微信 23、BLE core 26、guards 19、BLE HTTP 完整流程均通过|
|配网 / 遥测回归|148/148、37/37|
|独立审计|固定源码候选 PASS_ISOLATED，无未关闭阻断|
|服务器 Node 22.22.2 隔离 staging|53 + 17 + 21 + 8 全部通过，再部署|
|公网、运行源码、权限、进程|主服务本机健康 200、公网短信 JSON 接口可用、4 文件 hash 核同、A/B 权限不变、其他相关服务未重启|
|全仓 tsc|12 项既有错误，候选与基线日志一致；不标为通过|

客户端接续只需完成以下真实用例，勿为测试主动打满付费短信限额：

1. A 收到码后登录：`is_new=false`、`account.id=acct-20`；原两台设备可见，03800006 首页能读。
2. B 登录：`is_new=false`、`account.id=acct-27`；列表为空；直接访问 A 的 public_id 返回 404。
3. 一枚已成功登录的码再次校验返回 401；不要继续使用 token 已失效的旧会话判断登录结果。
4. 新手机号自动建号已在隔离环境验证。若业务方另指定新手机号 C，再真实核 `is_new=true`、空设备、第二次登录同一 ID；本轮未给无授权的新号码发短信。
5. 前端按实际 `retry_after_s` 倒计时，网络结果不明不自动重试发送；不在日志上报验证码/token。

回传模板：`身份 A/B；北京时间；是否收信；send request_id；verify request_id/HTTP；account.id/is_new；设备列表数量；目标 dashboard HTTP；实际现象`。不要把供应商成功与完整端到端验收混为同一状态。

## 7. 发布、回滚与留档

- 开发分支：`codex/p003-sms-login-20261103`；左侧工作树名：`P003 小程序短信登录｜开发`。
- 已部署代码：`558607252f92b313cf1843970d637af3c792e9f9`，已 commit/push 并远端核同。
- 回滚源码标签：`rollback/p003-sms-pre-20261103` → `98190bf737ad52dadf8a9d9d5883248b5659df94`，已推送。
- 线上备份：`/opt/p003/server/backups/sms-login-20261103T084911Z`，包含 4 个源码 before 字节、manifest 和 SQLite 在线取证备份。
- 本次仅改 4 个短信运行文件，仅重启 `p003-voice` 一次。Analytics、Worker、倾听、搜索、Ark 的代码和开关未修改；未改 Nginx、JWT 密钥或 Spug 凭据。
- 回滚核对当前 after SHA，再恢复对应 before 字节并重启主服务。仓内 `rollback.py` 提供精确流程，**未执行回滚**。
- 不回灌数据库、不撤销新建账号、不清零发送额度。旧代码不认识本次 HMAC 码，若退旧版本，在途用户需遵守重发间隔重新取码；现有登录 token 与设备绑定不受影响。

详细证据：同目录 `EVIDENCE.json`、`DEPLOY_MANIFEST.json`、`INDEPENDENT_REVIEW.md`。凭据、完整手机号、验证码和 token 不入仓库或回执。

本轮经验：付费发送必须先持久记账，不能只靠 30 秒临时锁；未知响应也要计入额度。服务器支持早期登录不等于小程序链路已验收，必须分别检查账号复用、设备授权、供应商状态和持有人实收。

署名：codex（OpenAI）| 2026-11-03
