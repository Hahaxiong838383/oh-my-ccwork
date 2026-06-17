# cc-remote-v3

> 状态：待川哥确认（疑似 paused / 早期占位）
> 最后活跃日期：2026-03-26
> 一句话目标：待川哥确认（推断：cc-remote 远程终端 v3，通过 FRP 把本地终端端口暴露到公网 relay）

## 下一步
- [ ] 川哥确认本目录定位：是 v3 全新实现，还是只承载 v2 的 FRP 内网穿透配置分支
- [ ] 确认状态（active / paused），补全一句话目标
- [ ] 若为真实 v3，补充服务端/前端实现（当前仅有穿透配置，无应用代码）

## 归档条件
- v3 方案被废弃或并入更新版本（如 cc-remote V4，已有 `cc-remote-deploy` skill）
- 或川哥确认本目录仅为临时配置碎片，迁移后归档

## 当前事实
- 该目录当前仅含 `frpc.toml` 一个文件（309 字节，最后修改 2026-03-26 09:00），疑似 v2 的 frp 配置分支 / v3 早期占位。
- `frpc.toml` 为 FRP 客户端配置模板，标注「实际值请通过环境变量或 .env 文件设置」，serverAddr / auth.token 均用 `{{ .Envs.RELAY_IP }}` / `{{ .Envs.FRP_TOKEN }}` 占位，**无硬编码 secret 或真实地址**。
- 穿透代理 `cc-remote-v3`：TCP 类型，本地 `127.0.0.1:7681` → 远程 `7681`；FRP 服务端口 `7000`。
- 对比参考：`2-Projects/cc-remote-v2/` 是完整 Node.js 项目（xterm + node-pty + express + ws + vite，含 server.js / session-manager.js / tunnel-client.js / index.html，最后修改 2026-03-23），v3 目录无对应应用代码。
- 本目录无独立 GitHub repo，为 mycc 单仓子目录。

## 关键入口
| 入口 | 路径/链接 | 说明 |
|------|-----------|------|
| FRP 客户端配置 | `/Users/rayman.chen/mycc/2-Projects/cc-remote-v3/frpc.toml` | 内网穿透模板，值走环境变量 |
| v2 参考实现 | `/Users/rayman.chen/mycc/2-Projects/cc-remote-v2/` | 完整远程终端 Node 项目（只读参考） |
| 部署 skill | `cc-remote-deploy`（/deploy-remote） | 一键部署 cc-remote V4 远程终端（已存在更新版本，待确认与 v3 关系） |

## 外部信息
| 类型 | 值 |
|------|----|
| 外部 repo | 无（mycc 单仓子目录） |
| 服务地址 | 阿里云 relay，IP 走环境变量 `RELAY_IP`（frpc.toml 未硬编码） |
| 端口 | FRP 服务端 7000；穿透本地 127.0.0.1:7681 → 远程 7681 |
| 负责人 | 川哥 |

## 进度记录
- 2026-06-17：基于本地内容生成项目状态卡（cc）。
