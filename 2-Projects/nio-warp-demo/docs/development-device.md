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
- 本轮尚未向 nio-war-mac 克隆或迁移项目，尚未验证其 Xcode/Swift/uv 工具链，也未构建、安装或启动 NIO Warp App。
- README 中原 Air 的 `/Users/rayman.chen/...` 路径属于历史运行记录，不能当作新开发机路径；后续在目标机查询实际 HOME、选定工作目录后再更新构建入口。
- 不将登录密码、私钥写入项目或共享记忆。

署名：codex（OpenAI）| 2026-09-07（Asia/Shanghai）
