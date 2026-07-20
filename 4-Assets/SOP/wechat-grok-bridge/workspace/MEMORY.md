# MEMORY.md — wechat-grok-bridge workspace

## Channel

- 主机：linux-lan（家用 Ubuntu）· 微信 iLink Bot ↔ Grok
- 桥接：`~/wechat-grok-bridge` · getupdates → grok -p → sendmessage(+media)
- 出网：本机 xray `127.0.0.1:10808`；微信 API 直连 NO_PROXY

## Behavior

- 执行型；中文；纯文本格式（见 AGENTS.md）
- Session soft 5MB / hard 20MB 均归档入记忆
- 入站媒体：`.inbound-media/`；出站：`[[send-file:/path]]`

## Archived Sessions (auto)

（由 archive-to-memory 自动追加）
