# CPA Menu 可恢复移除无效账号设计

日期：2026-09-02

## 目标

在 CPA Menu 的账号卡展开区域增加“移除无效账号”入口，让用户可以把已失效 OAuth 账号移出 CLIProxyAPI 的生产 auth-dir。操作采用“按钮点击 + 原生 destructive confirmation dialog”二次确认，Bridge 在写入前重新校验账号状态，健康账号不得移除。

本功能不永久删除凭据文件，而是将其原子移动到生产 auth-dir 外的受限隔离目录。账号立即停止参与 CPA 调度，同时保留人工恢复能力。

## 非目标

- 不提供批量移除。
- 不允许移除健康账号。
- 不轮换、撤销或修改 OAuth token 内容。
- 不自动清空隔离目录。
- 不通过公网接口返回 auth 文件名、路径、邮箱明文、account ID 或 token。
- 不重启 CLIProxyAPI、Smart Router 或 Desktop Bridge 来完成移除。

## 用户体验

账号卡仍默认折叠。展开账号卡后：

- 仅当 Bridge 返回 `removal_eligible=true` 时显示红色按钮“移除无效账号”。
- 按钮旁显示非敏感原因：`账号已停用`、`授权已过期且无法刷新`、`授权已被上游拒绝`。
- 点击按钮后出现原生二次确认，标题为“移除这个 CPA 账号？”。
- 确认正文显示脱敏邮箱、Provider，并说明账号将立即停止参与 CPA 调度、凭据会进入可恢复隔离区。
- destructive 按钮文案为“确认移除”，取消按钮不产生任何请求。
- 操作期间仅禁用当前账号按钮并显示进度，不阻塞刷新或其他账号。
- 成功后刷新账号与汇总，状态栏显示“已移除账号：<脱敏邮箱>”。
- 失败时账号继续显示，浮窗展示 Bridge 的固定安全错误文案。

## 无效账号判定

Bridge 是唯一判定权威。App 只消费 Bridge 返回的结果，不自行推导。

账号满足以下任一条件时可移除：

1. auth JSON 明确包含 `disabled=true`。
2. auth 文件的 `expired` 或 ID token `exp` 已过期，并且没有 refresh token。
3. Codex `wham/usage` 实时返回 `401` 或 `403`，即 `usage_status` 为 `http_401` 或 `http_403`。

以下情况不得作为可移除依据：

- 普通网络错误或请求超时。
- `429`、额度耗尽或低额度。
- usage schema 解析失败。
- 仅仅“今天没有使用记录”。
- 账号有 refresh token 且只发生普通 access token 到期。

Bridge 在账号列表生成时返回：

```json
{
  "removal_eligible": true,
  "removal_reason": "authorization_rejected"
}
```

`removal_reason` 仅允许：

- `disabled`
- `expired_without_refresh`
- `authorization_rejected`

## Bridge API

新增路由：

```text
POST /desktop/v1/accounts/{public_id}/remove
Authorization: Bearer <Desktop Token>
Content-Type: application/json
```

请求体：

```json
{
  "confirm": "REMOVE_INVALID_ACCOUNT"
}
```

成功响应：

```json
{
  "account_id": "<12-char-public-id>",
  "status": "removed"
}
```

固定失败语义：

- `400`：确认词错误或 public ID 格式错误。
- `404`：账号不存在或列表刷新后已变化。
- `409`：账号当前不再满足无效条件。
- `500`：隔离目录或原子移动失败。

响应不得包含真实 auth 文件名、隔离路径或上游错误正文。

## 服务端安全流程

1. 校验 Desktop Token。
2. 严格解析 12 字符 public ID，拒绝 `/` 和额外路径。
3. 重新执行 `loadAuthFiles()`，使用 `accountPublicID(file.FileName)` 唯一匹配账号。
4. 重新探测 Codex usage；仅使用本设计定义的三项无效条件判断。
5. 使用 `filepath.Base`、`filepath.Clean` 和 `os.Lstat` 验证源文件：
   - 文件名必须是 auth-dir 的直接子项；
   - 必须是普通文件；
   - 符号链接一律拒绝；
   - 扩展名必须为 `.json`。
6. 创建隔离根目录 `/root/.cli-proxy-api-removed`，权限 `0700`。
7. 创建 UTC 时间批次目录，例如 `20260902T013000Z`，权限 `0700`。
8. 将源 auth JSON 通过同一文件系统的 `os.Rename` 原子移动到批次目录；若同名冲突则拒绝，不覆盖旧文件。
9. 将移动后的文件权限重申为 `0600`。
10. 返回脱敏成功响应；不打印 token、文件正文或真实文件名。

CLIProxyAPI 已监听生产 auth-dir 的文件变化，因此移出 auth-dir 后应自动停止调度。生产验收必须证明账号从 Bridge 列表消失且 CLIProxyAPI 服务未重启；若实机不自动摘除，则本功能不得上线，需另行设计官方 reload 路径。

## App 状态和调用

Swift 模型新增：

```swift
let removalEligible: Bool
let removalReason: String?
```

`AppModel` 新增：

- `removingAccountID: String?`
- `removeInvalidAccount(_:) async`

`BridgeClient` 新增：

- `removeInvalidAccount(accountID:) async throws -> RemoveAccountResponse`

`MenuContentView` 新增：

- `@State private var removalAccount: Account?`
- 原生 destructive `confirmationDialog`
- 账号展开区域的红色移除按钮

## 测试要求

### Bridge

- `disabled=true` 账号返回可移除。
- 已过期且无 refresh token 返回可移除。
- `wham/usage` 返回 401/403 时返回可移除。
- 429、500、网络错误、低额度和健康账号不可移除。
- 错误确认词返回 400，源文件不移动。
- 健康账号即使收到正确确认词仍返回 409。
- 未知 public ID 返回 404。
- 符号链接、嵌套路径、非 JSON 和同名隔离冲突均拒绝。
- 成功后 auth-dir 原文件不存在、隔离文件存在且权限为 `0600`。
- 响应和日志不包含文件名、邮箱明文、account ID 或 token。

### App

- 新字段正常解码，旧 Bridge 缺字段时默认不可移除，保证向后兼容。
- removal reason 映射为三个固定中文文案。
- BridgeClient 请求路径、HTTP 方法和确认词正确。
- 成功后刷新账号列表。
- 请求期间只锁定当前账号操作。

## 发布与验收

1. Bridge：`go test ./...`、`go vet ./...`。
2. App：`swift test`、Release 构建、codesign 验证。
3. 先部署 Bridge，确认旧 App 仍正常读取账号。
4. 覆盖安装新版 App 前结束旧 `CPAMenuBar` 进程。
5. 核对 Bundle 版本、二进制 SHA、进程启动时间。
6. 使用一个预先备份的真实失效账号执行人工验收：
   - 二次确认前文件不变化；
   - 确认后账号从生产列表消失；
   - auth JSON 进入隔离目录且权限正确；
   - CLIProxyAPI、Router、Bridge 全程 active 且无重启；
   - 其他账号真实 `/v1/models` 和低成本推理保持 200。
7. 验收后从隔离目录人工恢复该账号，证明回滚路径有效；再次移除后才作为最终状态。

## 版本

- CPA Menu：`0.3.4 (7)`。
- README 增加可恢复移除、二次确认和隔离目录安全边界。
