# Xray 翻墙代理节点

> US VPS 上的 3x-ui + Xray 双协议代理（VLESS-Reality + VMess-WS）。  
> 部署日期：2026-04-17 · 面板版本：3x-ui v2.8.11 + xray-core 26.2.6

## 架构

```
Client（xray / v2ray / NekoBox / Shadowrocket）
       ↓
US VPS (Colocrossing, 198.46.146.238)
  ├── :443    VLESS + TCP + Reality  （伪装 www.cloudflare.com）
  ├── :10086  VMess + WebSocket       （v2ray 通用）
  └── :50971  3x-ui 管理面板           （HTTPS, Let's Encrypt 自动续签）
```

**Kernel**: Ubuntu 24.04 LTS, 6.8  
**BBR**: ✅ 已启用（`tcp_congestion_control=bbr`, `qdisc=fq`）

## 本地配置（已 gitignore，不入 git）

所有凭据、UUID、密钥、分享链接保存在以下文件：

| 文件 | 内容 |
|------|------|
| `.env` | VPS IP/密码 · 面板 URL/用户名/密码 · WS path · UUID · Reality 密钥对 · shortId |
| `subscription.txt` | VLESS + VMess 分享链接（扫码/粘贴导入客户端） |
| `xray-outbounds.json` | 本机 xray `config.json` 的 outbounds 片段 |
| `scripts/add-inbounds.sh` | 通过 3x-ui API 创建入站的部署脚本 |

## 协议选型

| 场景 | 选哪个 |
|------|-------|
| 老版 v2ray-core / 最大兼容性 | **VMess-WS** |
| xray / 追求抗封锁 + 速度 / 无域名 | **VLESS-Reality** |

VLESS-Reality 不支持老版 v2ray-core（仅 xray），但性能更好、无需域名、抗主动探测。

## SSH 快捷方式

```bash
ssh us-vps              # 已加 alias 到 ~/.ssh/config
ssh us-vps "x-ui"       # 面板交互菜单
ssh us-vps "x-ui status"
ssh us-vps "journalctl -u x-ui -n 50 --no-pager"
```

## 运维常用

- **查监听**: `ssh us-vps "ss -tlnp | grep -E ':(443|10086|50971)'"`
- **查流量**: 面板 → Inbounds 列表
- **重启 xray**: `ssh us-vps "x-ui restart"`
- **更新 3x-ui**: `ssh us-vps "x-ui update"`

## 同族项目

本项目属于 `2-Projects/vps-proxy/` 家族，姊妹服务：
- `../` (根目录 gemini-proxy / codex-proxy) — **LLM API 代理**（23.226.135.149）
- `./` (本目录 xray) — **翻墙代理节点**（198.46.146.238）

两者同属"美国 VPS 服务栈"，部署在不同实例上。
