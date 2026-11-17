# 微信身份后端实现与测试证据

**已完成代码和隔离验证，未独立提交或部署。** 生产 AppSecret 待配置，尚无真人微信 code，不能宣称真实 OpenID/UnionID 已采集。

## 实现

- `account-store.ts`：幂等新增 `account_wechat_identity`，约束 `(app_id,openid)`、`(account_id,app_id)` 及非空 `(app_id,unionid)` 唯一；事务复用手机号原账号。跨账号、替换 OpenID、变更 UnionID 等冲突返回409，不改设备归属。微信未返回 UnionID 时保留历史已验证值。
- `wechat-phone.ts`：服务端使用自身 AppID/AppSecret 调 `code2Session`，验证客户端 AppID 一致性；单次 code/并发保护、超时、响应检查、错误脱敏。session_key 丢弃，不落库或回传。客户端裸 OpenID/UnionID 不受信任。
- `wechat-identity.ts`：导出 `readWechatIdentity(accountId)`；按服务端当前 AppID 读取已验证身份。缺凭据时纯读取仍工作，明确区分缺 AppID 与缺 AppSecret。
- `routes/wechat-auth.ts`：兼容旧手机号登录，新增登录态补齐与身份/配置读取；仅 parent JWT 可补齐且微信手机号必须等于当前账号。

## API 契约

| 接口 | 入参/认证 | 成功响应 |
|---|---|---|
| `GET /api/auth/wechat/config` | 无需登录 | `ok,app_id,configured,configuration_status`，无用户身份/凭据 |
| `GET /api/auth/wechat/identity` | parent Bearer JWT | `ok,wechat_identity` |
| `POST /api/auth/wechat/phone` | 旧 `{phone_code}` 兼容；新 `{phone_code,login_code,app_id}` | 保留 token/account/is_new/request_id，新增 wechat_identity |
| `POST /api/auth/wechat/link` | parent Bearer JWT；上述三字段 | `ok,wechat_identity,request_id`，不切账号 |

DTO 字段：`app_id,configured,configuration_status,state,openid,unionid,unionid_status,verified_at_ms`。

- `configuration_status`：`ready | missing_app_id | invalid_app_id | missing_app_secret | invalid_app_secret`。
- `state`：`linked | not_linked | not_configured`；`unionid_status`：`available | not_returned | not_checked`。
- 已保存身份且当前缺 Secret 时可以 `state=linked,configured=false`，表示可读但不能新交换；无身份始终 NULL，不能伪造。
- 新错误：`wechat_login_code_invalid` / `wechat_app_mismatch` 为401；`wechat_identity_conflict` / `wechat_phone_mismatch` 为409；角色/账号不符403。保留原微信错误契约。客户端应避免把一次授权码401误当现有JWT失效。

## 实际测试

Node v24.19.0；使用隔离 SQLite、真实路由/JWT，仅模拟外部微信/SMS；未发送真实短信。

| 检查 | 结果 |
|---|---|
| RED：新登录契约、配置缺失状态、公共配置读取、非法上游 errcode | 分别观察到400、字段缺失、404、未拒绝畸形成功响应，修正后GREEN |
| `scripts/wechat-identity.test.ts` | PASS 149 assertions：迁移、身份落库、原账号复用、冲突回滚、防伪造/重放/并发、角色隔离、旧接口、缺Secret |
| `scripts/wechat-client.test.ts` | PASS 17 error/timeout cases |
| `scripts/sms-auth.test.ts` | pass=54 fail=0 |
| `scripts/sms-login-hardening.test.ts` | pass=17 fail=0 |
| `scripts/sms-login-http.test.ts` | PASS 21 assertions；真实 localhost HTTP/SQLite/JWT |
| 微信4模块 strict tsc | 通过 |
| 全量 server tsc | 仅既有 `src/listening-content.ts(29,133)` TS2339：GeminiLlmClient 无 abort；本次未改该模块 |
| `git diff --check` | 通过 |

定向类型命令：`tsc --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --strict src/account-store.ts src/wechat-phone.ts src/wechat-identity.ts src/routes/wechat-auth.ts`。

官方依据（2026-11-17 读取）：[code2Session](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session)、[UnionID机制](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/union-id.html)、[手机号授权code与登录code不可混用](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html)。UnionID 需满足微信开放平台绑定条件，未返回时明示不可用。

待主代理完成客户端/Dashboard集成、生产配置与发布，以及带新微信 code 的真机验收。

署名：codex（OpenAI）| 2026-11-17 09:17 CST
