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
| **xray 出网**（2026-07-24） | `xray.service` · `~/.local/xray/xray` + `~/.config/xray/config.json`(600) | 本机代理 127.0.0.1:10808/10809；DMIT 主 + mini 兜底 |
| Skills | `~/.grok/skills/`（lark-* / feishu-*） | 从 mycc 同步 |
| MCP | `feishu-bot`（`~/.grok/mcp/feishu-bot`） | bot 身份 send/list/openapi |
| lark-cli | `~/.lark-cli` + `LARK_CLI_NO_PROXY=1` | bot 凭据，飞书直连 |
| 记忆 | `~/.grok/memory/MEMORY.md` + workspace `AGENTS.md` | 通道约定与飞书相关原子记忆 |

## 网络

- **SSH**：默认 `ssh dev198` → `8.218.26.17:22198`（frpc）；备用 `dev198-jump`（mini-pub）、`dev198-lan`（`10.9.1.198`）
- **Grok / xAI**（2026-07-24 起）：走 **dev198 本机 xray** `http://127.0.0.1:10808`，不再依赖 mini 开机
- **飞书 API**：`NO_PROXY` 含 `.feishu.cn` 等，**直连**

### 本机 xray 出网（2026-07-24 上线）

| 项 | 值 |
|----|-----|
| 主出口 | `DMIT-Gemini-vps-chenchuan`（VLESS+Reality，节点从 Air `~/xray/config.json` 同步） |
| 降级 | observatory 每 60s 探活（gstatic 204）；DMIT 全挂 → balancer `fallbackTag` 自动走 **mini** `10.9.1.57:10808` |
| 手动兜底 | `127.0.0.1:10809` 入站**直通 mini**（xray 配置坏/DMIT 换节点排障时用） |
| 消费方 | bridge `.env`、`grok-auto-update.sh`、`grok-xai-keepalive.sh`（均已指 `127.0.0.1:10808`） |

```bash
systemctl --user status xray
journalctl --user -u xray -n 20 --no-pager -o cat   # 路由决策日志 [in-main -> 出口tag]
curl -sS -x http://127.0.0.1:10808 -m 10 -o /dev/null -w '%{http_code}\n' https://www.gstatic.com/generate_204
curl -sS -x http://127.0.0.1:10808 https://ifconfig.me   # 主通道出口 IP（DMIT=38.49.38.237）
~/.local/xray/xray run -test -c ~/.config/xray/config.json   # 改配置后先校验
```

- **DMIT 节点变更**：Air 上 `~/xray/config.json` 取新 outbound → 替换 dev198 `~/.config/xray/config.json` outbounds[0] → `-test` → `systemctl --user restart xray`
- **回滚到 mini 直连**：bridge `.env` 与两个 grok 脚本里 `127.0.0.1:10808` 改回 `10.9.1.57:10808`，重启 bridge 即可（xray 服务可留）

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

## Max turns / 动态墙钟（2026-07-21）

与 linux-lan 微信通道对齐：

| 项 | 值 |
|----|-----|
| `GROK_MAX_TURNS` | **100**（默认 full） |
| `GROK_SHORT_MAX_TURNS` | **24**（仅纯寒暄） |
| 墙钟 | **动态** light≈8m / standard≈15m / heavy≈30m / extreme≈45m（`lib/task-budget.mjs`） |
| 触顶 | max-turns **或** timeout → **同 session 续跑 ≤3**，禁止因 Max turns mint 丢进度 |
| 运行时 | `~/feishu-grok-bridge/lib/grok-runner.mjs` + `grok-session.mjs` |
| 仓内 | `4-Assets/SOP/feishu-grok-bridge/lib/` |

`classifyMode` 默认 full；「继续 / 开干 / p0」等不再误判 short=8。

## 仓内源码

- 桥接：`4-Assets/SOP/feishu-grok-bridge/`（含 modular `lib/` 关键文件）
- Grok OAuth 保活脚本：`4-Assets/SOP/grok-xai-token-refresh.py`

## 边界

- Bot 身份已通；**User OAuth**（个人云文档/日历）未从 Mac Keychain 迁到 Linux，需时在 dev198 `lark-cli auth login`
- 桥接默认 `bypassPermissions` 无人值守，仅白名单 openId
- Grok 出网主依赖 = 本机 xray + DMIT 节点；DMIT 挂自动降级 mini（此时才依赖 mini 开机）；frpc 挂 → 默认 `ssh dev198` 失败，改 jump
- git 隐私墙（2026-07-24）：`workspace/leader/exports|inbox|images` 等人事产物已 gitignore 禁入库；plans/org-42x 等未跟踪文件入库需川哥拍板

## H 路线 · 多用户 BYOS 平台（2026-07-24 P1 进行中）

本通道正演进为多用户平台：用户扫码得**自己的** Bot + agent 实例（独立记忆/KB/skills/MCP）+ **自己的订阅**（BYOS）。

- **规划/进展**：dev198 `workspace/plans/role-channel-L-M-H.md`（H 章）+ `h-p1-implementation.md` + `h-p1-3-sandbox.md` + `h-p1-4-6-byos-dashboard.md`（push `origin/feature/h-p1`）
- **记忆**：A canonical `project_feishu_grok_h_byos`（拍板结论/账号三层/分层体系/验收协议 + P1.4/1.5/1.6 全量）
- **控制面 h-control**（`ai.kidshub.cn`，阿里云 HK 公网 TLS；**执行面 dev198 不暴露公网**）：
  - systemd `h-control`（User=h-control，`/srv/h-control/app`，nginx→`127.0.0.1:18790`，MemoryMax 200M）
  - 功能：dashboard(magic link 登录) + BYOS device-flow OAuth(xAI+Kimi) + AES-256-GCM vault + token-manager keep-warm(唯一刷新者防 rotation war，不碰 owner)
  - 源码 `origin/feature/h-p1` `control-plane/`；secret（`SERVICE_TOKEN`/`SESSION_SECRET`/`.vault-key`）只在 `/srv/h-control/.env`+data(600)，**不入 git**
  - `/internal/creds/<uid>` **只下发 access token**，refresh 永不出控制面
- **P1 全五块机验通过**：多 App 连接池 + 用户模型（`lib/app-registry.mjs`）+ bwrap 沙箱（`lib/sandbox.mjs`）+ 引擎适配（`lib/kimi-runner.mjs` kimi 直连 / `lib/control-client.mjs` 凭据同步）+ 控制面上云；代码 `origin/feature/h-p1`（f3b0e1b/733cf56），**未合 main**
- **引擎出网**：grok 走本机 xray `127.0.0.1:10808`；**kimi 直连**（不走 xray，川哥拍板）→ 沙箱需修 DNS（挂 `/run/systemd/resolve`，见记忆 `feedback_bwrap_sandbox_dns_direct_connect`）
- **唯一待真机**：川哥绑真订阅走 device flow → 引擎 200 对话（harness 全绿）。验收窗口就绪：worktree `.env` 已配 `H_CONTROL_URL`+`H_CONTROL_TOKEN`
- ⚠️ **运维注意**：生产 = 主 checkout `main` 单账号（不含 H_CONTROL，owner 不需要）；H 多用户开发在 worktree `~/fgb-h-p1`（`feature/h-p1`），两者勿混；测试账号 park 在 `/srv/h-platform/.test-account-parked.json`
