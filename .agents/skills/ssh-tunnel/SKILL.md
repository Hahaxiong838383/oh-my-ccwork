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

## Codex App 连接 Studio：本地端口隧道

当 Codex App 的“添加 SSH 连接”表单只有主机、端口和身份文件字段时，不要假设它会完整读取 `~/.ssh/config` 的 `ProxyJump`。如果 `ssh studio-dev` 在终端成功、但 App 填 `studio-dev` 显示“SSH 连接失败”，优先使用本地端口隧道把跳板链路折叠成普通 SSH 入口。

已验证可用配置：

```text
Codex App
  -> 127.0.0.1:22277
  -> Air LaunchAgent: com.mycc.studio-ssh-tunnel
  -> mini-pub / cli4.hahaxiong.cc:22022
  -> Studio 192.168.61.177:22
```

Codex App 表单填写：

```text
显示名称：Studio Dev
主机名：fu-121@127.0.0.1
SSH 端口：22277
身份验证：身份文件
身份文件路径：/Users/rayman.chen/.ssh/id_ed25519
```

Air 上的持久隧道文件：

```text
/Users/rayman.chen/Library/LaunchAgents/com.mycc.studio-ssh-tunnel.plist
```

核心转发命令等价于：

```bash
ssh -N \
  -L 127.0.0.1:22277:192.168.61.177:22 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o IdentitiesOnly=yes \
  -i /Users/rayman.chen/.ssh/id_ed25519 \
  mini-pub
```

验收必须跑真实 SSH，而不是只看端口监听：

```bash
launchctl print gui/$(id -u)/com.mycc.studio-ssh-tunnel
lsof -nP -iTCP:22277 -sTCP:LISTEN
ssh -p 22277 -i /Users/rayman.chen/.ssh/id_ed25519 -o IdentitiesOnly=yes fu-121@127.0.0.1 'hostname; whoami; pwd'
```

公网可用前提：Air 能访问 `cli4.hahaxiong.cc:22022`，Mini 在线且 `mini-pub` 正常，Studio 在线且 Mini 可达 `192.168.61.177:22`，Air 本地 LaunchAgent 隧道正在运行。不要把私钥内容复制进 App、Skill、Git 或记忆；只引用路径。

相关说明文件：`/Users/rayman.chen/mycc/4-Assets/SOP/codex-studio-ssh-connection.md`。

### Codex-managed SSH 的 CLI 与 socket 前置条件（2026-08-14）

- 删除、重命名或升级 `/Applications/Codex.app`、`/Applications/ChatGPT.app` 前，先检查 LaunchAgent、SSH remote 配置与 `app-server-control.sock` 是否引用 App bundle 内置 CLI；App 能启动 GUI 不代表远端 shell 能发现 `codex`。
- Studio 远程开发必须同时满足 `command -v codex` 可用，以及 `~/.codex/app-server-control/app-server-control.sock` 存在。缺 standalone CLI 会报 `remote-codex-not-found`；只有 SSH 连通或端口监听不能证明 Codex remote 可用。
- 推荐分工：桌面 App 负责官方 remote-control relay；standalone `codex app-server` daemon 只负责 SSH 所需本地 socket，并关闭 remote control。两者同时争抢官方 relay 会出现 `409 Remote app server already online`。
- 安装或恢复 standalone CLI 后，验收顺序固定为：真实 SSH 登录、`codex --version`、daemon running、socket 存在、Air App 日志出现 `nextState=connected`，最后确认项目 UI 绿点。服务 active、socket 单独存在或 App 能打开都不是完整验收。
- Studio GUI 代理环境应由受控 LaunchAgent 注入，本机代理地址与 CPA 域名 `NO_PROXY` 同时保留；不得把代理凭据写入 Skill、Git 或共享记忆。

### Codex App-to-App 远控失败的边界

如果官方 App-to-App 远控卡在“正在初始化安全连接”并报 `Opening handshake has timed out`，不要直接归因到 Studio 未启动或手机配对丢失。2026-08-11 已验证：Studio App server 在线、手机曾可见/可连，Air 侧 Electron `--proxy-server`、hosts 可信 DNS 接管、Xray 将 `chatgpt.com` / `ws.chatgpt.com` / `ab.chatgpt.com` 临时切到 `DMIT-Gemini-vps-chenchuan` 均未修复，且实验均需自动回退。该问题应与 SSH 本地隧道方案分开处理。

