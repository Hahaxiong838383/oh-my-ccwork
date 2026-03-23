# ssh-tunnel

> 一键开启公网 SSH 隧道，让另一台电脑的 Claude Code 远程连接本机调试。

## 触发词

`/ssh-tunnel`、"远程连接"、"SSH 隧道"、"远程调试"、"开 SSH"、"公网 SSH"

## 使用方法

```
/ssh-tunnel          # 启动隧道，输出连接指令
/ssh-tunnel stop     # 关闭隧道
/ssh-tunnel status   # 查看隧道状态
```

## 执行流程

### 启动隧道（默认）

1. 检查是否已有 cloudflared tunnel 进程在跑（`pgrep -f "cloudflared tunnel"`）
   - 有：输出当前 tunnel 信息，不重复启动
   - 没有：启动新 tunnel

2. 确认前置条件：
   ```bash
   # SSH 服务开启
   systemsetup -getremotelogin
   # cloudflared 已安装
   which cloudflared
   ```

3. 启动 tunnel：
   ```bash
   cloudflared tunnel --url ssh://localhost:22 2>&1 &
   ```

4. 等待 10 秒，从输出中提取 `trycloudflare.com` 地址

5. 将连接信息写入 `/Users/rayman.chen/mycc/.claude/skills/ssh-tunnel/current.json`：
   ```json
   {
     "tunnelUrl": "xxx.trycloudflare.com",
     "pid": 12345,
     "startedAt": "2026-03-22T00:50:00Z",
     "user": "rayman.chen"
   }
   ```

6. 输出给用户的连接指令（三种场景）：

   **场景 1：另一台电脑 SSH 连接**
   ```bash
   ssh -o ProxyCommand="cloudflared access ssh --hostname {TUNNEL_URL}" rayman.chen@{TUNNEL_URL}
   ```

   **场景 2：另一台电脑 SSH 连入后启动 Claude Code**
   ```bash
   ssh -o ProxyCommand="cloudflared access ssh --hostname {TUNNEL_URL}" rayman.chen@{TUNNEL_URL} -t "cd ~/mycc && claude"
   ```

   **场景 3：配置 SSH config 后一键连接**
   ```
   # 添加到 ~/.ssh/config
   Host mac-remote
       HostName {TUNNEL_URL}
       User rayman.chen
       ProxyCommand cloudflared access ssh --hostname %h

   # 然后直接
   ssh mac-remote
   # 或
   ssh mac-remote -t "cd ~/mycc && claude"
   ```

### 关闭隧道（stop）

```bash
# 读取 current.json 获取 PID
kill {PID}
# 或兜底
pkill -f "cloudflared tunnel --url ssh"
# 清理 current.json
rm current.json
```

### 查看状态（status）

```bash
pgrep -f "cloudflared tunnel" && echo "运行中" || echo "未运行"
# 如果运行中，读取 current.json 输出连接信息
```

## 注意事项

- tunnel 地址是**临时的**，每次启动都会变，重启后需重新获取
- 另一台电脑也需要安装 `cloudflared`（macOS: `brew install cloudflared`，Windows: `winget install cloudflare.cloudflared`）
- 无 SLA 保证（免费 quick tunnel），生产用途建议用 Named Tunnel
- 本机 SSH 必须开启（`sudo systemsetup -setremotelogin on`）
