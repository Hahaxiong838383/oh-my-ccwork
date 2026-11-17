# P003 微信身份链路只读审计

结论：**微信身份链路确实未完成，同时存在代码缺失与生产配置缺失，Dashboard 当前空值不是单纯显示故障。** 当前仓库 live 小程序只进行短信登录；现有微信手机号服务端只兑换手机号，未交换、保存 OpenID/UnionID。主代理生产只读核验确认 `WECHAT_APP_ID/WECHAT_APP_SECRET` 均未配置，其他 WX 别名也未配置。AppID 已存在于小程序项目配置，Dashboard 却仅写了概念说明，没有返回实际应用配置。用户“应该从小程序获取”的方向成立，但 OpenID/UnionID 必须通过小程序登录 code 由服务端向微信校验后取得，不能相信客户端提交的裸标识或把客户端 AppID 当作已经验证的用户身份。

审计基线：HEAD `4d784c8f`，Dashboard 实现 `677d519e`；2026-11-17 08:46 CST。只读审计仓库、公开官方文档；没有修改源码、导入会触发迁移的数据层、访问生产凭据、发送短信或执行生产操作。本文不包含 AppSecret、AppID 实际值、真实用户标识。

## 1. 源码证据

下列相对路径均以 `/Users/fu-121/.codex/worktrees/p003-mini008-realdata-20261111/2-Projects/P003GameDemo20260513` 为根。

| 环节 | 证据位置 | 当前行为与含义 |
|---|---|---|
| live/demo 选择 | `apps/miniapp/src/pages/index/index.tsx:49` | live 构建进入 `RealDataHome`，demo 才进入含开发演示流程的 `DemoIndex`。|
| live 登录页面 | `apps/miniapp/src/pages/index/real-data.tsx:32` | UI 明确短信验证码登录，`controller.login(phone, code)`；没有微信登录按钮。|
| live 登录请求 | `apps/miniapp/src/services/live-api.ts:19` | `/api/auth/sms/send`、`/api/auth/sms/verify`；没有 `Taro.login`/`wx.login`、AppID 采集、微信 code 请求。|
| demo 手机号按钮 | `apps/miniapp/src/pages/index/index.tsx:514` | `getPhoneNumber` 收到 code 后仅设置“服务端验证接口尚未接通”提示，不调用后端，也不形成正式登录。|
| 构建默认入口 | `apps/miniapp/package.json:7` | `build:weapp` 和 `dev:weapp` 显式 live；`config/index.ts:15` 输出 `dist/weapp/`；`project.config.json:3` 使用该目录。|
| 项目 AppID | `apps/miniapp/project.config.json:5` | 已配置且符合 `wx` 加 16 位字符的形式（只检查存在/格式，未披露实际值）。未发现调用 `getAccountInfoSync`。|
| 微信接口挂载 | `apps/server/src/index.ts:55` | 已挂 `/api/auth` 下的微信路由。|
| 微信手机号契约 | `apps/server/src/routes/wechat-auth.ts:19` | strict schema 仅接受 `phone_code`；新增 `login_code`、`app_id` 或裸 OpenID 都会被当前 schema 拒绝。|
| 微信手机号登录 | `apps/server/src/routes/wechat-auth.ts:53` | 校验服务端凭据 → `exchangePhoneCode` → 按手机号 upsert → 要求 `role=parent` → 签发 30 天 JWT。JWT 只有 accountId/parent，无微信标识。|
| 服务端微信配置 | `apps/server/src/wechat-phone.ts:16` | 支持 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`；校验格式，不代表已核实生产实际配置。|
| 上游微信调用 | `apps/server/src/wechat-phone.ts:61`、`:88` | 只有 `cgi-bin/stable_token` 与 `wxa/business/getuserphonenumber`；没有 `sns/jscode2session`。检查手机号 watermark.appid 等于服务端 AppID，随后只返回手机号字符串。|
| 账号 schema | `apps/server/src/account-store.ts:10`、`:78`、`:97` | account 只有 id/nickname/role/created_at/phone；只迁移 phone 列、phone 唯一索引，没有微信 identity 表或字段。|
| 现有手机号复用 | `apps/server/src/account-store.ts:205` | `BEGIN IMMEDIATE` 内按 phone 查找并复用原账户，否则新建 parent；这可用于安全补微信身份而保持原 accountId。|
| 短信账号/JWT | `apps/server/src/routes/sms-auth.ts:133` | 同样按 phone upsert、要求 parent，签发相同 issuer/audience 的 30 天 JWT。|
| 家长与设备绑定 | `apps/server/src/routes/profile.ts:151`、`:183` | 绑定要求 JWT role 与账号 role 均为 parent 且有手机号；设备列表通过 parent_account_id 取得。微信身份应附着家长账号，不能写到 device/Brain 账号。|
| Dashboard 读模型 | `apps/server/src/miniapp-dashboard.ts:123`、`:154` | binding 只有 parent_account_id、parent_phone 等；没有微信身份/AppID。|
| Dashboard 展示 | `apps/web/public/admin/index.html:1331` | OpenID/UnionID 和 AppID 描述均为静态字符串；当前不能随着真实数据变化。|
| Dashboard 权限 | `apps/server/src/routes/miniapp-admin.ts:9` | 有效运营 token 且 admin 才可读该接口，可沿用现有权限展示微信身份。|
| miniapp/server 的微信配置 | `apps/miniapp/server/config.ts:32`、`server/app.ts:18` | 存在 `loadIntegrationSecrets` 配置助手，但 BFF 当前只提供 health/dev probe；不能误认成已实现微信登录。|

全项目检索 `wx.login`、`Taro.login`、`getAccountInfoSync`、`code2Session`、`jscode2session`、openid/unionid 的实际运行源码，未发现另一条已实现的身份交换路径。文档中的未来架构并非现役实现。以上能断定本仓库构建出的 live 客户端行为；未核对微信发布平台当前已发布代码包，不能据此宣称已经核实正式版真机包与 HEAD 完全一致。

## 2. 微信官方事实（已读取当前正文）

获取日期：2026-11-17。web 工具对微信文档域名抓取报错；改用 `curl --compressed` 成功读取微信官方 HTTPS 页面，未使用第三方转述作为结论依据。旧 `api-backend` / `OpenApiDoc` 地址有迁移，以下列当前 URL 为准。

- [小程序登录](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html)，页面更新 2026-06-16：客户端 `wx.login()` 取得临时 code 后传给开发者服务端；服务端 `auth.code2Session` 换取 OpenID、条件满足时的 UnionID 及 session_key。code 只能用一次；session_key 不应下发客户端或对外暴露。
- [小程序登录凭证校验 code2Session](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session)，页面更新 2026-07-04：必须由服务器调用 `GET https://api.weixin.qq.com/sns/jscode2session`，参数为服务端 appid/secret、客户端 js_code、`grant_type=authorization_code`。返回 OpenID；当前小程序绑定微信开放平台账号时返回 UnionID。已列常见错误包括无效 code、风险拦截、频率限制。
- [UnionID 机制](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/union-id.html)，页面更新 2026-06-16：同一微信开放平台账号下跨应用的同一用户具有一致 UnionID；绑定开发者账号的小程序可通过 `wx.login + code2Session` 取得，无需额外用户授权。**不要沿用旧文章中“必须关注公众号或曾授权公众号”作为当前必需条件。**
- [wx.getAccountInfoSync](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/account-info/wx.getAccountInfoSync.html)：`miniProgram.appId` 是当前小程序应用标识，`envVersion` 区分 develop/trial/release；线上 version 仅正式版提供。该 API 不返回用户 OpenID/UnionID。
- [手机号快速验证组件](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html)，页面更新 2026-09-03：用户同意后取得的 phone code 在后端兑换手机号；它与 `wx.login` code 用途不同，不能混用；新方式不要求先调用 wx.login。因此“微信手机号能登录”本身不能证明已获得 OpenID。

