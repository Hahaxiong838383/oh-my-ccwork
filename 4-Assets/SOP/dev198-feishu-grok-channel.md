# dev198 飞书 ↔ Grok Build 通道运维

> 2026-07-17 上线。Secret 不入库；凭据只在 dev198 本机。

## 组件

| 组件 | 路径 / unit | 作用 |
|------|-------------|------|
| QR 注册 | `~/feishu-qr-login-module` · `feishu-qr-login.service` | PersonalAgent 扫码建 Bot，AES 存 accounts |
| 桥接 | `~/feishu-grok-bridge` · `feishu-grok-bridge.service` | WS 收消息 → `grok -p` 执行 → 回飞书 |
| Grok CLI | `~/.grok/bin/grok` | headless 执行；OAuth 在 `~/.grok/auth.json` |
| OAuth 保活 | `grok-xai-refresh.timer` | 每 2h keep-warm（`--if-expiring 14400`） |
| Skills | `~/.grok/skills/`（lark-* / feishu-*） | 从 mycc 同步 |
| MCP | `feishu-bot`（`~/.grok/mcp/feishu-bot`） | bot 身份 send/list/openapi |
| lark-cli | `~/.lark-cli` + `LARK_CLI_NO_PROXY=1` | bot 凭据，飞书直连 |
| 记忆 | `~/.grok/memory/MEMORY.md` + workspace `AGENTS.md` | 通道约定与飞书相关原子记忆 |

## 网络

- **SSH**：默认 `ssh dev198` → `8.218.26.17:22198`（frpc）；备用 `dev198-jump`（mini-pub）、`dev198-lan`（`10.9.1.198`）
- **Grok / xAI**：走 mini 代理 `http://10.9.1.57:10808`（xray mixed，需 mini 开机）
- **飞书 API**：`NO_PROXY` 含 `.feishu.cn` 等，**直连**

## 常用命令（dev198）

```bash
systemctl --user status feishu-grok-bridge feishu-qr-login grok-xai-refresh.timer
journalctl --user -u feishu-grok-bridge -f
tail -f ~/feishu-grok-bridge/logs/bridge.log
python3 ~/.local/bin/grok-xai-token-refresh.py --check
grok mcp list
```

本机扫码页（需隧道）：

```bash
ssh -f -N -L 3200:127.0.0.1:3200 dev198
open http://127.0.0.1:3200/
```

## 仓内源码

- 桥接：`4-Assets/SOP/feishu-grok-bridge/`
- Grok OAuth 保活脚本：`4-Assets/SOP/grok-xai-token-refresh.py`

## 边界

- Bot 身份已通；**User OAuth**（个人云文档/日历）未从 Mac Keychain 迁到 Linux，需时在 dev198 `lark-cli auth login`
- 桥接默认 `bypassPermissions` 无人值守，仅白名单 openId
- mini 关机或 xray 挂掉 → Grok 出网失败；frpc 挂 → 默认 `ssh dev198` 失败，改 jump
