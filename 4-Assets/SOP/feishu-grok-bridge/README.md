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

## 关键环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `GROK_TIMEOUT_MS` | `900000` | standard 墙钟**锚点**（非全局写死） |
| `GROK_TIMEOUT_MIN_MS` / `MAX` | 8m / 45m | 动态墙钟上下限 |
| `GROK_MAX_TURNS` | `100` | 执行型 max_turns（默认 full） |
| `GROK_SHORT_MAX_TURNS` | `24` | 仅寒暄 |
| `GROK_CONTINUE_ON_MAX_TURNS` | `3` | 轮次/墙钟触顶同 session 续跑 |
| `GROK_SESSION_MAX_BYTES` | `20971520` | ≥20MB 归档并换新 session |
| `GROK_SESSION_RESUME_MAX_BYTES` | `5242880` | ≥5MB 跳过 `-r` 换新 id |
| `GROK_EXTRA_ARGS` | — | full 附加（如 `--experimental-memory`） |

见 `.env.example`。配套 `session-gc.sh` / `grok-session-gc.timer` 做日扫。

## 归档 → 记忆召回

`archive-to-memory.mjs` 在 hard/soft 轮转与 GC 时自动跑，写入：

| 位置 | 用途 |
|------|------|
| `~/.grok/sessions-archive/INDEX.md` + `index.jsonl` | 总索引 / 结构化 |
| `~/.grok/sessions-archive/<id>/MEMORY-CARD.md` | 单会话卡片（title/topics/path） |
| `~/.grok/memory/MEMORY.md` → `## Archived Sessions` | experimental-memory 全局召回 |
| `~/.grok/memory/workspace-*/sessions/*-archive-*.md` | 项目 session 日志 |
| `workspace/MEMORY.md` + `FEISHU_TASKLOG.md` | 工作区可见 |

手动回填：

```bash
node archive-to-memory.mjs --dir ~/.grok/sessions-archive/<archived-dir> --reason backfill
```

## 飞书侧

1. 打开扫码创建的 Bot，发私聊文本
2. 群聊需 @Bot 或前缀 `grok:` / `/grok`
3. 仅白名单 openId（默认扫码授权者）

## 安全

- App Secret 只在进程内存
- 日志不含 token
- 默认 `bypassPermissions` 自动批工具——仅内网信任用户使用
