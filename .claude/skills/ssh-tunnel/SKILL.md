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

## Codex App 连接 Studio 的前置条件（2026-08-14）

- 删除、重命名或升级 `/Applications/Codex.app`、`/Applications/ChatGPT.app` 前，先检查 LaunchAgent、SSH remote 配置与 `app-server-control.sock` 是否引用 App bundle 内置 CLI；App 能启动 GUI 不代表远端 shell 能发现 `codex`。
- Studio 远程开发必须同时满足 `command -v codex` 可用，以及 `~/.codex/app-server-control/app-server-control.sock` 存在。缺 standalone CLI 会报 `remote-codex-not-found`；只有 SSH 连通或端口监听不能证明 Codex remote 可用。
- 推荐分工：桌面 App 负责官方 remote-control relay；standalone `codex app-server` daemon 只负责 SSH 所需本地 socket，并关闭 remote control。两者同时争抢官方 relay 会出现 `409 Remote app server already online`。
- 安装或恢复 standalone CLI 后，验收顺序固定为：真实 SSH 登录、`codex --version`、daemon running、socket 存在、Air App 日志出现 `nextState=connected`，最后确认项目 UI 绿点。
- Studio GUI 代理环境应由受控 LaunchAgent 注入，本机代理地址与 CPA 域名 `NO_PROXY` 同时保留；不得把代理凭据写入 Skill、Git 或共享记忆。

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