## GEO Dashboard 受限反向 SSH（2026-08-14 已验证）

```text
geo.kidshub.cn:443
  -> aliyun-hk Nginx + 独立认证
  -> aliyun-hk 127.0.0.1:13808
  -> geo-tunnel 受限反向 SSH
  -> company-vm 127.0.0.1:8080/dashboard
```

- aliyun-hk 使用独立 `geo-tunnel` 用户，`authorized_keys` 必须包含 `restrict,port-forwarding,permitlisten="127.0.0.1:13808"`；不得复用 root 运维 Key 或 H/ERP 隧道 Key。
- company-vm 私钥和固定 host key 位于 `/home/futurus/.geo-engine/tunnel/`，权限分别为目录 `0700`、私钥/known_hosts `0600`；不得进入 Git、Skill 或记忆。
- company-vm 由 `/etc/systemd/system/geo-dashboard-tunnel.service` 托管，并 `Requires/After=geo-engine.service`；`ExecStartPre` 必须有限重试 GEO `/health`，不能把 `After` 误当成应用已完成监听。SSH 必须启用 `BatchMode`、`IdentitiesOnly`、`StrictHostKeyChecking`、`ExitOnForwardFailure` 和 keepalive。
- 隧道验收必须同时证明：GEO 与隧道 system service enabled/active、旧 user GEO service disabled/inactive、company-vm 仅 `127.0.0.1:8080` 监听、aliyun-hk 仅 `127.0.0.1:13808` 监听、回环 `/health` 与 `/dashboard` 可读、公网 `13808` 不可达、两项服务同时重启后页面连续多轮恢复。
- Nginx 只能代理精确路径白名单；反向 SSH 安全不等于上游 API 安全，禁止把整个 GEO `8080` 暴露给公网。当前允许认证 GET 运行数据，以及认证 POST `/visibility`、`/audit`、`/articles/update`、`/publish`、`/gen`、`/kb/create`、`/kb/add`、`/fix`、`/visibility/multi`；每个写接口必须单独限制方法、请求体、限流和超时。
- GEO 后续不可变 Release 切换使用项目脚本 `deploy/company-vm/cutover-geo-engine-release.sh <new-sha> <old-sha> <expected-version> [model] [reasoning]`；脚本在 company-vm 以 root 执行，原子切换 `/home/futurus/.geo-engine/current` 与 `current-venv`，轮询 `/health`，校验目标版本/模型/推理等级，失败恢复旧 Release 后再重建隧道。
- 切换成功不能只看 systemd `active`：还要核对 `/stats`、`/meta`、`/experiments`，再从公网真实浏览器验证 API 动态加载、六个 Tab active、操作页、上海时间、无横向溢出和控制台零错误。当前 `0.4.1` 锚点为 Commit `4cade6c6a459ed3c4c6d6ed615cd7999f7b6b585`。
- zsh 中小写 `path` 是与环境变量 `PATH` 绑定的特殊数组；验收循环不得写 `for path in ...`，否则第一次迭代后可能出现 `curl: command not found`。统一使用 `endpoint`、`route` 或 `target_path`，复杂脚本同时避免只读特殊变量 `status`。
- Nginx 从静态页面升级为动态 API 时，除路由白名单外必须同步修改 CSP 为 `connect-src 'self'`；公网验收同时检查认证 API `200`、浏览器控制台零 CSP 错误和页面真实数据已渲染。
- GEO 写接口共用低速 `geo_operations` 限流时，快速批量探针可能返回 `503`；应串行或冷却后复测。`/publish` 与 `/fix` 可指定输出目录，Basic Auth 必须按高权限运维凭据管理，不能因为隧道受限就降低应用层授权要求。
- 回滚顺序：先下 Nginx 入口，再 stop/disable company-vm 隧道服务，确认 `13808` 消失，最后再移除 `geo-tunnel` 公钥或账号；禁止先删密钥导致残留监听和难以定位的半状态。
