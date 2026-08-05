---
name: ssh-tunnel
description: 公网 SSH 隧道维护指南，覆盖临时 cloudflared Quick Tunnel 与持久 FRP 密钥入口。适用于远程连接、公司虚拟机、远程开发、FRP、SSH 安全入口。
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
