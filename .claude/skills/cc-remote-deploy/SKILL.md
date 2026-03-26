---
name: cc-remote-deploy
description: 为新用户一键部署 cc-remote V4 远程终端服务。输入用户名和密码，自动完成阿里云 relay 配置 + 生成用户部署包。触发词："/deploy-remote"、"部署远程终端"、"给用户开通 cc-remote"
---

# cc-remote V4 用户部署

为新用户一键部署 cc-remote V4 远程终端服务。

## 架构

```
用户手机/电脑 → HTTPS → nginx(阿里云HK) → frps → frpc(用户Mac/PC) → Caddy → ttyd → tmux → Claude/Codex/Gemini
```

## 使用方式

```bash
# 一键部署
cd 2-Projects/cc-remote-v4
./deploy-user.sh <用户名> <密码> [子域名前缀] [caddy端口]

# 示例
./deploy-user.sh bob 'BobPass123'
./deploy-user.sh alice 'AlicePass' cli-alice 39443
```

## 脚本自动完成的工作

### 阿里云 relay 端（自动）
1. 添加 DNS A 记录：`cli-<用户名>.hahaxiong.cc → ${RELAY_IP}`
2. nginx vhost 配置 + Basic Auth
3. Let's Encrypt SSL 证书申请
4. 防火墙端口开放

### 生成用户部署包（自动）
生成 `cc-remote-v4-<用户名>/` 目录，包含：
- `frpc.toml` — 用户专属 FRP 配置
- `Caddyfile` — 用户专属反代配置
- `start.sh` — 启动脚本
- `panel/` — 管理面板
- `README.md` — 使用说明

### 用户自助操作
1. 安装依赖：`brew install caddy ttyd tmux`
2. 下载 frpc：从 GitHub releases
3. 运行 `./start.sh` + `frpc -c frpc.toml`

## 关键参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| relay | ${RELAY_IP}:7000 | 阿里云香港 ECS |
| frp token | ${FRP_TOKEN} | 共享认证（见 .env） |
| 域名 | cli-<用户名>.hahaxiong.cc | 自动生成 |
| Caddy 端口 | 基于用户名 hash | 自动分配 |

## 多用户隔离

| 维度 | 隔离方式 |
|------|---------|
| 域名 | 每用户独立子域名 |
| 认证 | 每用户独立 htpasswd |
| 端口 | 每用户独立 Caddy 端口 |
| frp 代理 | 每用户独立 proxy name |
| SSL | 每用户独立证书 |
| 数据 | 完全隔离（不同机器） |
