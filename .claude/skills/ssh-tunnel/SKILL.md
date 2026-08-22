---
name: ssh-tunnel
description: 公网 SSH 与反向转发维护指南，覆盖临时 cloudflared Quick Tunnel、受限反向 SSH、持久 FRP 密钥入口，以及 geo.kidshub.cn 的 GEO 回环隧道与 Nginx 精确 API 白名单。适用于远程连接、固定公网域名、公司虚拟机、GEO Engine、远程开发、FRP、SSH 安全入口。
---

# ssh-tunnel

> 一键开启公网 SSH 隧道，让另一台电脑的 Claude Code 远程连接本机调试。

## 触发词

`/ssh-tunnel`、"远程连接"、"SSH 隧道"、"远程调试"、"开 SSH"、"公网 SSH"


<!-- 以下自 .agents 入口副本合并（2026-08-22），原属「## 触发词」 -->
`/ssh-tunnel`、"远程连接"、"SSH 隧道"、"远程调试"、"开 SSH"、"公网 SSH"、"GEO 隧道"、"geo.kidshub.cn"、"GEO Nginx 白名单"
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


<!-- 以下自 .agents 入口副本合并（2026-08-22），原属「## 执行流程」 -->
1. 先读取本项目 `current.json` 的精确 PID，再用 `ps -p <PID> -o command=` 核对它是否属于本项目。
   - PID 与命令均匹配：输出当前 tunnel 信息，不重复启动。
   - PID 不存在或不匹配：只清理本项目的失效状态文件，不处理其他 cloudflared 进程。
   **场景 2：另一台电脑 SSH 连入后启动 Codex**
禁止使用 `pkill -f cloudflared` 或其他宽泛模式作为兜底；同一台机器可能并存多个项目的 tunnel。
## 注意事项

- tunnel 地址是**临时的**，每次启动都会变，重启后需重新获取
- 另一台电脑也需要安装 `cloudflared`（macOS: `brew install cloudflared`，Windows: `winget install cloudflare.cloudflared`）
- 无 SLA 保证（免费 quick tunnel），生产用途建议用 Named Tunnel
- 本机 SSH 必须开启（`sudo systemsetup -setremotelogin on`）


<!-- 以下自 .agents 入口副本合并（2026-08-22），原属「## 注意事项」 -->
- 无 SLA 保证（免费 Quick Tunnel），只允许短时诊断，不作为用户体验、生产或长期入口，也不把 `trycloudflare.com` 地址交付给用户
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
- Claude、Codex、Grok、OMP 共享本机 `~/.ssh/config` 与 `~/.ssh/id_ed25519`；禁止复制私钥或把私钥写进项目。
- 正常项目编辑直接使用 `ssh company-vm`；家目录可写，SFTP 与 TCP 端口转发已启用。
- 系统级变更必须经过明确授权和 `sudo`；密码不得进入 Skill、Git、日志或记忆。

### 生产拓扑与安全边界

```text
本机 SSH key
  -> cli4.hahaxiong.cc:22043
  -> aliyun-hk frps 0.61.1
  -> company VM frpc 0.61.1
  -> 127.0.0.1:2222 独立 sshd
  -> futurus
```

- 公网 sshd：`/etc/ssh/sshd_config_public_tunnel`，只监听 `127.0.0.1:2222`，强制公钥、禁密码、禁 root、仅允许 `futurus`。
- FRP 配置：`/etc/frp/frpc.toml`，权限 `root:frpc 640`；token 只存远端文件，禁止输出或持久化到本机。
- 服务：`sshd-public-tunnel.service`、`frpc.service` 均 enabled；frpc 使用独立低权限用户和 `NoNewPrivileges`。
- 原局域网 `22/tcp` 是回滚入口；公网只开放香港 `TCP 22043`，不得把原密码 SSH 直接暴露公网。

### 必跑验收

```bash
ssh -o BatchMode=yes company-vm 'hostname; id -un; test -w "$HOME"'
ssh company-vm-lan 'sudo systemctl status sshd-public-tunnel frpc --no-pager'
nc -z -w 5 cli4.hahaxiong.cc 22043
printf 'pwd\nquit\n' | sftp -q -b - company-vm
```

必须证明公网密钥成功、密码失败、SFTP 成功、服务重启后恢复、LAN 回滚入口可用；只看服务 active 不算完成。

### 回滚与排障