准确归属：AppID 属于应用，OpenID 属于该应用下的微信用户，UnionID 属于微信开放平台下的跨应用用户；三个都不是设备 SN、public_id 或 accountId。

## 3. 最小兼容方案

1. **服务端补可信交换。** 在 `wechat-phone.ts` 旁增加或扩展微信登录 client，以现有服务端 `WECHAT_APP_ID/SECRET` 调 `code2Session`。统一 HTTP 超时、错误脱敏、单次 code 防重放/并发保护；不把 secret、session_key、code 或完整上游 body 写日志/回客户端。不接受客户端裸 openid/unionid/accountId/role。
2. **保持旧登录兼容。** 保留短信及 H5 路径；微信手机号路由兼容原 `{phone_code}`，新客户端发 `{phone_code, login_code, app_id?}`。携带 login_code 时必须完成身份交换，不能静默退回“只有手机号且宣称已绑微信”。可选 app_id 只用于检测前后端应用不一致，不用于选择凭据或作为可信身份来源。
3. **原账号内补身份，事务防冲突。** 建 `account_wechat_identity`，至少存 account_id、app_id、openid、nullable unionid、verified_at、source。以 `(app_id,openid)` 唯一，明确是否限制 `(account_id,app_id)` 一条身份。按微信验证手机号找到原 parent accountId，并在同一写事务完成一致性检查和身份关联；已归属别人的 OpenID、已有身份不一致时返回 409，不能迁移设备、覆盖或自动合并账号。UnionID 缺失不覆盖此前已验证的值；有值却变化应拒绝/报告冲突。
4. **只在真实 weapp 接入。** `real-data.tsx`/`live-api.ts` 增加微信登录动作：用户授权手机号时同时取一枚新 `Taro.login` code，将二者送后端。`getAccountInfoSync().miniProgram.appId/envVersion` 可用于客户端诊断，不能当用户身份。H5 继续短信。
5. **Dashboard 返回真实状态。** 由服务端配置读 AppID（AppID 本身不是 AppSecret）；读取当前 parentAccount 的已验证微信身份并提供来源/验证时间。不要因为 AppSecret 缺失让整个 Dashboard 读取失败。OpenID 按当前 AppID 映射取值；无身份显示“尚未绑定微信，请在小程序重新认证”；已交换但微信无 UnionID 显示“微信未返回 UnionID”，可提示检查开放平台绑定，不能断言一定未绑定或用 OpenID/空串伪装 UnionID。

