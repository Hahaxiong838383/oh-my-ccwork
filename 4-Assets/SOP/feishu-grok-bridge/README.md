# feishu-grok-bridge

飞书 PersonalAgent Bot（WS 长连接）↔ Grok Build headless。

## 依赖

1. 已用 `feishu-qr-login-module` 扫码注册，凭据在加密 `accounts.json`
2. dev198 已装 Grok Build 且 `grok login` 有效
3. mini xray 代理可用（Grok 访问 xAI）

## 运行（dev198）

```bash
cd ~/feishu-grok-bridge
node bridge.mjs --check   # 验凭据解密 + tenant token
systemctl --user status feishu-grok-bridge
journalctl --user -u feishu-grok-bridge -f
```

## 飞书侧

1. 打开扫码创建的 Bot，发私聊文本
2. 群聊需 @Bot 或前缀 `grok:` / `/grok`
3. 仅白名单 openId（默认扫码授权者）

## 安全

- App Secret 只在进程内存
- 日志不含 token
- 默认 `bypassPermissions` 自动批工具——仅内网信任用户使用
