# Codex 连接 Studio 的 SSH 配置

用途：给 Codex App 的“添加 SSH 连接”界面填写 Studio 远程开发机连接信息。

## 推荐填写：通过本地隧道连接

当前 Codex App 的 SSH 表单没有 ProxyJump 字段；如果直接填 `studio-dev` 失败，使用本地隧道入口。

| 字段 | 填写内容 |
|---|---|
| 显示名称 | Studio Dev |
| 主机名 | fu-121@127.0.0.1 |
| SSH 端口 | 22277 |
| 身份验证 | 身份文件 |
| 身份文件路径 | /Users/rayman.chen/.ssh/id_ed25519 |

## 已创建的本地隧道文件

文件：`/Users/rayman.chen/Library/LaunchAgents/com.mycc.studio-ssh-tunnel.plist`

作用：在 Air 本机监听 `127.0.0.1:22277`，通过公网跳板 `mini-pub` 转发到 Studio 的 `192.168.61.177:22`。

链路：

```text
Codex App -> 127.0.0.1:22277 -> mini-pub -> Studio 192.168.61.177:22
```

## 隧道管理命令

查看：

```bash
launchctl print gui/$(id -u)/com.mycc.studio-ssh-tunnel
lsof -nP -iTCP:22277 -sTCP:LISTEN
```

重启：

```bash
launchctl kickstart -k gui/$(id -u)/com.mycc.studio-ssh-tunnel
```

停止：

```bash
launchctl bootout gui/$(id -u) /Users/rayman.chen/Library/LaunchAgents/com.mycc.studio-ssh-tunnel.plist
```

## 快速验证命令

```bash
ssh -p 22277 -i /Users/rayman.chen/.ssh/id_ed25519 -o IdentitiesOnly=yes fu-121@127.0.0.1 'hostname; whoami; pwd'
```

## 原始 SSH Config 依赖

本地隧道依赖 `/Users/rayman.chen/.ssh/config` 中的 `mini-pub`：

```sshconfig
Host mini-pub
    HostName cli4.hahaxiong.cc
    Port 22022
    User rayman.chen
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```
