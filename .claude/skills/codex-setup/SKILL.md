---
name: codex-setup
description: 检查 Codex CLI 是否就绪，可选开启/关闭 stop-time review gate，并维护 Studio 的 ChatGPT 双订阅自动切换。用户提到 "/codex-setup"、"codex 设置"、"检查 codex"、"codex 装好了吗"、"Codex 双账号"、"订阅用完自动切换" 或 Studio 官方订阅时必须使用。
---

# codex-setup — Codex 环境检查与配置

检查本地 Codex CLI 是否已安装、已认证，可选切换 stop-time review gate。

## 触发词

- "/codex-setup"
- "codex 设置"、"检查 codex"、"codex ready"
- "codex 装好了吗"、"codex 能用吗"、"codex 就绪没"

## 参数

| 参数 | 说明 |
|------|------|
| `--enable-review-gate` | 启用 stop-time review gate（每次 session stop 前自动审查代码变更） |
| `--disable-review-gate` | 关闭 review gate |
| 无参数 | 仅检查 Codex 状态 |

## 执行步骤

1. 定位 Codex 插件运行时：

```bash
CODEX_PLUGIN_ROOT="$(ls -d ~/.claude/plugins/cache/openai-codex/codex/* 2>/dev/null | sort -V | tail -1)"
```

2. 运行检查：

```bash
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

3. 根据结果处理：
   - **Codex 未安装且 npm 可用**：询问用户是否安装，若同意则执行 `npm install -g @openai/codex`，然后重新检查
   - **Codex 已安装但未认证**：提示用户运行 `! codex login --device-auth` 进行登录
   - **Codex 就绪**：展示状态信息

4. 向用户展示最终检查结果。

## Studio ChatGPT 双订阅自动切换

用户要把 Air 与 Studio 两个 ChatGPT 订阅都放到 Studio，并按用量自动切换时：

1. 固定 `model_provider = "openai"` 与 `cli_auth_credentials_store = "file"`，关闭 CC Switch；不要把 CPA 当官方订阅池。
2. 两个账号都在 Studio 重新执行 `codex login --device-auth`，完成一个就用 `ccswap codex add --slot N` 保存；浏览器可以在 Air 或 Studio 打开，但禁止跨机复制 `auth.json`。
3. 使用固定审计版 `ccswap 0.31.0`，隔离在 `~/.codex/account-switch/`；账号备份、日志和临时设备码目录必须为 `0700/0600`。
4. 默认策略为 `best`、90% 阈值、300 秒冷却与 300 秒轮询；所有账号耗尽时保持原状，不回退 CPA。
5. 凭据文件切换只对下一进程生效。重启前读取 `thread_history_1.sqlite` 与 `queue_1.sqlite`，有活动 Turn/排队项时延后。
6. 不以 `app-server.pid` 单独判活：PID 可能是 zombie。以 `app-server-control.sock` 的 `lsof` owner 为运行真值；已有 SSH proxy 时裸 `codex app-server daemon restart` 可能挂住，只在空闲时终止真实 socket owner 并等待重连。
7. `thread_turns.status=inProgress` 可能跨 App Server 重启永久残留，禁止直接统计全部非终态。只保护当前 socket owner 生命周期内启动的 Turn，或在新进程启动后写入新 `thread_items` 的恢复 Turn；新进程前 300 秒保持 fail-closed。
8. 若账号已耗尽但日志连续 `busy`，先对比非终态 Turn 的 `started_at`、最新 item 时间与当前 socket owner 启动时间；确认是旧投影后修 Guard 判定，不要改写或删除历史 SQLite 行。
9. 验收必须包含两个独立 account ID、两份 usage 成功、`1 → 2 → 1` 双向切换、两槽各一次真实模型调用、socket owner 变化、LaunchAgent 退出码 0、定时轮询能记录 `staleTurnsIgnored` 后继续 evaluation、无敏感日志残留。

完整脚本和回滚步骤见 `4-Assets/SOP/codex-studio-dual-subscription/README.md`。