- 公司机回滚备份：`/var/backups/public-access-20260805-191911`。
- 排查顺序：`company-vm-lan` → 独立 sshd → frpc → aliyun-hk frps → 22043 监听 → 阿里云安全组。
- 公网异常时不得先改原 SSH 22；禁止模糊 `pkill -f`。


<!-- 以下自 .agents 入口副本合并（2026-08-22），原属「## 持久入口：公司 Ubuntu 虚拟机」 -->
- cc、codex、grok、omp 在本机以同一 macOS 用户运行，共享 `~/.ssh/config` 与 `~/.ssh/id_ed25519`，不得为每个引擎复制私钥。
- 正常项目编辑直接使用 `ssh company-vm`；用户家目录可写，SFTP 与 TCP 端口转发已启用。
- 系统级变更仍需明确授权并经过 `sudo`；禁止把 sudo 密码写入 Skill、Git、日志或记忆。
- 公网独立 sshd 配置：`/etc/ssh/sshd_config_public_tunnel`，只监听 `127.0.0.1:2222`。
- 公网入口强制公钥认证，`PasswordAuthentication no`、`PermitRootLogin no`、`AllowUsers futurus`。
- 原局域网 `22/tcp` 保持为回滚入口，不把密码 SSH 直接通过 FRP 暴露公网。
- FRP 配置：`/etc/frp/frpc.toml`，权限 `root:frpc 640`；token 只存远端文件，不读取、不打印、不进入记忆。
- systemd：`sshd-public-tunnel.service` 与 `frpc.service` 均 enabled；frpc 以独立低权限用户运行并启用 `NoNewPrivileges`。
- 香港公网安全组仅放行 `TCP 22043`；公司机 UFW 仍只放行 LAN SSH `22/tcp`，公网 2222 不对网卡监听。
# 公网密钥登录与编辑能力
# 服务与监听
ssh company-vm-lan 'sudo ss -lntp | grep 127.0.0.1:2222'
# 本机端到端入口
验收必须同时证明：公网密钥成功、密码失败、SFTP 成功、服务重启后自动恢复、LAN 回滚入口可用。禁止只看 `frpc active` 或远端端口监听。
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

### Codex App 优先走 studio-mesh，并保留项目聊天（2026-08-16）

EasyTier 正常时，ChatGPT/Codex App 的 Studio managed SSH 优先使用：

```text
显示名称：studio 开发机（保持不变）
主机名：fu-121@10.10.10.12
SSH 端口：22
身份验证：身份文件
身份文件路径：/Users/rayman.chen/.ssh/id_ed25519
```

`~/.ssh/config` 的等价别名为 `studio-mesh`。切换线路时必须遵守：

1. **原地编辑现有 managed connection**，只改 hostname/port；保留 displayName、hostId、remote project id 和项目路径。
2. 不先删除旧连接再新建。SSH 地址不是聊天本体；会话保存在 Studio `~/.codex/sessions`，但新连接若产生不同 hostId，旧项目聊天可能只是在新侧栏不可见。
3. 如果 App 没有编辑按钮，先备份 Air `~/.codex/.codex-global-state.json`，再用定向 JSON 修改仅替换目标 connection 的 `hostname`/`sshPort`；禁止打印、提交或整体复制该状态文件，因为其中可能包含设备状态或敏感运行字段。
4. HK 回滚入口保留为 `fu-121@cli4.hahaxiong.cc:22044`，Mesh 验收完成前不删除。

切换后验收：

```bash
ssh studio-mesh 'hostname; whoami; codex --version; codex app-server daemon version; \
  test -S "$HOME/.codex/app-server-control/app-server-control.sock" && echo SOCKET_OK; \
  test -d /Users/fu-121/mycc && echo MYCC_OK'
```

还必须在 Air 侧确认：selected hostId 未变、原 remote projects 仍指向同一 hostId、原 thread→project assignments 数量未缩水。2026-08-16 实测原地切换后，三个现用项目与四条项目聊天绑定保留，Studio 12 个 rollout 均在。

### Codex-managed SSH 的 CLI 与 socket 前置条件（2026-08-14）

