# xAI OAuth Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add xAI Grok device-code OAuth to CPA Menu's unified “添加订阅” entry while preserving the existing Codex PKCE flow and all credential boundaries.

**Architecture:** The macOS app presents a provider picker and a transient xAI device-code sheet. The Bridge proxies only the production CLIProxyAPI Management OAuth start/status endpoints, validates the `accounts.x.ai` URL, maps upstream states to a fixed allowlist, and never returns the Management Key or raw upstream errors.

**Tech Stack:** Swift 6.2, SwiftUI, AppKit, Go, `net/http`, CLIProxyAPI Management API, macOS Keychain.

**Execution Status:** Completed on 2026-08-08; Bridge and CPA Menu `0.3.2` were tested, deployed, and visually accepted. Final creation of an xAI account still requires the user to complete the short-lived device-code authorization.

---

## File Map

- Create `bridge/internal/bridge/xai_oauth.go`: upstream xAI OAuth client, validation, state mapping, and handlers.
- Modify `bridge/internal/bridge/models.go`: allowlisted Bridge response models.
- Modify `bridge/internal/bridge/server.go`: xAI start/status routes.
- Modify `bridge/internal/bridge/server_test.go`: Bridge contract, security, and route tests.
- Modify `app/Sources/CPAMenuBar/Models.swift`: xAI OAuth response/state models and URL validation.
- Modify `app/Sources/CPAMenuBar/BridgeClient.swift`: xAI start/status requests.
- Modify `app/Sources/CPAMenuBar/AppModel.swift`: device-code lifecycle, polling, cancellation, and completion refresh.
- Modify `app/Sources/CPAMenuBar/MenuContentView.swift`: unified provider picker and xAI authorization sheet.
- Create `app/Tests/CPAMenuBarTests/XAIOAuthTests.swift`: model decoding, URL allowlist, and terminal-state tests.
- Modify `app/scripts/build-app.sh`: version `0.3.2`, build `5`.
- Modify `README.md`: document xAI OAuth capability and security boundary.

### Task 1: Bridge xAI OAuth Contract

**Files:**
- Create: `bridge/internal/bridge/xai_oauth.go`
- Modify: `bridge/internal/bridge/models.go`
- Test: `bridge/internal/bridge/server_test.go`

- [ ] **Step 1: Add failing start-response and secret-leak tests**

Add tests that mock `GET /v0/management/xai-auth-url?is_webui=true`, require `Authorization: Bearer <management key>`, and return:

```json
{"expires_in":1800,"flow":"device","state":"opaque-state","status":"ok","url":"https://accounts.x.ai/device","user_code":"ABCD-EFGH"}
```

Assert the Bridge response contains only `state`, `verification_url`, `user_code`, `expires_in`, and `status`; assert it never contains the management key, upstream-only fields, Cookie, Token, or raw error body.

- [ ] **Step 2: Run the focused Go test and verify failure**

Run: `cd bridge && go test ./internal/bridge -run 'TestXAIAuthStart' -count=1`

Expected: FAIL because xAI OAuth handlers and models do not exist.

- [ ] **Step 3: Define allowlisted response models**

Add these public Bridge models in `models.go`:

```go
type XAIOAuthStartResponse struct {
    State           string `json:"state"`
    VerificationURL string `json:"verification_url"`
    UserCode        string `json:"user_code"`
    ExpiresIn       int    `json:"expires_in"`
    Status          string `json:"status"`
}

type XAIOAuthStatusResponse struct {
    State         string `json:"state"`
    Status        string `json:"status"`
    Message       string `json:"message,omitempty"`
    AccountMasked string `json:"account_masked,omitempty"`
}
```

- [ ] **Step 4: Implement xAI OAuth start validation**

Create `xai_oauth.go` with upstream structs that accept `url`, `state`, `user_code`, `expires_in`, `flow`, and `status`. Implement `handleXAIOAuthStart` to call:

```text
GET {CLIProxyURL}/v0/management/xai-auth-url?is_webui=true
Authorization: Bearer {CLIProxyManagementKey}
```

Require `flow == "device"`, `state != ""`, `user_code != ""`, `1 <= expires_in <= 3600`, HTTPS, and `hostname == "accounts.x.ai"`. Return fixed errors such as `xAI authorization is unavailable` and never include the upstream body.

- [ ] **Step 5: Run the focused test and verify pass**

