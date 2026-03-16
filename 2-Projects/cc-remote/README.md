# cc-remote 部署指南

> 在任何 Mac/Linux 上远程访问 Claude Code、Codex、Gemini CLI

## 前置要求

- macOS 或 Linux
- [Homebrew](https://brew.sh)（macOS）
- 至少安装一个 CLI：claude / codex / gemini
- Cloudflare 账号（免费，用于公网穿透）

## 一、安装依赖

```bash
brew install ttyd caddy cloudflared tmux
```

## 二、拉取代码

```bash
git clone https://github.com/Hahaxiong838383/mycc.git
cd mycc/2-Projects/cc-remote
```

## 三、创建 Cloudflare Named Tunnel

1. 登录 [Cloudflare Dashboard](https://one.dash.cloudflare.com/) → Zero Trust → Networks → Tunnels
2. 点 "Create a tunnel" → 输入名称（如 `my-cc-remote`）
3. 选择 "Cloudflared" → 复制 Tunnel Token
4. 配置 Public Hostname：
   - Subdomain: `cli`（或你喜欢的）
   - Domain: 你的域名
   - Service: `http://localhost:8443`

## 四、配置

### 1. 修改 start.sh 中的配置

```bash
# 编辑 start.sh，修改以下变量：
PASSWORD="你的登录密码"
CF_TUNNEL_TOKEN="你的 Tunnel Token"
PROJECT_DIR="你的工作目录"  # CLI 的工作目录
```

### 2. 修改 Caddyfile

将 `HASH_PLACEHOLDER` 保持不变（start.sh 会自动生成）。

如果不需要 mycc 后端共存，删掉 Caddyfile 中的 mycc 相关路由（`/health`、`/mycc/*`、兜底的 `handle /*`）。

### 3. 修改 devices.json

```json
[
  {
    "id": "macbook",
    "name": "MacBook",
    "host": "cli.你的域名.com",
    "active": true
  }
]
```

## 五、启动

```bash
chmod +x start.sh stop.sh ttyd-wrapper.sh watchdog.sh install-daemon.sh logrotate.sh
./start.sh
```

看到 `cc-remote 就绪` 就成功了。

## 六、验证

浏览器打开 `https://cli.你的域名.com/`，输入用户名 `admin` 和你设的密码。

## 七、开机自启（可选）

```bash
# 编辑 cc-remote.plist，修改路径为你的实际路径
# 然后：
./install-daemon.sh
```

## 网络注意事项

**如果你用 V2RayN / Clash 等代理软件**：
- 必须**关闭 TUN 模式**（TUN 会劫持 UDP，导致 cloudflared 连不上）
- 仅使用系统代理模式即可
- cloudflared 的 start.sh 已内置代理绕过（`HTTPS_PROXY=""`）

## 文件说明

| 文件 | 作用 |
|------|------|
| `start.sh` | 一键启动所有服务 |
| `stop.sh` | 停止服务（保留 tmux session） |
| `stop.sh --kill-sessions` | 完全停止（包括 CLI 进程） |
| `Caddyfile` | 反代 + 认证配置 |
| `api.py` | 按键注入 + Session 管理 API |
| `ttyd-wrapper.sh` | ttyd 终端主题配置 |
| `watchdog.sh` | 进程守护（30s 检查一次） |
| `panel/index.html` | Web 管理面板 |
| `devices.json` | 设备列表配置 |

## 常用命令

```bash
# 查看 tmux session
tmux ls

# 手动连接某个 CLI
tmux attach -t cc-claude

# 查看日志
tail -f /tmp/cc-remote.log

# 查看 watchdog 状态
ps aux | grep watchdog
```
