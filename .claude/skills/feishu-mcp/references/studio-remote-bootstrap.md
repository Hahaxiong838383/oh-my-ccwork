# Studio/远程开发机飞书能力同步 SOP

> 适用于“让 Studio/新 Mac 拥有与 Air 一样的飞书读写能力”“让远程 ChatGPT/Codex 自主调用飞书”等任务。

## 目标与边界

- 先确认 Air 的真实接线，再复制能力；不要看到“飞书”就自行新增 `mcp_servers.feishu`。
- 当前已验证架构可能是 `lark-cli + lark-* Skills + User OAuth/Keychain`，也可能是独立 MCP；必须现场盘点。
- 凭据不得打印、写入命令参数、Git、记忆、普通日志或明文临时文件。
- 不轮换、不撤销现有长期凭据；User OAuth 在目标机独立授权。
- 飞书域名国内直连，不经过境外 Xray 节点。

## 1. 只读盘点 Air 与目标机

分别检查：

```bash
command -v lark-cli
lark-cli --version
lark-cli auth status
find ~/.lark-cli -maxdepth 3 -type f -exec stat -f '%Sp %Su:%Sg %z %N' {} \;
find ~/mycc/.agents/skills ~/.codex/skills -maxdepth 1 -type d -o -type l
```

只输出配置键名、文件权限和安全字段，不输出 App Secret、access token、refresh token、device code。检查 `~/.codex/config.toml` 的真实 MCP 配置，禁止根据旧经验猜接线。

## 2. 同步 CLI 与 Skills

- 优先保持 Air/目标机版本一致，先完成能力对齐，再单独决定是否双机同步升级。
- `lark-cli` 放入目标机稳定 PATH，例如 `~/.local/bin/lark-cli`；ChatGPT managed app-server 的 PATH 也必须可发现它。
- 同步全部 `lark-*` 与 `feishu-mcp` Skills，并在 `~/.codex/skills/` 建立全局入口，确保不只在 `~/mycc` 工作区可触发。
- 工具和 Skills 可通过 Git、固定包或 SSH 流同步；不要把 `node_modules`、运行日志和缓存误提交到仓库。

## 3. 安全迁移应用配置

只传应用配置和 App Secret，不复制 Air 的 User OAuth token：

```bash
tar -C ~/.lark-cli -cf - config.json .app-secret \
  | ssh <target> 'umask 077; mkdir -p ~/.lark-cli; tar -C ~/.lark-cli -xf -; chmod 700 ~/.lark-cli; chmod 600 ~/.lark-cli/config.json ~/.lark-cli/.app-secret'
```

跨 macOS 用户后必须检查 `config.json` 的 `apps[].appSecret.id`。它通常是 Air 的绝对路径，需原子改成目标用户的 `~/.lark-cli/.app-secret`，否则 `doctor` 会报找不到 Air 用户目录下的 secret 文件。

## 4. 目标机独立 User OAuth

推荐 device flow：

```bash
lark-cli auth login --recommend --no-wait --json
```

返回的授权地址必须是 `https://accounts.feishu.cn/oauth/v1/device/verify`，且 URL 包含 `flow_id` 与 `user_code`。

**关键坑**：`--no-wait` 只创建 flow，不会兑换或保存 token。必须保留同一响应里的 `device_code`，并在用户完成网页授权时继续执行：

```bash
lark-cli auth login --device-code '<short-lived-device-code>' --json
```

`auth status` 轮询不能替代这一步。`device_code` 是短效敏感信息，只保存在当前进程内存，完成后立即丢弃。

## 5. 飞书直连环境

Shell、ChatGPT GUI 与 managed app-server 都要具备：

```bash
export LARK_CLI_NO_PROXY=1
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}.feishu.cn,.feishucdn.com,open.feishu.cn,accounts.feishu.cn"
export no_proxy="$NO_PROXY"
```

- Shell 配置写入目标用户登录环境。
- GUI 通过用户 LaunchAgent/`launchctl setenv` 注入。
- 重启 ChatGPT 后检查进程环境；managed app-server 可能仍是旧进程，使用官方命令：

```bash
codex app-server daemon restart
```

保持职责隔离：桌面 App 负责官方 remote-control relay；standalone managed daemon 只提供 SSH app-server socket，remote control 保持关闭，避免 `HTTP 409`。

## 6. OAuth 自动续期

如果 refresh window 只有数天，为目标机建立 12 小时一次的只读调用：

```bash
lark-cli contact +get-user --as user --format json >/dev/null
```

使用用户 LaunchAgent，飞书直连，stdout/stderr 丢弃；验证 `last exit code = 0`。不要用写操作做保活。

## 7. 三层真实验收

### A. 认证与只读

```bash
lark-cli auth status
lark-cli contact +get-user --as user --format json
```

要求：`identity=user`、token 有效、当前用户正确。

### B. 真实写入与回读

在用户自有空间创建无害验收文档，写入唯一标记，再用 `docs +fetch` 回读确认。不要向其他人发消息，不要把“创建成功”当作回读成功。

### C. ChatGPT/Codex 自主调用

启动一个新的 Studio Codex 任务，只给目标，不直接指定命令；要求它先读取飞书 Skill，再自主读取当前用户。检查事件证据应包含：

- 读取 `lark-contact`/`lark-shared` 的 `SKILL.md`；
- 执行 `lark-cli contact +get-user --as user`；
- 返回预设成功标记。

CLI 人工调用成功不等于 ChatGPT 能自主选 Skill；三层必须同时通过。

## 8. 回滚与交付

- 修改 Shell、LaunchAgent、Codex 环境前创建带时间戳备份。
- 同步失败时恢复原文件并重启对应 GUI/daemon；不得影响现有代理和远程 SSH。
- 最终报告 CLI 版本、Skill 数量、OAuth 身份、直连环境、daemon 状态、读写验收、自主调用证据和未触碰的并发工作树。