Run: `cd bridge && go test ./internal/bridge -run 'TestXAIAuthStart' -count=1`

Expected: PASS.

### Task 2: Bridge Status Polling and Routes

**Files:**
- Modify: `bridge/internal/bridge/xai_oauth.go`
- Modify: `bridge/internal/bridge/server.go`
- Test: `bridge/internal/bridge/server_test.go`

- [ ] **Step 1: Add failing state-mapping tests**

Cover upstream responses:

```json
{"status":"wait"}
{"status":"ok"}
{"status":"error","error":"sensitive upstream detail"}
```

Require Bridge mappings `wait -> pending`, `ok -> complete`, and `error -> error` with the fixed message `xAI authorization failed`. Verify a missing state returns HTTP 400 and no raw upstream error is exposed.

- [ ] **Step 2: Run the focused status tests and verify failure**

Run: `cd bridge && go test ./internal/bridge -run 'TestXAIOAuthStatus' -count=1`

Expected: FAIL because the status route is absent.

- [ ] **Step 3: Implement the status handler**

Call:

```text
GET {CLIProxyURL}/v0/management/get-auth-status?state={url-encoded-state}
Authorization: Bearer {CLIProxyManagementKey}
```

Allow only non-empty states up to 512 characters. Map only `wait`, `ok`, and `error`; unknown values become a fixed Bridge error. Use the existing configured HTTP client timeout.

- [ ] **Step 4: Register authenticated routes**

Add:

```go
case r.Method == http.MethodPost && r.URL.Path == "/desktop/v1/oauth/xai/start":
    s.handleXAIOAuthStart(w, r)
case r.Method == http.MethodGet && r.URL.Path == "/desktop/v1/oauth/xai/status":
    s.handleXAIOAuthStatus(w, r)
```

- [ ] **Step 5: Run Bridge tests**

Run: `cd bridge && gofmt -w internal/bridge/xai_oauth.go internal/bridge/models.go internal/bridge/server.go internal/bridge/server_test.go && go test ./... && go vet ./...`

Expected: all packages PASS and vet emits no diagnostics.

### Task 3: Swift xAI OAuth Models and Client

**Files:**
- Modify: `app/Sources/CPAMenuBar/Models.swift`
- Modify: `app/Sources/CPAMenuBar/BridgeClient.swift`
- Create: `app/Tests/CPAMenuBarTests/XAIOAuthTests.swift`

- [ ] **Step 1: Add failing decoding and URL-validation tests**

Test decoding of the Bridge start/status payloads, require `https://accounts.x.ai/...` to pass, and reject HTTP, subdomains, suffix attacks such as `accounts.x.ai.example.com`, userinfo, and non-xAI hosts.

- [ ] **Step 2: Run Swift tests and verify failure**

Run: `cd app && swift test --filter XAIOAuthTests`

Expected: FAIL because the models and validation do not exist.

- [ ] **Step 3: Add Swift models**

Add:

```swift
struct XAIOAuthStartResponse: Decodable, Equatable {
    let state: String
    let verificationURL: URL
    let userCode: String
    let expiresIn: Int
    let status: String
}

struct XAIOAuthStatusResponse: Decodable, Equatable {
    let state: String
    let status: String
    let message: String?
    let accountMasked: String?
}

enum XAIOAuthValidation {
    static func isAllowedVerificationURL(_ url: URL) -> Bool
}
```

The allowlist requires HTTPS, exact host `accounts.x.ai`, and no embedded username/password.

- [ ] **Step 4: Add BridgeClient methods**

Add `startXAIOAuth()` using `POST oauth/xai/start` and `xaiOAuthStatus(state:)` using a URL-query-safe request to `oauth/xai/status`.

- [ ] **Step 5: Run Swift tests**

Run: `cd app && swift test --filter XAIOAuthTests`

Expected: PASS.

### Task 4: AppModel Device-Code Lifecycle

**Files:**
- Modify: `app/Sources/CPAMenuBar/AppModel.swift`
- Test: `app/Tests/CPAMenuBarTests/XAIOAuthTests.swift`

- [ ] **Step 1: Add pure terminal-state coverage**

Test that `complete`, `declined`, `expired`, and `error` are terminal states while `pending` is not. Test expiration calculation from the start timestamp and `expires_in`.

- [ ] **Step 2: Add observable authorization state**

Add a focused `XAIAuthorizationSession` value containing `state`, `verificationURL`, `userCode`, `startedAt`, `expiresAt`, `status`, and `message`. Publish it from AppModel and keep the polling `Task` private.

