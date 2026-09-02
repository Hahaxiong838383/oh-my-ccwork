# CPA Menu 可恢复移除无效账号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CPA Menu 中增加经过二次确认的“移除无效账号”入口，并由 Desktop Bridge 将符合严格无效条件的 auth JSON 原子移动到可恢复隔离目录。

**Architecture:** Bridge 负责实时判定账号是否可移除，并通过新的受保护写接口执行二次校验与原子隔离。Swift App 只展示 Bridge 返回的 eligibility/reason，发送固定确认词，不接触真实文件名和凭据。隔离操作不重启 CPA 服务，验收时验证 auth-dir watcher 自动摘除账号。

**Tech Stack:** Go 1.x `net/http`/`os`/`path/filepath`，Swift 6/SwiftUI/Foundation，现有 Desktop Token Bearer 鉴权，systemd/Nginx 部署脚本。

---

### Task 1: Bridge 无效账号判定模型

**Files:**
- Modify: `bridge/internal/bridge/models.go`
- Modify: `bridge/internal/bridge/accounts.go`
- Test: `bridge/internal/bridge/server_test.go`

- [ ] **Step 1: 写失败测试**

增加表驱动测试，覆盖 `disabled`、过期无 refresh、`http_401/http_403` 可移除，以及 429/500/网络错误/健康账号不可移除；断言固定 reason 枚举。

- [ ] **Step 2: 运行定向测试确认失败**

Run: `cd bridge && go test ./internal/bridge -run 'TestAccountRemovalEligibility' -count=1`

Expected: FAIL，因为 `RemovalEligible`、`RemovalReason` 和判定函数尚不存在。

- [ ] **Step 3: 实现最小模型与判定**

在 `Account` 增加：

```go
RemovalEligible bool   `json:"removal_eligible"`
RemovalReason   string `json:"removal_reason,omitempty"`
```

增加纯函数：

```go
func accountRemovalEligibility(file authFile, usageStatus string, now time.Time) (bool, string) {
    switch {
    case file.Disabled:
        return true, "disabled"
    case expired(file.Expired, file.Claims.Exp, now) && file.RefreshToken == "":
        return true, "expired_without_refresh"
    case file.Provider == "codex" && (usageStatus == "http_401" || usageStatus == "http_403"):
        return true, "authorization_rejected"
    default:
        return false, ""
    }
}
```

账号 usage 探测完成后填充两个字段；xAI 仅使用本地 disabled/expired 条件。

- [ ] **Step 4: 运行定向测试**

Run: `cd bridge && go test ./internal/bridge -run 'TestAccountRemovalEligibility' -count=1`

Expected: PASS。

- [ ] **Step 5: 提交边界**

Codex 不提交 `mycc`；记录目标文件并交 cc 精确收口。

### Task 2: Bridge 可恢复移除接口

**Files:**
- Create: `bridge/internal/bridge/remove_account.go`
- Modify: `bridge/internal/bridge/server.go`
- Modify: `bridge/internal/bridge/models.go`
- Modify: `bridge/internal/bridge/config.go`
- Test: `bridge/internal/bridge/server_test.go`

- [ ] **Step 1: 写 handler 失败测试**

使用临时 auth-dir/removed-dir 创建真实 JSON fixture，覆盖：确认词错误 400、未知 ID 404、健康账号 409、符号链接拒绝、同名冲突拒绝、成功移动和 `0600` 权限。

- [ ] **Step 2: 运行定向测试确认失败**

Run: `cd bridge && go test ./internal/bridge -run 'TestRemoveInvalidAccount' -count=1`

Expected: FAIL/404，因为路由和 handler 尚不存在。

- [ ] **Step 3: 增加配置和 DTO**

`Config` 新增：

```go
RemovedAuthDir string
```

默认值：`/root/.cli-proxy-api-removed`，环境变量：`CPA_REMOVED_AUTH_DIR`。

新增 DTO：

```go
type RemoveAccountRequest struct { Confirm string `json:"confirm"` }
type RemoveAccountResponse struct { AccountID string `json:"account_id"`; Status string `json:"status"` }
```

- [ ] **Step 4: 实现安全 handler**

新增路由：

```go
case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/desktop/v1/accounts/") && strings.HasSuffix(r.URL.Path, "/remove"):
    s.handleRemoveInvalidAccount(w, r)
```

handler 必须重新加载账号、重新探测 usage、重新判定 eligibility；使用 `Lstat` 拒绝 symlink，校验直接子文件和 `.json`，创建 `0700` UTC 批次目录，通过 `os.Rename` 移动且不覆盖，重申文件 `0600`。

- [ ] **Step 5: 运行 handler 测试**

Run: `cd bridge && go test ./internal/bridge -run 'TestRemoveInvalidAccount' -count=1`

Expected: PASS，测试响应中不存在 fixture 文件名、邮箱明文和 token。

- [ ] **Step 6: 运行 Bridge 全量测试**

Run: `cd bridge && go test ./... && go vet ./...`

Expected: 全部 PASS，`go vet` 无输出。

- [ ] **Step 7: 提交边界**

Codex 不提交 `mycc`；记录目标文件并交 cc 精确收口。

### Task 3: Swift 模型和 BridgeClient