- 删除、重命名或升级 `/Applications/Codex.app`、`/Applications/ChatGPT.app` 前，先检查 LaunchAgent、SSH remote 配置与 `app-server-control.sock` 是否引用 App bundle 内置 CLI；App 能启动 GUI 不代表远端 shell 能发现 `codex`。
- Studio 远程开发必须同时满足 `command -v codex` 可用，以及 `~/.codex/app-server-control/app-server-control.sock` 存在。缺 standalone CLI 会报 `remote-codex-not-found`；只有 SSH 连通或端口监听不能证明 Codex remote 可用。
- 推荐分工：桌面 App 负责官方 remote-control relay；standalone `codex app-server` daemon 只负责 SSH 所需本地 socket，并关闭 remote control。两者同时争抢官方 relay 会出现 `409 Remote app server already online`。
- 安装或恢复 standalone CLI 后，验收顺序固定为：真实 SSH 登录、`codex --version`、daemon running、socket 存在、Air App 日志出现 `nextState=connected`，最后确认项目 UI 绿点。服务 active、socket 单独存在或 App 能打开都不是完整验收。
- Studio GUI 代理环境应由受控 LaunchAgent 注入，本机代理地址与 CPA 域名 `NO_PROXY` 同时保留；不得把代理凭据写入 Skill、Git 或共享记忆。

### Codex App-to-App 远控失败的边界

如果官方 App-to-App 远控卡在“正在初始化安全连接”并报 `Opening handshake has timed out`，不要直接归因到 Studio 未启动或手机配对丢失。2026-08-11 已验证：Studio App server 在线、手机曾可见/可连，Air 侧 Electron `--proxy-server`、hosts 可信 DNS 接管、Xray 将 `chatgpt.com` / `ws.chatgpt.com` / `ab.chatgpt.com` 临时切到 `DMIT-Gemini-vps-chenchuan` 均未修复，且实验均需自动回退。该问题应与 SSH 本地隧道方案分开处理。

### Codex-managed SSH 上传与慢响应分层（2026-08-14）

远程窗口“上传中”“点击发送一直转圈”“已经收到内容但明显很慢”不是同一个故障。禁止只凭转圈重启 App Server、SSH 或代理，先按四层取证：

1. **控制面**：测 `thread/read`、`thread/turns/list` 和 `fs/createDirectory`/上传 RPC。控制面几十秒才返回，优先查共享队列与历史会话体积。
2. **模型到站**：查 Studio `~/.codex/logs_2.sqlite` 中该 Turn 的 `/v1/responses status=200`、首条 reasoning/assistant event 和错误；未到 `200` 才继续查 Studio 出站、Xray、CPA/Nginx。
3. **Turn 生命周期**：用 App Server 协议读最新 Turn，明确区分 `inProgress` 与 `completed`。看到 reasoning 流不代表任务已经结束；转圈可能只是高推理或工具执行仍在继续。
4. **执行负载**：统计模型轮次、上下文 token、工具调用次数和单次工具耗时。控制面毫秒级、Provider 已 `200` 且无流错误时，慢点通常在任务本身，不在 SSH。

2026-08-14 Studio 实例：旧任务 rollout 约 `16.9 MB`、含 530 条用户/助手/开发者消息，导致同一远端队列中的 `thread/turns/list` 约 `50–55s`、`fs/createDirectory` 约 `47.5s`，8 KB 文件实际已写入但完成回调超时。处理时必须先完整备份，再只删除工具输出、推理明细和重复 metadata 等内部冗余，保留全部可见消息与 context compacted 摘要；压缩到约 `2.04 MB` 后，`thread/read` 恢复到 `126–179ms`、`thread/turns/list` 恢复到 `241–453ms`，上传完成提示恢复。

同一窗口后续发送复杂分析时，Studio → Smart API TLS/401 探针仅 `0.20–0.25s`，Air → Studio SSH 建连约 `1.1–1.6s`，模型请求约 `8s` 返回 SSE `HTTP 200`，但 `gpt-5.6-sol + high` 因多轮模型和最长约 `30s` 的工具调用，超过 `278s` 仍为 `inProgress`。这属于任务执行慢，不需要重启；要提速应新建任务、重新附文件并降到 `medium`，不要继续在超长历史线程中追加。

验收结论必须分别写清：上传是否落盘、控制面延迟、Provider 是否到站、Turn 是否完成。四项不能互相替代。

## Codex App 连接 Studio 的前置条件（2026-08-14）

