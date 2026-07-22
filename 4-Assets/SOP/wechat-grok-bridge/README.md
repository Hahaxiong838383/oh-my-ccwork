# wechat-grok-bridge

微信 iLink Bot ↔ Grok Build（对齐 dev198 `feishu-grok-bridge` 机制，通道换成微信）。

## 组件

| 组件 | 路径 | 作用 |
|------|------|------|
| QR 登录 | `~/wechat-qr-login-module` | 扫码拿 bot_token，AES 存 accounts |
| 桥接 | `~/wechat-grok-bridge` | getupdates → 媒体下载 → leader+worker 池 `grok -p`（可 streaming）→ 文本/文件回发 |
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
| soft/hard session 归档入记忆 | ✅ soft≥**2MB** / hard 20MB 归档 |
| 群聊 | best-effort；默认需 `grok:` / `/grok` / @Bot |
| session-gc → archive-to-memory | ✅ `WECHAT_GROK_BRIDGE_ROOT` |
| 知识库存库 | ✅ 关键词/口令触发（见下）；默认不因纯链接短路任务 |
| 知识库命令 | ✅ `知识库状态` / `整理知识库` / `本周复盘` |
| 常驻 leader + worker 池 | ✅ `GROK_LEADER` / `GROK_WORKER_POOL_SIZE`（默认 2 并发） |
| 微信流式气泡 | ✅ `WX_STREAM` + streaming-json 节流定稿 |

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
| `GROK_MAX_TURNS` | 60 | full 执行任务轮次 |
| `GROK_SHORT_MAX_TURNS` | 16 | short 寒暄轮次 |
| `GROK_CONTINUE_ON_MAX_TURNS` | 2 | 触顶后同 session 自动续跑次数 |
| `GROK_CONTINUE_MAX_TURNS` | 60 | 每次续跑轮次 |
| `GROK_SESSION_RESUME_MAX_BYTES` | **2MB** | soft 归档+换 session（防大 session 慢死） |
| `GROK_LEADER` | `1` | 常驻 `grok agent leader` |
| `GROK_WORKER_POOL_SIZE` | `2` | 有界并发 |
| `WX_STREAM` | `1` | 微信流式气泡 |
| `GROK_SESSION_MAX_BYTES` | 20MB | hard 归档 |
| `GROK_EXTRA_ARGS` | `--experimental-memory` | full 模式附加 |
| `REQUIRE_GROUP_PREFIX` | `1` | 群消息需前缀/提及 |
| `GROUP_SESSIONS_PER_USER` | `1` | 群内按发送者分 session |
| `BOT_DISPLAY_NAME` | — | @名字 识别 |
| `SECOND_BRAIN_VAULT` | `~/second-brain` | Obsidian 知识库根 |
| `VAULT_AUTO_INGEST` | `0` | `1`=仅薄分享（几乎只有链接/附件、无任务语气）自动入库 |
| `VAULT_AUTO_INGEST_WECHAT` | `0` | `1`=薄分享公众号链可自动入库 |

## 知识库微信口令

- **入库**（才写库并短路）：`存库`/`入库`/`收藏`/`记录`/`记一下`/`/kb`/`/save`…；正文「存进知识库」类词且无任务语气
- **不入库**：带任务语气的链接消息 → 进 Grok 执行（如「仔细读这篇 + 链接」）
- 公众号链接在入库路径下会抓取到 `00-Inbox/wechat`
- `知识库状态` → 统计
- `整理知识库` → 归档骨架 + 火山 LLM 写 Literature（不改原文）
- `问知识库 …` → 基于摘要层检索问答
- `本周复盘` → 周报骨架
- 路由说明：`~/second-brain/90-System/docs/INGEST-ROUTING.md`

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
lib/vault-ingest.mjs
mcp/wechat-bot.mjs
skills/wechat-channel-rules/
workspace/AGENTS.md
workspace/MEMORY.md
```
