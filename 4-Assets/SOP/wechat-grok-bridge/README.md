# wechat-grok-bridge

微信 iLink Bot ↔ Grok Build（对齐 dev198 `feishu-grok-bridge` 机制，通道换成微信）。

## 组件

| 组件 | 路径 | 作用 |
|------|------|------|
| QR 登录 | `~/wechat-qr-login-module` | 扫码拿 bot_token，AES 存 accounts |
| 桥接 | `~/wechat-grok-bridge` | getupdates → 媒体下载 → `grok -p` → 文本/文件回发 |
| Grok | `~/.grok/bin/grok` | headless + experimental-memory |
| 本机代理 | xray `127.0.0.1:10808` | 访问 xAI |
| MCP | `mcp/wechat-bot.mjs` | Grok 可主动 `send_text` |
| Skill | `skills/wechat-channel-rules` | 通道输出规则 |

## 能力

| 能力 | 状态 |
|------|------|
| 文本私聊 | ✅ |
| 入站图/文件/语音/视频下载 | ✅ → `workspace/.inbound-media/` |
| 出站文件 | ✅ 回复 `[[send-file:/abs]]` |
| soft/hard session 归档入记忆 | ✅ soft≥5MB 也归档 |
| 群聊 | best-effort；默认需 `grok:` / `/grok` / @Bot |
| session-gc → archive-to-memory | ✅ `WECHAT_GROK_BRIDGE_ROOT` |

## 首装 / 更新

见 `4-Assets/SOP/linux-lan-wechat-grok-channel.md`。

```bash
cd ~/wechat-grok-bridge
node bridge.mjs --check
systemctl --user restart wechat-grok-bridge
```

## 机制参数

| 变量 | 默认 | 含义 |
|------|------|------|
| `GROK_TIMEOUT_MS` | 600000 | 单次墙钟 |
| `GROK_SESSION_RESUME_MAX_BYTES` | 5MB | soft 归档+换 session |
| `GROK_SESSION_MAX_BYTES` | 20MB | hard 归档 |
| `GROK_EXTRA_ARGS` | `--experimental-memory` | full 模式附加 |
| `REQUIRE_GROUP_PREFIX` | `1` | 群消息需前缀/提及 |
| `GROUP_SESSIONS_PER_USER` | `1` | 群内按发送者分 session |
| `BOT_DISPLAY_NAME` | — | @名字 识别 |

## 目录

```
bridge.mjs
wechat-api.mjs
archive-to-memory.mjs
session-gc.sh
lib/media-inbound.mjs
lib/media-outbound.mjs
lib/message-parse.mjs
lib/session-key.mjs
mcp/wechat-bot.mjs
skills/wechat-channel-rules/
workspace/AGENTS.md
workspace/MEMORY.md
```