- 删除、重命名或升级 `/Applications/Codex.app`、`/Applications/ChatGPT.app` 前，先检查 LaunchAgent、SSH remote 配置与 `app-server-control.sock` 是否引用 App bundle 内置 CLI；App 能启动 GUI 不代表远端 shell 能发现 `codex`。
- Studio 远程开发必须同时满足 `command -v codex` 可用，以及 `~/.codex/app-server-control/app-server-control.sock` 存在。缺 standalone CLI 会报 `remote-codex-not-found`；只有 SSH 连通或端口监听不能证明 Codex remote 可用。
- 推荐分工：桌面 App 负责官方 remote-control relay；standalone `codex app-server` daemon 只负责 SSH 所需本地 socket，并关闭 remote control。两者同时争抢官方 relay 会出现 `409 Remote app server already online`。
- 安装或恢复 standalone CLI 后，验收顺序固定为：真实 SSH 登录、`codex --version`、daemon running、socket 存在、Air App 日志出现 `nextState=connected`，最后确认项目 UI 绿点。
- Studio GUI 代理环境应由受控 LaunchAgent 注入，本机代理地址与 CPA 域名 `NO_PROXY` 同时保留；不得把代理凭据写入 Skill、Git 或共享记忆。

### 切到 studio-mesh 时保留项目与聊天（2026-08-16）

- EasyTier 正常时，App 现有 `studio 开发机` 连接原地改为 `fu-121@10.10.10.12:22`，身份文件保持 `/Users/rayman.chen/.ssh/id_ed25519`；HK `cli4.hahaxiong.cc:22044` 只作回滚。
- 必须原地编辑，只改 hostname/port，保留 displayName、hostId、remote project id 和项目路径；禁止先删旧连接再新建。
- 会话本体在 Studio `~/.codex/sessions`。新建连接若产生不同 hostId，旧聊天通常未删除，但可能不出现在新连接侧栏。
- App 没有编辑按钮时，先备份 Air `~/.codex/.codex-global-state.json`，再定向修改目标 connection；禁止输出或提交完整状态文件。
- 验收同时检查真实 `ssh studio-mesh`、`codex app-server daemon version`、control socket、selected hostId、remote projects 与 thread→project assignments。2026-08-16 原地切换实测保留三个现用项目、四条项目聊天绑定和 Studio 12 个 rollout。

## Codex-managed SSH 上传与慢响应分层（2026-08-14）

远程窗口“上传中”“点击发送一直转圈”“已经收到内容但明显很慢”必须分开诊断，禁止只凭 UI 转圈重启 App Server、SSH 或代理：

1. 测 `thread/read`、`thread/turns/list` 与 `fs/createDirectory`/上传 RPC；控制面几十秒才返回时先查共享队列和历史会话体积。
2. 查 Studio `~/.codex/logs_2.sqlite` 中该 Turn 的 `/v1/responses status=200`、首条流事件和错误；没有 `200` 才查 Studio 出站、Xray、CPA/Nginx。
3. 通过 App Server 协议确认 Turn 是 `inProgress` 还是 `completed`；收到 reasoning/assistant 流不等于任务已完成。
4. 统计模型轮次、上下文 token、工具次数和工具耗时；控制面毫秒级且 Provider 已 `200` 时，慢点通常在任务本身。

2026-08-14 Studio 实例：约 `16.9 MB`、530 条可见消息的旧 rollout 让 `thread/turns/list` 延迟约 `50–55s`、`fs/createDirectory` 约 `47.5s`，8 KB 文件实际落盘但完成回调超时。先完整备份，再只移除工具输出、推理明细和重复 metadata，保留全部用户/助手/开发者消息与 context compacted 摘要；压缩到约 `2.04 MB` 后，`thread/read` 恢复到 `126–179ms`、`thread/turns/list` 恢复到 `241–453ms`。

后续复杂任务中，Studio → Smart API TLS 探针仅 `0.20–0.25s`、Air → Studio SSH 建连约 `1.1–1.6s`、模型请求约 `8s` 返回 SSE `HTTP 200`，但 `gpt-5.6-sol + high` 因多轮模型与最长约 `30s` 的工具调用，超过 `278s` 仍为 `inProgress`。这属于执行慢，不需要重启；要提速应新建任务、重新附文件并降到 `medium`。

验收必须分别报告：上传是否落盘、控制面延迟、Provider 是否到站、Turn 是否完成。

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
- company-vm 由 `/etc/systemd/system/geo-dashboard-tunnel.service` 托管，`ExecStartPre` 先检查 GEO `/health`，SSH 必须启用 `BatchMode`、`IdentitiesOnly`、`StrictHostKeyChecking`、`ExitOnForwardFailure` 和 keepalive。
- 隧道验收必须同时证明：company-vm service active、aliyun-hk 仅 `127.0.0.1:13808` 监听、回环 `/health` 与 `/dashboard` 可读、公网 `13808` 不可达、服务重启后页面连续多轮恢复。
- Nginx 只能代理精确只读页面；反向 SSH 安全不等于上游 API 安全，禁止把整个 GEO `8080` 暴露给公网。
- 回滚顺序：先下 Nginx 入口，再 stop/disable company-vm 隧道服务，确认 `13808` 消失，最后再移除 `geo-tunnel` 公钥或账号；禁止先删密钥导致残留监听和难以定位的半状态。

