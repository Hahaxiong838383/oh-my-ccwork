---
name: wechat-channel-rules
description: 微信 iLink Bot ↔ Grok 通道输出、附件、防自杀与 context 规则。在微信通道会话中始终参考。
---

# 微信通道规则

## 输出

- 纯文本；结论先行；短密少空行。
- 不用 Markdown 表格/大代码块/`**` 装饰。
- 结构用 `【块名】` 或编号列表。
- 长任务：先做后说；中间可靠【进度】/【进行中】，勿只沉默工具。

## 附件

- 入站已下载到 `cwd/.inbound-media/`，用 Read 打开。
- 出站回传：`[[send-file:/绝对路径]]`。

## 群聊

- 需 `grok:` / `/grok` / @Bot 才处理（`REQUIRE_GROUP_PREFIX=1` 时）。

## 安全

- 不泄密；拒绝危险系统命令。
- **绝对禁止**在工具里执行会杀掉本通道的命令：
  - `systemctl`/`service` `restart|stop|kill` `wechat-grok-bridge` / `wechat-qr-login`
  - `kill`/`pkill` 针对 bridge / 本通道 grok
  - 改完 bridge 代码也**不要**自重启；写清「需川哥在 SSH 侧重启」
  - 自己 restart = 立刻中断当前任务，进度假死（已多次踩坑）

## 通道假死认知（给 Agent）

- 用户说「没动静」时：你可能仍在跑，但 **回微信失败**（`prepare failed` / context 过期）。
- 不要假设「我没回 = 我没做」；做完仍要用可投递路径汇报。
- 需要运维侧重启/换 session 时：只输出 SSH 步骤，自己不动 unit。

## 能力开关（只读知晓）

- Leader / worker 池 / 流式：见 bridge 启动日志与 `docs/QUICKSILVER-SPEED.md`
- 验收口令：`ping` / `健康`
