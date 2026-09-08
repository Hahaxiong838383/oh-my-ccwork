# NIO Warp App 开发设备

2026-09-07，川哥确定后续 NIO Warp App 在 **nio-war-mac** 上开发。

## 设备与网络真值

| 项目 | 已验证配置 |
|---|---|
| 设备 | MacBook Pro，macOS；原主机名 FUTURUSdeMacBook-Pro.local |
| 代号 / ComputerName / LocalHostName / HostName | nio-war-mac |
| SSH 用户 | futurus（全小写） |
| 雷电地址 | 192.168.101.5/24，目标接口 bridge0 |
| Studio 雷电来源 | 192.168.101.4，接口 en2 |
| Wi-Fi 固定地址 | 10.9.1.230/24，目标接口 en0，Manual Configuration |
| Wi-Fi 网关 | 10.9.1.254 |
| DNS | 223.5.5.5、223.6.6.6 |
| 地址保留 | 川哥确认网管已保留 10.9.1.230–234；本机使用 .230 |

此前的 Wi-Fi 地址 10.9.1.153 已废弃，不再作为连接入口。

## 连接方法

| 发起设备 | 命令 | 实际路径 |
|---|---|---|
| Studio | `ssh nio-war-mac` | 雷电 → futurus@192.168.101.5 |
| Studio | `ssh nio-war-mac-wifi` | Wi-Fi → futurus@10.9.1.230 |
| Air | `ssh nio-war-mac` | Wi-Fi → futurus@10.9.1.230 |

Studio 与 Air 各自复用已有 ED25519 密钥，仅将公钥追加到目标用户的 authorized_keys；未迁移私钥。上述连接均已通过 BatchMode 免密查询 hostname 和 SSH_CONNECTION 验证。Air 本轮来源为 10.9.1.110、用户 Rayman.Chen；Air 地址仍为 DHCP，用前重新发现。

## 后续开发边界

- 本项目现归属 `Hahaxiong838383/oh-my-ccwork` 仓库，目录 `2-Projects/nio-warp-demo`。
- nio-war-mac 已完成设备命名、静态网络和 SSH 授权。
- 2026-09-08 已从 Air 增量同步至 `/Users/futurus/mycc/2-Projects/nio-warp-demo`，173 个文件 SHA-256 全部一致；本机构建、安装并启动 v0.9.2 (17)，入口 `/Users/futurus/Applications/NIOWarpApp.app`。
- Command Line Tools 26.6 / Swift 6.3.2 已可用；缺少 XCTest，目标本地测试未通过。Air 同源测试 117/117 通过；uv 未安装验收。详见 [部署回执](nio-war-mac-deployment-20260908.md)。
- README 下方原 Air 的 `/Users/rayman.chen/...` 路径属于历史记录；新开发机使用上述 futurus 路径。桌面 `NIO Warp.command` 可启动安装版。
- 已配置禁止睡眠并实测合盖雷电/Wi-Fi SSH 正常；ProtoPie 10.4.0、UU 远程 4.39.1 已安装启动。用户已登录 ProtoPie，但 2026-09-08 15:57 MCP 仍返回未启用；UU 实际远控尚未验收。
- 不将登录密码、私钥写入项目或共享记忆。

署名：codex（OpenAI）| 2026-09-07（Asia/Shanghai）
