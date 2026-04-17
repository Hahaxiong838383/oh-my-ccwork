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
                     fqzz.hahaxiong.cc             │
                     64.186.235.107                │
                     gost TCP forward              │
                      :443  → 198.46.146.238:443   │
                      :10086 → 198.46.146.238:10086│
                      :9443  → 198.46.146.238:8443 │ ★ 推荐（绕 443 DPI）
                                                   ▼
                                 US VPS 落地机 (Colocrossing, 198.46.146.238)
                                   ├── :443    VLESS + TCP + Reality (易被 5G ISP DPI)
                                   ├── :8443   VLESS + TCP + Reality (备用端口, 与丽萨同款)
                                   ├── :10086  VMess + WebSocket
                                   └── :50971  3x-ui 管理面板
```

**端口选型教训（2026-04-17）**：部分 5G ISP 对落地端口 443 的 TLS 做 DPI/QoS 导致手机端 `context deadline exceeded`。直连落地 :443 或中转 :443 都会命中。解决：落地机另开 :8443 Reality 入站 + 中转用 :9443 → :8443 错位映射（避开中转原有的 :8443 → 丽萨链路）。丽萨主机长期稳定用的也是 :8443 而非 :443。

**Kernel**: Ubuntu 24.04 LTS, kernel 6.8（落地+中转同配）  
**BBR**: ✅ 双端启用（`tcp_congestion_control=bbr`, `qdisc=fq`）  
**IPv6**: ✅ 中转机有全局 IPv6（`2605:52c0:2:c1a::/64`）

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

## SSH 快捷方式

```bash
ssh us-vps              # 落地机（198.46.146.238）
ssh lax-relay           # LAX 中转机（64.186.235.107 / fqzz.hahaxiong.cc）
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

## 中转机的 gost 配置

```ini
# /etc/systemd/system/gost-us-vps.service
[Service]
ExecStart=/usr/local/bin/gost -L tcp://:443/198.46.146.238:443 \
          -L tcp://:10086/198.46.146.238:10086 \
          -L tcp://:9443/198.46.146.238:8443
```

原有的 `gost.service`（:8443 → 154.44.3.170:8443 到丽萨主机）保留未动，两个 unit 并存。新增的 `:9443 → 198.46.146.238:8443` 是**端口错位映射**——中转端用 :9443 是为了避开 `gost.service` 占用的 :8443，让丽萨链路和新落地机 :8443 Reality 入站共存互不干扰。

## 同族项目

本项目属于 `2-Projects/vps-proxy/` 家族，姊妹服务：
- `../` (根目录 gemini-proxy / codex-proxy) — **LLM API 代理**（23.226.135.149）
- `./` (本目录 xray) — **翻墙代理节点 + 中转**

两者同属"美国 VPS 服务栈"，部署在不同实例上。
