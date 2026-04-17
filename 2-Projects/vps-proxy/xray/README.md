# Xray 翻墙代理节点（带 LAX 中转）

> US VPS 上的 3x-ui + Xray 双协议代理 + DMIT LAX gost 中转
> 部署日期：2026-04-17 · 面板版本：3x-ui v2.8.11 + xray-core 26.2.6 · gost 3.0.0-rc10

## 架构

```
Client (xray / v2ray / NekoBox / Shadowrocket)
   │
   ├─── [直连] ────────────────────────────────────┐
   │                                              │
   └─── [推荐中转] ─→ LAX Relay (DMIT LAX.AN4)     │
                     <RELAY_IP>                    │
                     gost TCP forward              │
                      :443   → <LANDING_IP>:443    │
                      :10086 → <LANDING_IP>:10086  │
                      :9443  → <LANDING_IP>:8443   │ ★ 推荐（绕 443 DPI）
                                                   ▼
                                 US VPS 落地机 (Colocrossing, <LANDING_IP>)
                                   ├── :443    VLESS + TCP + Reality (易被 5G ISP DPI)
                                   ├── :8443   VLESS + TCP + Reality (备用端口, 与丽萨同款)
                                   ├── :10086  VMess + WebSocket
                                   └── :50971  3x-ui 管理面板
```

> 真实 IP、域名、UUID、Reality 密钥、shortId、WS path 全部存本地 `.env`，不入 git。

**部署教训（2026-04-17）**：最大坑是**分享链接里用了不相关的域名**——该域名解析到国内某无关 IP，客户端怎么连都 timeout，耗了一整天才定位。教训：

1. **翻墙节点分享链接一律用公网 IP，不要用域名**（SSH 别名可以用域名，客户端 share link 必须 IP）
2. **故障第一步 `nc -zv IP port`** 裸 TCP 测试，不猜 SNI/DPI/端口封锁
3. **Reality 部署后用 `xray x25519 -i <privateKey>`** 反推 publicKey（输出字段叫 `Password`），跟 inbound JSON 的 `settings.publicKey` 比对是否一致
4. **Reality 握手验证必须从客户端真实网络发起**，服务端 127.0.0.1 回环能拿到 dest 证书不代表外部能握手

当前生产配置：落地机开 :443 和 :8443 两个 VLESS-Reality inbound，Reality dest `www.microsoft.com:443`。中转端 `:443→landing:443` 和 `:9443→landing:8443` 并存，客户端用任一均可。

**Kernel**: Ubuntu 24.04 LTS, kernel 6.8（落地+中转同配）
**BBR**: ✅ 双端启用（`tcp_congestion_control=bbr`, `qdisc=fq`）
**IPv6**: ✅ 中转机有全局 IPv6

## 本地配置（已 gitignore，不入 git）

| 文件 | 内容 |
|------|------|
| `.env` | 落地机 + 中转机 · SSH/密码/IP/面板凭据 · UUID / Reality 密钥 / WS path / shortId |
| `subscription.txt` | 4 条分享链接（直连 × 中转 × VLESS × VMess） |
| `xray-outbounds.json` | 本机 xray `config.json` 的 outbounds 片段 |
| `scripts/add-inbounds.sh` | 通过 3x-ui API 创建入站的部署脚本 |
| `scripts/gost-us-vps.service` | 中转机的 gost systemd unit 备份 |

SSH 私钥：`~/.ssh/dmit_fqzz_ed25519`（DMIT 下发的 key，仓库外存储）

## 协议选型

| 场景 | 选哪个 |
|------|-------|
| 老版 v2ray-core / 最大兼容性 | **VMess-WS** |
| xray / 追求抗封锁 + 速度 / 无域名 | **VLESS-Reality** |

VLESS-Reality 不支持老版 v2ray-core（仅 xray），但性能更好、无需域名、抗主动探测。**Reality 在中转之后的伪装仍然成立** — 2026-04-17 实测 openssl s_client 从 Mac → 中转 :443 返回 `CN=www.cloudflare.com` 证书链，穿透完美。

## SSH 快捷方式（别名，真 IP 在本地 `~/.ssh/config`）

```bash
ssh us-vps              # 落地机
ssh lax-relay           # LAX 中转机
ssh us-vps "x-ui"       # 落地机面板交互菜单
ssh us-vps "x-ui status"
```

## 运维常用

```bash
# 落地机
ssh us-vps "ss -tlnp | grep -E ':(443|10086|50971)'"
ssh us-vps "x-ui restart"

# 中转机
ssh lax-relay "ss -tlnp | grep -E ':(443|10086|8443)'"
ssh lax-relay "systemctl status gost-us-vps --no-pager"
ssh lax-relay "journalctl -u gost-us-vps -n 50 --no-pager"
```

## 中转机的 gost 配置（结构示意，真 IP 以本地 `.env` 为准）

```ini
# /etc/systemd/system/gost-us-vps.service
[Service]
ExecStart=/usr/local/bin/gost -L tcp://:443/<LANDING_IP>:443 \
          -L tcp://:10086/<LANDING_IP>:10086 \
          -L tcp://:9443/<LANDING_IP>:8443
```

原有的 `gost.service`（:8443 → 丽萨主机）保留未动，两个 unit 并存。新增的 `:9443 → <LANDING_IP>:8443` 是**端口错位映射**——中转端用 :9443 是为了避开 `gost.service` 占用的 :8443，让丽萨链路和新落地机 :8443 Reality 入站共存互不干扰。

## 同族项目

本项目属于 `2-Projects/vps-proxy/` 家族，姊妹服务：
- `../` (根目录 gemini-proxy / codex-proxy) — **LLM API 代理**
- `./` (本目录 xray) — **翻墙代理节点 + 中转**（Colocrossing 落地 + DMIT LAX 中转）
- `./xray2/` — 新增 Cogent 独立直连节点（2026-04-17）
