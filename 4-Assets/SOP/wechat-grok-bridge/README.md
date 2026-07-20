# wechat-grok-bridge

微信 iLink Bot ↔ Grok Build（对齐 dev198 `feishu-grok-bridge` 机制，通道换成微信）。

## 组件

| 组件 | 路径 | 作用 |
|------|------|------|
| QR 登录 | `~/wechat-qr-login-module` | 扫码拿 bot_token，AES 存 accounts |
| 桥接 | `~/wechat-grok-bridge` | getupdates → `grok -p` → sendmessage |
| Grok | `~/.grok/bin/grok` | headless 执行 + 记忆 |
| 本机代理 | xray `127.0.0.1:10808` | 访问 xAI |

## 首装

见 `4-Assets/SOP/linux-lan-wechat-grok-channel.md`。

```bash
cd ~/wechat-grok-bridge
cp .env.example .env   # 填 secret / 路径
node bridge.mjs --check
systemctl --user status wechat-grok-bridge
```

## 扫码

```bash
# 本机或隧道
ssh -L 3100:127.0.0.1:3100 linux-lan
open http://127.0.0.1:3100/
# DEMO_ADMIN_TOKEN 见 wechat-qr .env
```

## 机制（与 dev198 同构）

- sticky session + soft 5MB / hard 20MB 轮转
- `archive-to-memory.mjs` 归档入 `~/.grok/memory`
- short/full turns + `GROK_TIMEOUT_MS` 墙钟
- `bypassPermissions` 无人值守
- 串行 `enqueue`
