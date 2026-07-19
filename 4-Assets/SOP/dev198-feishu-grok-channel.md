# dev198 飞书 ↔ Grok Build 通道运维

> 2026-07-17 上线。Secret 不入库；凭据只在 dev198 本机。

## 组件

| 组件 | 路径 / unit | 作用 |
|------|-------------|------|
| QR 注册 | `~/feishu-qr-login-module` · `feishu-qr-login.service` | PersonalAgent 扫码建 Bot，AES 存 accounts |
| 桥接 | `~/feishu-grok-bridge` · `feishu-grok-bridge.service` | WS 收消息 → `grok -p` 执行 → 回飞书 |
| Grok CLI | `~/.grok/bin/grok` | headless 执行；OAuth 在 `~/.grok/auth.json` |
| OAuth 保活 | `grok-xai-refresh.timer` | 每 2h keep-warm（`--if-expiring 14400`） |
| **自动更新** | `grok-auto-update.timer` · `~/.local/bin/grok-auto-update.sh` | 每日 04:30 空闲时升级；`config.toml` 已 `auto_update=true` |
| **Session GC** | `grok-session-gc.timer` · `~/.local/bin/grok-session-gc.sh` | 每日 03:40 归档 ≥20MB / 14 天未改 session |
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
systemctl --user status feishu-grok-bridge feishu-qr-login \
  grok-xai-refresh.timer grok-auto-update.timer grok-session-gc.timer
journalctl --user -u feishu-grok-bridge -f
tail -f ~/feishu-grok-bridge/logs/bridge.log
python3 ~/.local/bin/grok-xai-token-refresh.py --check
~/.local/bin/grok-auto-update.sh   # 手动触发一次升级检查
~/.local/bin/grok-session-gc.sh    # 手动扫过大 session
tail -f ~/.grok/logs/auto-update.log
tail -f ~/.grok/logs/session-gc.log
grok --version --no-auto-update
grok mcp list
```

## 自动更新说明（2026-07-19）

- `~/.grok/config.toml`：`[cli] auto_update = true`
- **bridge 每次 `grok -p` 仍带 `--no-auto-update`**（headless 稳定，避免消息处理中换二进制）
- headless/非 TTY 本身也会抑制启动时更新检查
- 因此靠 **`grok-auto-update.timer`（每日 04:30，空闲才跑）** 做真升级；日志 `~/.grok/logs/auto-update.log`

## 通道性能优化（2026-07-19 落地）

| # | 策略 | 实现 | 澄清 |
|---|------|------|------|
| 1 | 单次任务超时 10min | `GROK_TIMEOUT_MS=600000` | **不是**「10 分钟没聊天就切 session」；是**单次 grok 进程墙钟上限** |
| 2 | session 体积轮转 | soft 5MB 跳过 resume 换新 id；hard 20MB 归档；`grok-session-gc.timer` 日扫 | 按**体积/年龄**，不按空闲时间 |
| 3 | resume/锁失败快退 | `already in use` / resume miss → 立刻 mint 新 UUID 再 `-s` | 配合 soft/hard 避免加载卡死 |
| 4 | 简单问答短路径 | `classifyMode`：短问 turns=8 且不加 `GROK_EXTRA_ARGS`；执行型仍 40 | 启发式 |

- sticky map：`~/feishu-grok-bridge/workspace/.session-map.json`
- session 目录：`~/.grok/sessions/<urlencode(cwd)>/<uuid>/`
- 归档：`~/.grok/sessions-archive/`
- **归档必入记忆**（`archive-to-memory.mjs`）：`INDEX.md` / `index.jsonl` / `MEMORY-CARD.md` + `~/.grok/memory/MEMORY.md` + `workspace-*/sessions/*-archive-*.md`，供 experimental-memory 下次召回

## 响应慢排查（2026-07-19 实锤）

| 现象 | 根因 | 处理 |
|------|------|------|
| 单条 30min 级 | 固定 session resume（`-r`）卡死直到旧 `GROK_TIMEOUT_MS=1800000` | 已降到 10min；大 session 跳过 `-r` |
| `Session ID ... already in use` | 上一进程未退干净 / session 锁 | mint 新 id；清 `active_sessions.json` |
| 健康消息仍 1–3min | 执行型 agent：`max_turns=40` + MCP + 多轮推理属正常 | 短问走 short 路径 |
| 排队更久 | bridge `enqueue` **串行**，前一条没完后一条全等 | 勿连发大任务；必要时重启 bridge |

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
