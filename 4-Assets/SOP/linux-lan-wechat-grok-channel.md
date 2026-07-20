# linux-lan 微信 ↔ Grok Build 通道运维

> 2026-07-20 从 dev198 飞书通道机制复刻；通道改为微信 iLink Bot。  
> **状态：E2E 已通**（川哥微信私聊 Bot 已收到回复）。  
> Secret 不入库；凭据只在 linux-lan 本机。

## 与 dev198 对照

| 能力 | dev198 | linux-lan |
|------|--------|-----------|
| 入口 IM | 飞书 WS | **微信 getupdates 长轮询** |
| QR 模块 | feishu-qr-login-module | **wechat-qr-login-module** |
| 桥接 | feishu-grok-bridge | **wechat-grok-bridge** |
| Grok | 0.2.103+ | **0.2.106**（`~/.grok/bin/grok`） |
| 出网 | mini xray `10.9.1.57:10808` | **本机 xray `127.0.0.1:10808`** |
| 记忆 | `~/.grok/memory` + archive-to-memory | **同构** |
| 保活 | refresh / auto-update / session-gc timers | **同构** |
| SSH | `dev198` :22198 | `linux-lan` / `linux-lan-pub` :22119 |

## 组件

| 组件 | 路径 / unit | 作用 |
|------|-------------|------|
| QR 注册 | `~/wechat-qr-login-module` · `wechat-qr-login.service` | 扫码建 Bot，AES 存 accounts |
| 桥接 | `~/wechat-grok-bridge` · `wechat-grok-bridge.service` | getupdates → `grok -p` → sendmessage |
| Grok CLI | `~/.grok/bin/grok` | headless；OAuth `~/.grok/auth.json` |
| OAuth 保活 | `grok-xai-refresh.timer` | 每 2h |
| 自动更新 | `grok-auto-update.timer` | 每日 04:30 |
| Session GC | `grok-session-gc.timer` | 每日 03:40 + archive-to-memory |
| 本机代理 | system `xray` + watchdog | 10808 |
| 记忆 | `~/.grok/memory/MEMORY.md` | experimental-memory |

## 首次扫码（必须）

```bash
# Mac 隧道
ssh -f -N -L 3100:127.0.0.1:3100 linux-lan
# 打开 http://127.0.0.1:3100/
# Admin Token 在 linux-lan: cat ~/wechat-qr-login-module/.admin-token.txt
```

扫码成功后 `wechat-accounts.json` 生成，bridge 自动脱离 wait 开始收消息。

## 常用命令

```bash
ssh linux-lan
systemctl --user status wechat-qr-login wechat-grok-bridge \
  grok-xai-refresh.timer grok-auto-update.timer grok-session-gc.timer
journalctl --user -u wechat-grok-bridge -f
tail -f ~/wechat-grok-bridge/logs/bridge.log
node ~/wechat-grok-bridge/bridge.mjs --check
grok --version --no-auto-update
```

## 机制参数（与 dev198 对齐）

| 变量 | 默认 | 含义 |
|------|------|------|
| `GROK_TIMEOUT_MS` | 600000 | 单次 grok 墙钟 10min |
| `GROK_MAX_TURNS` | 40 | 执行型 |
| `GROK_SHORT_MAX_TURNS` | 8 | 短问 |
| `GROK_SESSION_RESUME_MAX_BYTES` | 5MB | soft 跳过 resume |
| `GROK_SESSION_MAX_BYTES` | 20MB | hard 归档 |
| `GROK_EXTRA_ARGS` | `--experimental-memory` | 全量模式 |

## 仓内源码

- `4-Assets/SOP/wechat-grok-bridge/`（bridge.mjs / wechat-api.mjs）
- 本文件：`4-Assets/SOP/linux-lan-wechat-grok-channel.md`

## 边界

- 微信 Bot 资格取决于账号；扫码失败属平台侧
- User OAuth / 飞书 skills **未**迁到本机（通道已非飞书）
- `ALLOW_USER_IDS` 空时放行全部 peer（首装）；生产应填白名单
- 节点密钥 / bot_token / auth.json **禁止入 git**
