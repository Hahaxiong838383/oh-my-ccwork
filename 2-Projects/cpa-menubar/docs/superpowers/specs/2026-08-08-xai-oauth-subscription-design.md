# CPA Menu xAI OAuth 订阅设计

日期：2026-08-08
目标版本：`0.3.2`

## 1. 目标

在 CPA Menu 现有“添加授权”入口中增加 xAI Grok OAuth 设备码登录，使用户可以从 macOS 菜单栏绑定已有 Grok / SuperGrok 账号，并在授权完成后立即刷新 CPA 账号列表。

本功能只增加 xAI OAuth 账号绑定，不接收 xAI API Key，不改变现有 xAI 官方账单、CPA 路由统计或 Codex OAuth 的数据口径。

## 2. 用户交互

### 2.1 统一入口

现有底部“添加授权”按钮调整为“添加订阅”。点击后弹出订阅类型选择器：

- `Codex`
- `xAI Grok`

选择 Codex 后继续使用现有本机 `1455` 回调和 PKCE 流程，不改变已有行为。

### 2.2 xAI 设备码授权

选择 xAI Grok 后：

1. App 请求 Bridge 创建 xAI OAuth 会话。
2. Bridge 从 CLIProxyAPI Management API 获取设备码授权信息。
3. App 校验并打开 `accounts.x.ai` 授权页面。
4. 浮窗显示：
   - 设备码；
   - “复制设备码”；
   - “打开授权网页”；
   - 剩余有效时间；
   - 当前状态。
5. App 定时查询 Bridge 中的授权状态。
6. 授权完成后关闭设备码面板，提示“xAI 订阅已添加”，并刷新账号及汇总信息。

用户可以取消等待。取消只停止 App 轮询，不删除已有账号，也不触发任何授权文件修改。会话过期、授权被拒绝或上游失败时，界面提供明确的脱敏错误和重试入口。

## 3. App 状态设计

AppModel 增加独立的 xAI 授权状态，避免复用 Codex 回调状态导致流程相互干扰：

- `subscriptionPickerPresented`
- `xaiAuthorization`
- `xaiAuthorizationTask`

`xaiAuthorization` 包含展示所需的最小字段：设备码、授权 URL、状态、到期时间。关闭面板、完成授权、应用退出或重新发起授权时必须取消旧轮询任务。

状态值统一为：

- `pending`：等待用户输入设备码；
- `complete`：授权完成；
- `declined`：用户拒绝；
- `expired`：设备码过期；
- `error`：Bridge 或上游返回脱敏错误。

## 4. Bridge API

### 4.1 创建授权会话

`POST /desktop/v1/oauth/xai/start`

Bridge 调用 CLIProxyAPI Management API 的 xAI 授权入口。对 App 只返回白名单字段：

```json
{
  "state": "opaque-session-state",
  "verification_url": "https://accounts.x.ai/...",
  "user_code": "ABCD-EFGH",
  "expires_in": 1800,
  "status": "pending"
}
```

Bridge 必须校验：

- URL 使用 HTTPS；
- 主机名必须精确等于 `accounts.x.ai`；不接受子域名、重定向目标或相似域名；
- `state`、`user_code` 和有效期非空且在合理范围内；
- 上游响应体、Cookie、Token 和 Management Key 不进入返回值或日志。

### 4.2 查询授权状态

`GET /desktop/v1/oauth/xai/status?state=<opaque-state>`

Bridge 使用对应状态查询 CLIProxyAPI Management API，并返回：

```json
{
  "state": "opaque-session-state",
  "status": "pending",
  "message": null,
  "account_masked": null
}
```

完成时允许返回脱敏账号标识；若上游没有提供可安全展示的账号信息，则只返回完成状态。错误消息使用 Bridge 固定文案，不透传上游响应正文。

### 4.3 会话约束

- Bridge 只接受已配置 Desktop Token 的请求。
- 单个 Desktop Token 同一时间只保留一个活跃 xAI 授权会话；新会话替换旧会话。
- App 每 2 秒轮询一次，并在到期、取消、完成或报错后立即停止。
- Bridge 对状态查询设置短超时，不让上游阻塞桌面接口。
- Bridge 不自行生成或保存 xAI OAuth 凭据；最终授权文件仍由 CLIProxyAPI 官方流程写入生产 auth-dir。

## 5. 安全边界

- xAI Management Key、CLIProxyAPI Management Key、OAuth Token、Cookie 和完整账号标识不进入 App、Git、文档、通知或普通日志。
- 设备码只在当前授权面板短时显示，不持久化到 UserDefaults、Keychain 或磁盘。
- `state` 视为临时不透明标识，不作为账号 ID 保存。
- App 只允许打开校验通过的 xAI HTTPS 授权域名。
- Bridge 错误统一映射为固定中文提示，不回传上游原始错误正文。
- 现有 Codex PKCE verifier、Desktop Token、重置卡二次确认和 auth 文件原子写入边界保持不变。

## 6. 界面约束

- 保持 `400×560` 固定窗口。
- 不在底部并排增加永久按钮。
- 订阅选择器与设备码面板使用轻量弹层，账号列表仍在中部独立滚动。
- 设备码使用等宽字体和足够大的点击区域。
- 授权进行中禁用重复提交，但允许取消和重新打开网页。
- 不把设备码混入全局错误横幅，避免授权结束后继续残留。

## 7. 兼容性与失败处理

- Codex 授权接口和本机 `1455` 回调保持兼容。
- xAI Management OAuth 不可用时，只禁用本次 xAI 添加流程，不影响现有账号、用量刷新和 Codex 授权。
- 应用重启后不恢复未完成的设备码会话，用户重新发起即可。
- 若授权成功但首次账号刷新失败，显示“授权已完成，账号刷新失败”，保留手动刷新能力，不能误报授权失败。

## 8. 验收标准

### 自动测试

- Bridge：start/status 路由、Desktop Token 校验、URL 域名校验、字段白名单、状态映射、超时和错误脱敏。
- App：订阅类型选择、设备码解析、倒计时、轮询停止、取消、完成后刷新、Codex 旧流程回归。
- 运行 `go test ./...`、`go vet ./...`、`go test -race ./...` 和 `swift test`。

### 构建与本机验收

- Release 构建成功，应用签名和版本号为 `0.3.2`。
- 固定窗口尺寸和账号滚动不回归。
- Codex 授权按钮仍能启动原流程。
- xAI 授权页面只打开允许的官方域名。
- 取消、过期、拒绝和重试均不会影响现有账号。

### 生产验收

- 部署 Bridge 后确认健康检查、账号读取和用量接口无回归。
- 用户亲自在 xAI 页面完成一次设备码授权。
- 授权完成后新 xAI 账号出现在浮窗账号列表，并可被后续自动刷新与调度识别。
- 检查 Bridge、systemd 和应用日志，不得出现设备码、Token、Cookie、Management Key 或完整邮箱。

## 9. 非目标

- 不支持填写或管理 xAI API Key。
- 不自动代替用户登录 xAI 或填写设备码。
- 不修改 CPA 的账号调度策略、额度算法或自动刷新配置。
- 不增加 xAI Management Key 配置界面。
- 不在本版本增加其他 OAuth Provider。
