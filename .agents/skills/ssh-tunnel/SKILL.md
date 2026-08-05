---
name: ssh-tunnel
description: 公网 SSH 与反向转发维护指南，覆盖临时 cloudflared Quick Tunnel、受限反向 SSH 与持久 FRP 密钥入口。适用于远程连接、固定公网域名、公司虚拟机、远程开发、FRP、SSH 安全入口。
---

# ssh-tunnel

> 一键开启公网 SSH 隧道，让另一台电脑的 Codex 远程连接本机调试。

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

1. 先读取本项目 `current.json` 的精确 PID，再用 `ps -p <PID> -o command=` 核对它是否属于本项目。
   - PID 与命令均匹配：输出当前 tunnel 信息，不重复启动。
   - PID 不存在或不匹配：只清理本项目的失效状态文件，不处理其他 cloudflared 进程。

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

5. 将连接信息写入 `/Users/rayman.chen/mycc/.Codex/skills/ssh-tunnel/current.json`：
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

   **场景 2：另一台电脑 SSH 连入后启动 Codex**
   ```bash
   ssh -o ProxyCommand="cloudflared access ssh --hostname {TUNNEL_URL}" rayman.chen@{TUNNEL_URL} -t "cd ~/mycc && Codex"
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
   ssh mac-remote -t "cd ~/mycc && Codex"
   ```

### 关闭隧道（stop）

```bash
# 读取 current.json 获取 PID
kill {PID}
# 清理 current.json
rm current.json
```

禁止使用 `pkill -f cloudflared` 或其他宽泛模式作为兜底；同一台机器可能并存多个项目的 tunnel。

### 查看状态（status）

```bash
pgrep -f "cloudflared tunnel" && echo "运行中" || echo "未运行"
# 如果运行中，读取 current.json 输出连接信息
```

## 注意事项

- tunnel 地址是**临时的**，每次启动都会变，重启后需重新获取
- 另一台电脑也需要安装 `cloudflared`（macOS: `brew install cloudflared`，Windows: `winget install cloudflare.cloudflared`）
- 无 SLA 保证（免费 Quick Tunnel），只允许短时诊断，不作为用户体验、生产或长期入口，也不把 `trycloudflare.com` 地址交付给用户
- 本机 SSH 必须开启（`sudo systemsetup -setremotelogin on`）

## 固定 Web 入口：受限反向 SSH

适合内网主机没有可入站公网 IPv4/IPv6，但能主动连接公网 VPS 的场景：

```text
浏览器
  → 固定域名 HTTPS
  → 公网 VPS Nginx/Caddy
  → VPS 回环端口
  → 内网主机主动建立的受限反向 SSH
  → 本机 Web 服务
```

安全要求：

- VPS 的反向转发端口只监听 `127.0.0.1`，不直接公开。
- 使用项目独立密钥；`authorized_keys` 限制 shell、PTY、agent/X11 forwarding，只允许指定 `permitlisten`。
- 用户公网入口和管理员 SSH 运维入口分离，不能因为网页可访问就宣称远程维护已打通。
- Web 服务和数据库不直接暴露公网，公网只开放反向代理的 443。
- launchd/systemd 负责重启恢复；检查进程时记录 PID/runs，连续观察不能只看瞬时 active。

验收至少包含：DNS、TLS、VPS 本机回源、独立公网访问、登录后真实业务页面、两个网络连续多轮请求、转发进程无重启抖动。

KidsHub Growth Insight 的已验证模式：`insight.kidshub.cn` → aliyun-hk Nginx → 回环 13200 → Studio 受限反向 SSH → Next.js 3200。Error 1016/1033 属于 Cloudflare/DNS/隧道层，不应在应用或数据库层盲改。

## 持久入口：公司 Ubuntu 虚拟机

### 连接方式

```bash
ssh company-vm       # 公网：cli4.hahaxiong.cc:22043
ssh company-vm-lan   # 公司局域网：10.2.2.43:22
```

- 目标用户：`futurus`；主机名：`ubt2404`。
- cc、codex、grok、omp 在本机以同一 macOS 用户运行，共享 `~/.ssh/config` 与 `~/.ssh/id_ed25519`，不得为每个引擎复制私钥。
- 正常项目编辑直接使用 `ssh company-vm`；用户家目录可写，SFTP 与 TCP 端口转发已启用。
- 系统级变更仍需明确授权并经过 `sudo`；禁止把 sudo 密码写入 Skill、Git、日志或记忆。

### 生产拓扑与安全边界

```text
本机 SSH key
  -> cli4.hahaxiong.cc:22043
  -> aliyun-hk frps 0.61.1
  -> company VM frpc 0.61.1
  -> 127.0.0.1:2222 独立 sshd
  -> futurus
```

- 公网独立 sshd 配置：`/etc/ssh/sshd_config_public_tunnel`，只监听 `127.0.0.1:2222`。
- 公网入口强制公钥认证，`PasswordAuthentication no`、`PermitRootLogin no`、`AllowUsers futurus`。
- 原局域网 `22/tcp` 保持为回滚入口，不把密码 SSH 直接通过 FRP 暴露公网。
- FRP 配置：`/etc/frp/frpc.toml`，权限 `root:frpc 640`；token 只存远端文件，不读取、不打印、不进入记忆。
- systemd：`sshd-public-tunnel.service` 与 `frpc.service` 均 enabled；frpc 以独立低权限用户运行并启用 `NoNewPrivileges`。
- 香港公网安全组仅放行 `TCP 22043`；公司机 UFW 仍只放行 LAN SSH `22/tcp`，公网 2222 不对网卡监听。

### 必跑验收

```bash
# 公网密钥登录与编辑能力
ssh -o BatchMode=yes company-vm 'hostname; id -un; test -w "$HOME"'

# 服务与监听
ssh company-vm-lan 'sudo systemctl status sshd-public-tunnel frpc --no-pager'
ssh company-vm-lan 'sudo ss -lntp | grep 127.0.0.1:2222'

# 本机端到端入口
nc -z -w 5 cli4.hahaxiong.cc 22043
printf 'pwd\nquit\n' | sftp -q -b - company-vm
```

验收必须同时证明：公网密钥成功、密码失败、SFTP 成功、服务重启后自动恢复、LAN 回滚入口可用。禁止只看 `frpc active` 或远端端口监听。

### 回滚与排障

- 公司机回滚备份：`/var/backups/public-access-20260805-191911`。
- 公网不通时按顺序检查：`ssh company-vm-lan` → `sshd-public-tunnel` → `frpc` → `aliyun-hk frps` → 香港 `22043` 监听 → 阿里云安全组。
- 不要因公网入口异常修改原 SSH 22；先保住 `company-vm-lan` 回滚链。
- 进程清理禁止模糊 `pkill -f`；使用 `pgrep` 获取精确 PID 后处理。