该方案不要求重建家长账号、不改变 accountId/JWT 主体、不改变 parent_account_id，也不影响既有设备归属与数据权限。

## 4. 存量已登录用户补齐

- 历史库只有手机号，不能由手机号反推或批量补出真实 OpenID/UnionID；必须有用户再次在对应微信小程序运行，取得新的微信登录 code。
- 最小可审核路径：提供“补充微信身份”操作，在现有家长 JWT 下提交新 login_code + 新 phone_code；服务端校验 JWT 对应当前 parent，且微信验证手机号等于该账号手机号，再写同一 accountId 的身份。返回新的登录态不是必需，但可统一更新验证时间。
- 如果手机号不同或该 OpenID 已关联另一账号，拒绝补齐并保留原会话/设备绑定；普通“切换账号登录”与“给当前账号补身份”应有明确不同语义。不能单靠客户端 accountId 指定归属，也不能用现有设备 SN 推断微信用户。
- 若不新增补齐端点，也可让用户主动退出后走新微信手机号登录，以验证手机号复用原 accountId。首次身份补齐不应在后台拿过期 JWT 静默关联当前设备上的另一微信用户。
- UnionID 仍未返回时保留 NULL + `not_returned_by_wechat` + 检查时间。把小程序绑定开放平台后，用户下一次重新认证可再补；不要阻塞已有 OpenID/手机号的正常登录。

## 5. 配置与验证状态

| 项目 | 已确认 | 未确认/所需工作 |
|---|---|---|
| 项目 AppID | 小程序 project.config 有效格式 | 应核对与生产 WECHAT_APP_ID、正式微信包一致；报告不展示值。|
| 服务端配置读取 | 代码支持 WECHAT_APP_ID、WECHAT_APP_SECRET；主代理生产只读确认两者及其他 WX 别名均未配置 | 上线可信交换前必须按凭据库流程提供正确配置；客户端已有 AppID 不代表服务端已配置或用户身份已验证。|
| 微信手机号接口 | 已挂载、限流、watermark appid 校验、手机号 parent upsert | 未做本次真实微信授权或调用验收。|
| 微信身份 | 无客户端 wx.login，无 code2Session，无 schema | 必须补实现及迁移。|
| 开放平台绑定 | 当前官方 UnionID 条件明确 | 账号是否已绑定开放平台需查平台或实际交换结果；不能从缺值倒推。|
| 测试现状 | 现有短信 HTTP 测试 `scripts/sms-login-http.test.ts:56` 验证原 accountId/设备保留、越权隔离 | 全库未检出 WechatPhoneClient/createWechatAuthRoute 的测试引用；未运行测试，因为本任务只读且未改代码。|

必要验证：

- 使用隔离 SQLite 和模拟微信 HTTP，覆盖成功有/无 UnionID、旧库迁移、旧 phone-only 与短信路径、AppID 不一致、无效/复用/并发 code、微信超时/限流、无配置、裸标识注入拒绝、日志/响应不泄露敏感值。
- 同手机号新微信身份登录保留 accountId、设备归属；OpenID 跨账号冲突与非 parent 角色拒绝；有登录态补齐时手机号不一致拒绝；失败保持既有身份不变。
- 回归 `sms-login-http`、短信 hardening、miniapp Dashboard/admin 权限、解绑与现有设备数据 ACL；小程序 typecheck、现有单测、H5/weapp 双构建。
- 真机最后验收：真实微信开发/体验/正式环境取 code；服务端可信落库；Dashboard 显示正确 AppID/来源/身份状态；同用户重登幂等；短信/H5 仍可用。无 UnionID 按真实原因保留可用状态。不能使用模拟标识或直接 SQL 填标识冒充真机结果。

署名：codex（OpenAI）| 2026-11-17 08:46 CST
