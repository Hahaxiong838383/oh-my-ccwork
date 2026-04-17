# VPS2 翻墙节点（US Cogent）

> 2026-04-17 部署 · 3x-ui v2.8.11 + xray 26.2.6 + BBR · 守护机制已固化

## 架构

```
Client (v2rayN / v2rayNG / NekoBox)
   │  VLESS-Reality :443 (TCP, xtls-rprx-vision, dest=www.microsoft.com)
   │  VMess-WS     :10086 (老版兼容)
   ▼
US VPS2 (Cogent, Ubuntu 24.04, 2C2G, BBR 启用)
   ├─ x-ui.service         # 管理层（开机自启 + Restart=always）
   ├─ xray-linux-amd64     # 代理核心（从 /etc/x-ui/x-ui.db 读 inbound 配置）
   └─ xray-healthcheck.timer  # 每 2 min 端口/进程双探测 + 自愈
```

## 敏感信息位置（均 gitignore，不入仓）

| 文件 | 内容 |
|------|------|
| `.env` | VPS IP / SSH user / 面板 URL · UUID / Reality priv+pub / ShortId / WS path |
| `subscription.txt` | v2rayN / v2rayNG 通用两条分享链接 |
| `scripts/*` | xray-healthcheck 脚本 + systemd unit（纯净脚本，保守 gitignore）|

SSH 私钥：`~/.ssh/us_vps2_rsa`（仓库外）

## 守护三重保障（已部署验证）

1. **开机自启** — `x-ui.service` `enabled`，`/etc/sysctl.conf` 写入 BBR 参数
2. **崩溃自拉** — override 把 `Restart=on-failure` 升级为 **`Restart=always / StartLimitBurst=0`**
3. **健康守护** — `xray-healthcheck.timer` 每 2 min 跑 `xray-healthcheck.sh`：检查 xray 进程 + `:443/:10086` 双端口 listen，任一不通立刻 `systemctl restart x-ui` + syslog

实测：`pkill -9 xray` → 8 秒内新 pid + 端口恢复。

## 部署要点（给未来的自己）

1. **一键装 3x-ui**：`echo "n" | bash <(curl -Ls https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh)`
2. **直接 sqlite3 写 inbound** 最省事（不用折腾面板 admin 密码）：
   ```
   /etc/x-ui/x-ui.db 表 `inbounds` (v2.8.11 schema)
   字段: id, user_id, up, down, total, all_time, remark, enable, expiry_time,
         traffic_reset, last_traffic_reset_time, listen, port, protocol,
         settings, stream_settings, tag, sniffing
   注意: 旧版的 `allocate` 列已移除，插入时省略
   ```
3. **Reality 密钥对校验铁律**：插完 inbound 后必须跑 `xray x25519 -i <privateKey>`，输出 `Password` 字段须与 `stream_settings.settings.publicKey` 一致（否则客户端静默断连）
4. **分享链接用公网 IP，不要用域名**（域名可能指向别的项目导致客户端 timeout，上一个节点血泪教训）
5. **客户端连不上先 `nc -zv IP port`** 裸 TCP 测试，别跳到猜协议

## 同族项目

`2-Projects/vps-proxy/` 家族已有：
- 根目录 — gemini-proxy / codex-proxy（LLM API 代理）
- `./xray/` — 第一个 Colocrossing 翻墙节点
- `./xray2/` — 本节点（Cogent 独立直连）
