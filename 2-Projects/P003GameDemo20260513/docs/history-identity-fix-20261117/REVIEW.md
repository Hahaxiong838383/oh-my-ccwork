# 历史、使用时长与微信身份独立审查

**结论：代码审查通过，未发现尚未解决的重大或中等问题。** 两项有证据的问题已修复并经独立复测：历史数据域相互拖累，以及家长 Dashboard 在异步读取期间撤销授权后仍返回旧 Ark 数据。

审查基线：`35b67d5e976ee4498c9e07ee8ae62e42f43aeab0` 上的本轮未提交候选。审查代理仅阅读源码、运行隔离测试、写本报告；未修改产品源码，未提交或部署，未写真实业务数据库，未发送真实短信。

## 已闭环问题

| 级别 | 位置 | 复现证据及最终处理 |
|---|---|---|
| 中等 | `apps/server/src/parent-observations.ts:14`；`miniapp-dashboard.ts:66` | 原实现先后读取 Analytics 与 telemetry，任一失败会清空两个域；同步 Dashboard 的遥测读取还会提前抛出 503。修复后分别降级，遥测故障保留奖励、库存及奖励进度，Analytics 故障保留已授权遥测用时；缺测数值使用 null。真实 HTTP 测试覆盖双向故障，并验证遥测事件表不可用时仍返回 902 秒奖励进度。 |
| 重大 | `apps/server/src/miniapp-dashboard.ts:184`、`:199` | 独立复现在 Analytics 网关响应前执行 `ark_settings enabled=0, revision+1`：原家长接口返回 200 且 `data.ark.available=true`，当前授权已关闭。修复后新增 `parentReadAuthority`，跨新增 await 比较设备绑定/epoch、角色、Brain 唯一占用、Ark settings/revision/grant、允许名单和两个历史 scope；变化则丢弃整包。相同独立复现已返回 404 且无 data。正式测试另覆盖 grant 替换、角色变化与共享 Brain。 |

独立撤销复现文件：`/tmp/codeg-acp/2883-845e6b84/p003-review-await-e2lm1h8h/review.mts`。该脚本使用临时 SQLite 和实际 localhost HTTP，未替换被审产品实现。

## 复核范围

- 微信：服务端 `code2Session`、AppID 核对、只接受微信返回的 OpenID/UnionID、手机号原账号复用、冲突原子回滚、已登录补齐、重放及并发重放、缺 Secret 状态、响应与日志凭据脱敏、旧 `phone_code` 和短信兼容。
- 历史：内部 token、只读 SQLite、完整 C 机显式绑定 scope、查询前后复核、绑定代次/epoch、共享 Brain 限制、游标范围/篡改/过期/高水位锚点、按发生时间筛选，以及独立数据域降级。
- 时长：301→600→902 只计 902，区间合并去重，计数回退保守取日高水位，在位/姿态有界估算，跨日与异常时间，真实 0 与缺测分开。推导量明确归入估算，不把缺测补成 0。
- 展示：admin 与 miniapp 共用 DTO；历史奖励/道具按域及分页展示，保留发生/接收时间、覆盖与来源未确认状态；两币未知不伪造余额；H5 短信入口和微信小程序授权入口分别保留；401 业务授权失败不误清当前会话。

## 独立执行的验证

| 验证 | 结果 |
|---|---|
| `wechat-identity.test.ts` | 149 assertions 通过；实际 SQLite、JWT、路由，仅微信上游 HTTP 为夹具 |
| `wechat-client.test.ts` | 17 个错误、异常响应与超时检查通过 |
| `sms-login-hardening.test.ts` | 17/17 通过，短信传输为夹具 |
| `sms-login-http.test.ts` | 21 assertions 通过，实际 localhost HTTP/SQLite/JWT |
| history scope/observations/usage/gateway/dashboard + miniapp-admin | 最终授权修复后 45/45 通过 |
| 独立撤销授权复现 | 修复前 200+旧 Ark；修复后 404、无 data，1/1 通过 |
| 补充真实 0 用例后的 `history-usage.test.ts` | 10/10 通过；仅将计数拒绝条件 `<=0` 改为 `<0` |
| miniapp 全量单测及类型检查 | 14 文件、111 tests 通过；`tsc --noEmit` 通过 |
| `git diff --check` | 通过 |

## 冻结候选核对

已逐项计算本地 SHA-256：更新后的 `SOURCE-MANIFEST.json` 中 14 个 server/admin 文件全部一致，无不匹配项。该 manifest SHA-256：`2e201b7dc42270fdd944ea7ff986e4e4ec56b6423f1794927b3408ccf5587ec6`。其中 `history-usage.ts` 的最终 SHA：

`fba53fac143f363a9f1b02d231a81655bfd3598a8eb09fe36356adb0b26700b4`

`ui/frontend-manifest.json` 的 138 个源码、9 个 H5 产物、17 个 weapp 产物均与本地文件一致。前端 manifest SHA-256：`95af9b6afafc3378acb690561fd392fe65c0167fb838e9565d26491a04723e4d`。

本审查不将主代理另行执行的生产 Node 22/24 隔离回归、浏览器验收或真实微信授权计为本代理已独立验证。全量 server 类型检查的既有 `listening-content.ts:29` 错误不属于本轮发现。

署名：codex（OpenAI）| 完成时间：2026-11-17 09:30 CST
