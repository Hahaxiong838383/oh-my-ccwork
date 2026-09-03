# Studio Codex 双订阅自动切换 SOP

> 用于在 Studio 本机安全保存两个 ChatGPT Codex 订阅，并在活动账号接近周额度上限时自动切换。

## 已验证基线

- 目标主机：Studio，用户目录 `/Users/fu-121`。
- Codex provider 固定为官方 `openai`，不回退 CPA。
- `ccswap 0.31.0` 固定到审计提交 `e5063a319bf5211f67df6351bf2d5d0919a132b8`。
- 两个账号都必须在 Studio 发起新的 `codex login --device-auth`；浏览器可在 Air 或 Studio 完成验证。
- `cli_auth_credentials_store = "file"`，只切换 `~/.codex/auth.json`。
- 策略：`best`、阈值 `90%`、冷却 `300s`、每 `300s` 检查一次。

## 关键原则

1. **禁止复制 `auth.json`**：不同主机各自做设备授权，避免两端共享 refresh-token lineage 后出现 `invalid_grant`。
2. **切换只对下一进程生效**：Codex/App Server 启动后不会热读 `auth.json`，切换凭据后必须重启。
3. **任务优先**：先查询 `thread_history_1.sqlite` 与 `queue_1.sqlite`；有运行中 Turn 或排队项时只等待，不中断。
4. **socket owner 是运行真值**：`app-server.pid` 可能残留 zombie；以 `app-server-control.sock` 的 `lsof` owner 为准。
5. **不用裸 `daemon restart`**：已有 SSH proxy 时可能一直等待。空闲后只终止实际 socket owner，让 ChatGPT App/受管连接重新拉起。
6. **CC Switch 与本方案互斥**：守护进程检测到 `cc-switch`/`ccswitch` 就停止调度，避免双重接管。
7. **失败回滚**：账号已换但 App Server 重启失败时，切回原槽位并再次重启。

## 文件

- `codex-account-guard.py`：空闲门控、额度检查、切换、精确重启和回滚。
- `ccswap-studio`：隔离 `ccswap` 数据目录，避免在 HOME 根新增 `.claude-swap-backup`。
- `safe-account-summary.py`：只输出槽位、套餐和用量，不输出邮箱、Token 或账号 ID。
- `com.mycc.codex-account-switch.plist`：每 5 分钟执行一次守护检查。
- `INSTALL-MANIFEST.json`：版本、上游提交和策略审计锚点。

## 登记账号

先备份 `~/.codex/config.toml`，再设置：

```toml
model_provider = "openai"
cli_auth_credentials_store = "file"
```

每个账号分别执行一次，且必须在前一个账号保存完成后再登录下一个账号：

```bash
codex login --device-auth
~/.codex/account-switch/bin/ccswap-studio codex add --slot 1

codex login --device-auth
~/.codex/account-switch/bin/ccswap-studio codex add --slot 2
```

设备验证码只能进本机剪贴板或 `0600` 临时文件，授权完成立即清空；禁止写入聊天、Git、Skill、记忆或日志正文。

## 部署与检查

```bash
install -m 700 codex-account-guard.py ~/.codex/account-switch/bin/
install -m 700 ccswap-studio ~/.codex/account-switch/bin/
install -m 700 safe-account-summary.py ~/.codex/account-switch/bin/
install -m 600 com.mycc.codex-account-switch.plist ~/Library/LaunchAgents/

plutil -lint ~/Library/LaunchAgents/com.mycc.codex-account-switch.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mycc.codex-account-switch.plist
launchctl kickstart gui/$(id -u)/com.mycc.codex-account-switch

~/.codex/account-switch/bin/safe-account-summary.py
tail -20 ~/.codex/account-switch/logs/guard.jsonl
launchctl print gui/$(id -u)/com.mycc.codex-account-switch
```

## 验收门

- `ACCOUNT_COUNT=2` 且 `DISTINCT_ACCOUNT_IDS=2`。
- 两个槽位 `USAGE_OK=1`。
- 受控执行 `1 → 2 → 1`，每次切换后 socket owner PID 变化。
- 两个槽位分别完成一次官方 `gpt-5.6-sol` 最小真调用。
- LaunchAgent `last exit code = 0`，`launchd.err.log` 为 0 字节。
- Guard 日志无 `fatal`/`restart-failed`，设备验证码与登录原始日志为 0 字节。

## 生产验收记录（2026-09-04）

- 两个独立 Codex Pro 账号用量均可读取；验收时槽位 1 周用量 86%，槽位 2 为 12%。
- 双向切换后两侧 `gpt-5.6-sol` 真调用均通过。
- App Server socket owner 完成两次重连；最终活动槽位恢复为 1。
- 当前 LaunchAgent 每 300 秒运行，达到 90% 时才切换；全部账号无可用额度时保持原状，不切 CPA。
