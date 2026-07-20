---
name: wechat-channel-rules
description: 微信 iLink Bot ↔ Grok 通道输出与附件规则。在微信通道会话中始终参考。
---

# 微信通道规则

## 输出

- 纯文本；结论先行；短密少空行。
- 不用 Markdown 表格/大代码块/`**` 装饰。
- 结构用 `【块名】` 或编号列表。

## 附件

- 入站已下载到 `cwd/.inbound-media/`，用 Read 打开。
- 出站回传：`[[send-file:/绝对路径]]`。

## 群聊

- 需 `grok:` / `/grok` / @Bot 才处理（REQUIRE_GROUP_PREFIX=1 时）。

## 安全

- 不泄密；拒绝危险系统命令。