<!-- 以下自 .agents 入口副本合并（2026-08-22），原属「## GEO Dashboard 受限反向 SSH（2026-08-14 已验证）」 -->
- company-vm 由 `/etc/systemd/system/geo-dashboard-tunnel.service` 托管，并 `Requires/After=geo-engine.service`；`ExecStartPre` 必须有限重试 GEO `/health`，不能把 `After` 误当成应用已完成监听。SSH 必须启用 `BatchMode`、`IdentitiesOnly`、`StrictHostKeyChecking`、`ExitOnForwardFailure` 和 keepalive。
- 隧道验收必须同时证明：GEO 与隧道 system service enabled/active、旧 user GEO service disabled/inactive、company-vm 仅 `127.0.0.1:8080` 监听、aliyun-hk 仅 `127.0.0.1:13808` 监听、回环 `/health` 与 `/dashboard` 可读、公网 `13808` 不可达、两项服务同时重启后页面连续多轮恢复。
- 反向 SSH 安全不等于上游 API 安全。当前 Nginx 使用 Basic Auth 后的 `location /` fallback，让后端新增顶层接口无需再次修改 Nginx；已知高风险写接口继续使用 exact location 保留独立方法、请求体、限流和超时。`/articles/`、`/kb/` 必须同时配置数字详情 regex 和命名空间 guard，防止宽松后端前缀解析导致 `502` 或路径别名穿透。
- GEO 后续不可变 Release 切换使用项目脚本 `deploy/company-vm/cutover-geo-engine-release.sh <new-sha> <old-sha> <expected-version> [model] [reasoning]`；脚本在 company-vm 以 root 执行，原子切换 `/home/futurus/.geo-engine/current` 与 `current-venv`，轮询 `/health`，校验目标版本/模型/推理等级，失败恢复旧 Release 后再重建隧道。
- 切换成功不能只看 systemd `active`：还要核对 `/stats`、`/meta`、`/experiments`，再从公网验证 API 动态加载、七个 Tab、关键词库、内容生成表单、操作页、公开文章和机器发现文件。当前 `0.4.2` 锚点为 Commit `ec249ed0c7d7a45b8b8b8ea7e3b9fabf42036bf1`；真实浏览器仍是布局与控制台门禁，驱动因本机 OS 不兼容时只能记录验证缺口，不能把 HTTP/DOM 代称为浏览器通过。
- zsh 中小写 `path` 是与环境变量 `PATH` 绑定的特殊数组；验收循环不得写 `for path in ...`，否则第一次迭代后可能出现 `curl: command not found`。统一使用 `endpoint`、`route` 或 `target_path`，复杂脚本同时避免只读特殊变量 `status`。
- Nginx 从静态页面升级为动态 API 时，除路由白名单外必须同步修改 CSP 为 `connect-src 'self'`；公网验收同时检查认证 API `200`、浏览器控制台零 CSP 错误和页面真实数据已渲染。
- exact location 优先级高于 fallback，不会随机命中。六个工作流 POST 使用 `geo_dashboard 120r/m burst=30`，避免跨接口共享 `geo_operations` 低速令牌导致间歇 `503`；只有 `/visibility`、`/audit`、`/fix` 保留 `6r/m burst=2`。`/publish` 与 `/fix` 可指定输出目录，Basic Auth 必须按高权限运维凭据管理。
- 公开内容使用无认证 `/published/<file>`，但只允许 GET/HEAD、发布目录根层安全扩展并拒绝路径穿越；根 `/robots.txt`、`/llms.txt`、`/schema.jsonld`、`/sitemap.xml` 通过命名捕获代理。禁止在 regex location 用 `$1` 同时执行其他正则 `if`，否则捕获值会被覆盖；必须用命名变量并逐个验 `200`。
- 公开目录只允许数据库交付账本、静态首页和机器结构文件。部署中发现的孤儿文章先归档再下线；canonical、Open Graph、JSON-LD、sitemap、llms 与数据库交付 URL 必须统一，且逐篇真实公网返回 `200` 才能宣称发布成功。