- [ ] **Step 3: Implement start, cancel, and polling**

`startXAIAuthorization()` must validate configuration, call the Bridge, validate the URL again, publish the session, open the browser, and poll every two seconds. `cancelXAIAuthorization()` cancels and clears the task/session. Terminal states cancel polling; `complete` refreshes accounts and summary, while refresh failure produces `授权已完成，账号刷新失败` rather than changing the authorization result.

- [ ] **Step 4: Preserve Codex behavior**

Rename UI-facing state only where necessary; do not change the Codex listener port, callback payload, PKCE exchange, or success refresh flow.

- [ ] **Step 5: Run all Swift tests**

Run: `cd app && swift test`

Expected: all tests PASS.

### Task 5: Unified Subscription UI

**Files:**
- Modify: `app/Sources/CPAMenuBar/MenuContentView.swift`

- [ ] **Step 1: Add provider selection state**

Add a confirmation dialog titled `添加订阅` with actions `Codex` and `xAI Grok`. The footer remains one button and continues fitting the fixed width.

- [ ] **Step 2: Add the xAI device-code sheet**

Show a compact sheet containing the code in monospaced text, countdown, status, `复制设备码`, `打开授权网页`, `取消`, and `重试` when terminal failure occurs. Clipboard writes use `NSPasteboard.general` and must not persist the code.

- [ ] **Step 3: Prevent duplicate actions**

Disable the footer while either provider authorization is actively starting. Keep cancellation available for xAI and retain the Codex waiting label for the existing flow.

- [ ] **Step 4: Build the app**

Run: `cd app && swift build -c release`

Expected: build succeeds with no Swift errors.

### Task 6: Version, Documentation, and Full Validation

**Files:**
- Modify: `app/scripts/build-app.sh`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-08-xai-oauth-subscription-design.md` only if implementation reveals a factual mismatch.

- [ ] **Step 1: Set release version**

Set `CFBundleShortVersionString` to `0.3.2` and `CFBundleVersion` to `5`.

- [ ] **Step 2: Update README**

Document the unified Codex/xAI subscription entry, xAI device-code flow, CLIProxyAPI ownership of final auth files, and the rule that device codes and credentials are never persisted or logged.

- [ ] **Step 3: Run the full validation suite**

Run:

```bash
cd bridge && go test ./... && go vet ./... && go test -race ./...
cd ../app && swift test && ./scripts/build-app.sh
plutil -p "dist/CPA Menu.app/Contents/Info.plist"
codesign --verify --deep --strict "dist/CPA Menu.app"
```

Expected: all tests pass, version is `0.3.2` build `5`, and codesign verification succeeds.

- [ ] **Step 4: Scan the exact change set for secrets**

Inspect only the cpa-menubar diff and reject any token-like value, complete email, production Management Key, device code, Cookie, or authorization response body before staging.

### Task 7: Deploy and Close

**Files:**
- Runtime: `aliyun-jp:/opt/cpa-desktop-bridge/cpa-desktop-bridge`
- Runtime: `/Applications/CPA Menu.app`

- [ ] **Step 1: Deploy Bridge**

Run: `bridge/deploy/deploy.sh aliyun-jp`

Expected: systemd service active, nginx config valid, and local health check succeeds.

- [ ] **Step 2: Verify production Bridge without leaking codes**

Use the Desktop Token only from its existing protected file/Keychain path. Verify summary/accounts/Codex routes still respond, start one xAI OAuth session, and report only response keys, URL host, flow, and status—not `user_code`, `state`, or credentials.

- [ ] **Step 3: Install the macOS app**

Run: `app/scripts/install-app.sh`

Expected: the old process is replaced, `/Applications/CPA Menu.app` launches, and the menu-bar item remains responsive.

- [ ] **Step 4: Perform UI acceptance**

Verify the fixed window, provider picker, xAI code sheet, copy/open/cancel behavior, Codex regression, and status polling. Final account creation requires the user to complete the xAI page authorization.

- [ ] **Step 5: Selectively stage, commit, and push**

Stage only `2-Projects/cpa-menubar/**`, review `git diff --cached`, commit with:

```text
feat(cpa-menu): add xai oauth subscriptions
```

Push the current branch to `origin` and verify the remote branch contains the commit. Preserve all unrelated dirty files in the monorepo.
