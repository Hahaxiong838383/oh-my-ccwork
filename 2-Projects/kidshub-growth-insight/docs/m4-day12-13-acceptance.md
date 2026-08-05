# KidsHub Growth Insight M4 / Day 12–13 验收记录

> 日期：2026-08-05
> 结论：M4 已完成开发、自检、部署与 GitHub/Studio 一致性验证，等待川哥真实体验确认。

## 1. 交付范围

- root 专属 `/admin/data-sources` 数据源与 Token 管理入口。
- 配置 Provider、名称、状态、备注、单次上限、日配额和月配额。
- 数据源支持软删除和恢复；软删除时同步移除 Token。
- JustOneAPI 使用真实生产端点做 Token 活性校验。
- TikHub、Apify、蒲公英、星图、生意参谋、京东商智等入口保留；校验器未接入前 fail-closed，禁止保存 Token。
- Token 校验成功后写入 Studio 本地密钥文件，数据库只保存 `secret_ref`、末四位和状态。
- Token 保存、列表、审计和错误响应均不回显明文。
- Token 支持重新校验、轮换和移除。
- 需要 Token 的数据源未校验成功前不能设置为 active；校验通过后自动 active，移除后回 pending，失效后回 error。

## 2. 密钥存储

- 默认路径：`/Users/fu-121/kidshub-growth/secrets/secrets.env`。
- 路径可通过 `KIDSHUB_SECRETS_FILE` 覆盖，支持后续迁移。
- 目录权限强制为 700，文件权限强制为 600。
- 写入使用同目录临时文件 + rename 原子替换。
- 数据库写失败时回滚文件；文件原本不存在时，回滚后继续保持不存在。
- 删除不存在的 Token 为 no-op，不会凭空创建空密钥文件。

## 3. JustOneAPI 实测依据

官方 Python SDK 当前默认 API 根为 `https://api.justoneapi.com`，Token 使用 query 参数传递，业务成功只认 `code == 0`。

本项目使用无需额外业务参数的轻量端点：

```text
GET /api/xiaohongshu/hot-list/v1?token=<token>
```

Studio 对无效测试 Token 的真实返回：

```text
HTTP 401
code=100
message=TOKEN INVALID/UNACTIVATE
```

应用将其转换为 HTTP 422 的脱敏业务错误，且不写文件、不写 `api_secrets`。

## 4. 自动验收

正式 Studio 回归：

```text
schema verification passed
M2 verification passed
Day 7 verification passed
M3 verification passed
M4 verification passed
{"invalidToken":422,"noEcho":true,"validPath":false,"rejectedAudits":1}
TOKEN_LOG_MATCH_COUNT=0
```

无真实 Token 的正式环境覆盖：

- root 可管理数据源，editor/viewer API 为 403。
- 无 Token 的 JustOneAPI 数据源不能 active。
- 无效 Token 立即返回 422。
- API 响应不含测试 Token。
- 密钥文件无变化，数据库不产生 Token 元数据。
- 无效 Token 事件写入不含明文的审计日志。
- 正式测试结束后 `data_sources=0`、`api_secrets=0`、`api_runs=0`。

## 5. 隔离完整闭环

使用隔离端口和本地 mock 校验器完成有效 Token 全链路，不使用真实付费 Token：

```text
M4 verification passed
{"invalidToken":422,"noEcho":true,"validPath":true,"rejectedAudits":1}
LOG_SECRET_MATCHES=0
FINAL_FILE_SECRET_MATCHES=0
FILE_MODE=600
DIR_MODE=700
```

覆盖：真实校验成功 → 原子写文件 → DB 仅存末四位 → 列表不回显 → 重新校验 → 移除 → 文件无测试 Token。

## 6. 负向验证

临时注入“保存成功响应直接回显 Token”的真漏洞，M4 验收脚本准确失败：

```text
valid token leaked in save response
```

恢复正确代码后，隔离完整闭环和正式环境回归均通过。

## 7. 经验教训

1. **错误 Token 必须先校验再持久化。** 先写文件再验证会让错误凭据短暂成为系统真值，也可能被其他请求读到。
2. **数据源状态必须和 Token 状态联动。** 允许“无 Token 但 active”会制造假健康；保存成功自动 active，移除回 pending，重验失败回 error。
3. **未接验证器的 Provider 必须 fail-closed。** 入口可以先存在，但不能用“待验证”名义保存未知 Token。
4. **删除操作也要验证副作用。** 第一版删除不存在的 Token 会创建空文件；改为 no-op，并让回滚恢复“原本不存在”的状态。
5. **日志探针本身要先确认工具存在。** Studio 没有 `rg`，第一轮日志命令表面输出 0 实际探针未运行；改用实测存在的 `/usr/bin/grep` 后重新得到完整 0 命中。
6. **不回显要在数据访问和响应构造两层保证。** DB 本身不存明文，Prisma select 只取安全字段，API 成功/失败响应再做 Token 精确替换和白名单字段提取。
7. **完整成功路径可用隔离 mock 验证。** 没有真实付费 Token 不等于只能测失败路径；通过环境变量覆盖校验 URL，在隔离实例验证保存、权限、轮换和删除。

## 8. 体验入口

- 首页：`http://192.168.61.177:3200`
- 数据源与 Token：`http://192.168.61.177:3200/admin/data-sources`

当前正式数据源为空，也没有保存任何真实 Token。可创建一个 JustOneAPI 数据源，并输入任意假 Token 验证“立即报错且不落盘”。

## 9. 下一步边界

川哥体验通过后再进入 Day 14–16 / M5：CSV/Excel 上传、解析、行级错误和 raw snapshot 归档。当前未提前实现。