**Files:**
- Modify: `app/Sources/CPAMenuBar/Models.swift`
- Modify: `app/Sources/CPAMenuBar/BridgeClient.swift`
- Test: `app/Tests/CPAMenuBarTests/AccountListPresentationTests.swift`
- Test: `app/Tests/CPAMenuBarTests/XAIOAuthTests.swift`

- [ ] **Step 1: 写解码和请求失败测试**

断言新字段缺失时默认 `false/nil`；新增 URLProtocol stub 断言 `POST /desktop/v1/accounts/{id}/remove` 与 body `{"confirm":"REMOVE_INVALID_ACCOUNT"}`。

- [ ] **Step 2: 运行 Swift 定向测试确认失败**

Run: `cd app && swift test --filter CPAMenuBarTests.AccountListPresentationTests`

Expected: FAIL，因为字段和客户端方法尚不存在。

- [ ] **Step 3: 实现 Swift DTO 和客户端方法**

`Account` 自定义 `init(from:)`，对新字段使用 `decodeIfPresent`：

```swift
removalEligible = try container.decodeIfPresent(Bool.self, forKey: .removalEligible) ?? false
removalReason = try container.decodeIfPresent(String.self, forKey: .removalReason)
```

新增：

```swift
struct RemoveAccountResponse: Decodable {
    let accountID: String
    let status: String
}
```

BridgeClient 发送固定确认词并复用现有 JSON request/error 处理。

- [ ] **Step 4: 运行 Swift 定向测试**

Run: `cd app && swift test --filter CPAMenuBarTests.AccountListPresentationTests`

Expected: PASS。

- [ ] **Step 5: 提交边界**

Codex 不提交 `mycc`；记录目标文件并交 cc 精确收口。

### Task 4: SwiftUI 二次确认和账号移除状态

**Files:**
- Modify: `app/Sources/CPAMenuBar/AppModel.swift`
- Modify: `app/Sources/CPAMenuBar/MenuContentView.swift`
- Modify: `app/Sources/CPAMenuBar/AccountListPresentation.swift`
- Test: `app/Tests/CPAMenuBarTests/AccountListPresentationTests.swift`

- [ ] **Step 1: 写展示逻辑失败测试**

增加 `removalReasonText(_:)` 测试，锁定三个中文理由；断言健康账号不展示移除入口。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd app && swift test --filter CPAMenuBarTests.AccountListPresentationTests`

Expected: FAIL，因为 reason 映射不存在。

- [ ] **Step 3: 实现 AppModel 状态**

新增：

```swift
@Published var removingAccountID: String?

func removeInvalidAccount(_ account: Account) async {
    guard removingAccountID == nil, let client = makeClient() else { return }
    removingAccountID = account.id
    defer { removingAccountID = nil }
    do {
        _ = try await client.removeInvalidAccount(accountID: account.id)
        statusMessage = "已移除账号：\(account.emailMasked)"
        await refresh()
    } catch {
        errorMessage = error.localizedDescription
    }
}
```

- [ ] **Step 4: 实现 SwiftUI 入口和确认**

增加 `removalAccount` State 和 destructive `confirmationDialog`。按钮仅在 `account.removalEligible` 时显示，操作中显示 ProgressView 并禁用当前按钮。

- [ ] **Step 5: 运行 App 全量测试**

Run: `cd app && swift test`

Expected: 全部 PASS。

- [ ] **Step 6: 提交边界**

Codex 不提交 `mycc`；记录目标文件并交 cc 精确收口。

### Task 5: 版本、文档、构建与发布

**Files:**
- Modify: `README.md`
- Modify: `app/scripts/build-app.sh`
- Modify: `bridge/deploy/deploy.sh`

- [ ] **Step 1: 更新版本和 README**

将 CPA Menu 更新到 `0.3.4 (7)`；README 增加可恢复移除、二次确认、隔离目录和不支持健康账号删除。

- [ ] **Step 2: 运行格式和敏感扫描**

Run:

```bash
gofmt -w bridge/internal/bridge/*.go
git diff --check
rg -n 'sk-[A-Za-z0-9_-]{12,}|Bearer [A-Za-z0-9._-]{12,}|refresh_token|access_token' \
  bridge app README.md docs/superpowers || true
```

Expected: 仅出现字段名和安全文档，不出现真实凭据形态。

- [ ] **Step 3: 构建 Bridge 和 App**

Run:

```bash
cd bridge && go test ./... && go vet ./...
cd ../app && swift test && ./scripts/build-app.sh
codesign --verify --deep --strict --verbose=2 'dist/CPA Menu.app'
```

Expected: 全部 PASS，codesign 验证成功。

- [ ] **Step 4: 部署 Bridge**

Run: `bridge/deploy/deploy.sh aliyun-jp`

Expected: `cpa-desktop-bridge.service` active，旧 App 的 summary/accounts 继续 200。

- [ ] **Step 5: 安装 App**

Run: `app/scripts/configure-production.sh aliyun-jp && app/scripts/install-app.sh`

Expected: 旧进程已结束，新 Bundle 为 `0.3.4 (7)`，运行二进制与 dist SHA 一致。

- [ ] **Step 6: 生产安全验收**

先使用一个已备份的真实失效账号测试取消和确认路径；确认移动、服务不重启、其他账号模型目录和低成本推理 200。随后人工恢复一次证明回滚，再重新移除作为最终状态。

- [ ] **Step 7: 交 cc 收口**

输出精确修改文件、测试命令、部署锚和生产验收结果；不在 Codex 会话直接 commit/push `mycc`。
