# linux-lan 微信 ↔ Grok Build 通道运维

> 2026-07-20 从 dev198 飞书通道机制复刻；通道改为微信 iLink Bot。  
> **状态：E2E 已通**；2026-07-21 完成 P0/P1/P2 对齐（记忆闭环 / 多媒体 / MCP·skills）。  
> Secret 不入库；凭据只在 linux-lan 本机。

## 与 dev198 对照

| 能力 | dev198 | linux-lan |
|------|--------|-----------|
| 入口 IM | 飞书 WS | **微信 getupdates 长轮询** |
| QR 模块 | feishu-qr-login-module | **wechat-qr-login-module** |
| 桥接 | feishu-grok-bridge（模块化） | **wechat-grok-bridge（lib/* 模块化）** |
| 入站媒体 | media-inbound | **CDN+AES 下载 → `.inbound-media/`** |
| 出站媒体 | 卡片为主 | **`[[send-file:/path]]` 上传发图/文件** |
| 群聊 | @Bot / 前缀 | **best-effort + `grok:` 前缀** |
| Grok | 0.2.103+ | **0.2.106** |
| 出网 | mini xray | **本机 xray `127.0.0.1:10808`** |
| 记忆 | archive-to-memory + soft 归档 | **同构（标签 wechat/linux-lan）** |
| MCP | feishu-bot + ai-memory | **wechat-bot**（send_text/status） |
| Skills | lark-* 全家桶 | **wechat-channel-rules + marketplace 默认** |
| 保活 | refresh / auto-update / session-gc | **同构；GC 指向 wechat bridge** |
| SSH | `dev198` :22198 | `linux-lan` / `linux-lan-pub` :22119 |

## 组件

| 组件 | 路径 / unit | 作用 |
|------|-------------|------|
| QR 注册 | `~/wechat-qr-login-module` · `wechat-qr-login.service` | 扫码建 Bot，AES 存 accounts |
| 桥接 | `~/wechat-grok-bridge` · `wechat-grok-bridge.service` | getupdates → media → `grok -p` → 回微信 |
| Grok CLI | `~/.grok/bin/grok` | headless；OAuth `~/.grok/auth.json` |
| OAuth 保活 | `grok-xai-refresh.timer` | 每 2h；**仅本机** `~/.grok/auth.json` |
| 自动更新 | `grok-auto-update.timer` | 每日 04:30 |
| Session GC | `grok-session-gc.timer` | 每日 03:40 + archive-to-memory |
| 本机代理 | system `xray` + watchdog | 10808 |
| 记忆 | `~/.grok/memory/MEMORY.md` | experimental-memory |
| MCP | config.toml `wechat-bot` | 主动发消息 |
| Skill | `~/.grok/skills/wechat-channel-rules` | 通道规则 |

## 首次扫码（必须）

```bash
# Mac 隧道
ssh -f -N -L 3100:127.0.0.1:3100 linux-lan
# 打开 http://127.0.0.1:3100/
# Admin Token 在 linux-lan: cat ~/wechat-qr-login-module/.admin-token.txt
```

扫码成功后 `wechat-accounts.json` 生成，bridge 自动脱离 wait 开始收消息。

## 常用命令

```bash
ssh linux-lan
systemctl --user status wechat-qr-login wechat-grok-bridge \
  grok-xai-refresh.timer grok-auto-update.timer grok-session-gc.timer
journalctl --user -u wechat-grok-bridge -f
tail -f ~/wechat-grok-bridge/logs/bridge.log
node ~/wechat-grok-bridge/bridge.mjs --check
~/.local/bin/grok-session-gc.sh   # 手动 GC（应写记忆，不再 skip）
grok --version
```

## 机制参数（与 dev198 对齐）

| 变量 | 默认 | 含义 |
|------|------|------|
| `GROK_TIMEOUT_MS` | 900000 | **standard 锚点**（非写死全局） |
| `GROK_TIMEOUT_MIN_MS` | 480000 | 墙钟下限 8min |
| `GROK_TIMEOUT_MAX_MS` | 2700000 | 墙钟上限 45min |
| `GROK_MAX_TURNS` | **100** | 执行型（默认 full；防 Max turns） |
| `GROK_SHORT_MAX_TURNS` | **24** | 仅纯寒暄 |
| `GROK_CONTINUE_ON_MAX_TURNS` | **3** | 轮次/墙钟触顶后同 session 续跑 |
| `GROK_CONTINUE_MAX_TURNS` | **100** | 每次续跑轮次 |
| `GROK_SESSION_RESUME_MAX_BYTES` | 5MB | soft **归档+换 session** |
| `GROK_SESSION_MAX_BYTES` | 20MB | hard 归档 |
| `GROK_EXTRA_ARGS` | `--experimental-memory` | full 模式 |
| `REQUIRE_GROUP_PREFIX` | 1 | 群需 `grok:` / @ |
| `WECHAT_GROK_BRIDGE_ROOT` | `~/wechat-grok-bridge` | session-gc 脚本路径 |

> **Max turns / 墙钟（2026-07-21）**：默认 full；**超时按时长预算动态估**（light≈8m / standard≈15m / heavy≈30m / extreme≈45min，见 `lib/task-budget.mjs`）；轮次或墙钟触顶 → 同 session 续跑最多 3 次，**禁止因 timeout mint 新 session**；超时前约 2min 预告；仍不够回 partial +「继续」。

### 微信进度反馈（仅通道 · 默认开）

| 变量 | 默认 | 含义 |
|------|------|------|
| `WX_STATUS` | `1` | 总开关；`0` 关闭 |
| `WX_STATUS_FIRST_SEC` | `60` | 开跑后首次心跳延迟 |
| `WX_STATUS_HEARTBEAT_SEC` | `120` | 心跳间隔 |
| `WX_STATUS_MAX_BEATS` | `8` | 常规心跳上限，其后变稀 |
| `WX_STATUS_SPARSE_SEC` | `300` | 变稀后间隔 |

消息形态：`【进度】开始执行 · full/100 · sid=…` / `仍在执行 · 已 3m · 正常` / `触顶续跑 1/3` / `任务中断（服务停止/重启）`。  
systemd 停服务时会先尝试发中断提示再杀 grok（`TimeoutStopSec=120`）。

## 多媒体用法

**入站**：用户发图/文件/语音/视频 → 桥接下到  
`~/wechat-grok-bridge/workspace/.inbound-media/YYYYMMDD/` → 路径注入 prompt。

**出站**：Grok 回复中写：

```
[[send-file:/home/USER/wechat-grok-bridge/workspace/out.png]]
```

或：

```
本地路径: /home/USER/.../report.pdf
```

桥接会 CDN 上传并 `sendmessage`（image/file/video）。

## 仓内源码

- `4-Assets/SOP/wechat-grok-bridge/`（bridge + lib + mcp + skills）
- 本文件：`4-Assets/SOP/linux-lan-wechat-grok-channel.md`

## Grok OAuth（Mac / Linux 独立）

> **铁律：Mac 与 linux-lan 各自 device-auth，独立 refresh_token，禁止互拷 `auth.json`。**  
> 互拷会触发 refresh rotation war（一方刷 token 另一方 `invalid_grant`）。

| 侧 | 登录 | 保活 |
|----|------|------|
| linux-lan | `grok login --device-auth`（需本机 xray 代理） | `grok-xai-refresh.timer` 每 2h `--if-expiring 14400`；日志 `~/.grok/logs/xai-refresh.log` |
| Mac | 本机 `grok login` / 现有 keep-warm | 本机 launchd / 脚本，**不要** scp 到 linux |

重登（linux）：

```bash
ssh linux-lan
export https_proxy=http://127.0.0.1:10808 http_proxy=http://127.0.0.1:10808
grok login --device-auth   # 浏览器打开 device URL 填码
python3 ~/.local/bin/grok-xai-token-refresh.py --check
systemctl --user restart wechat-grok-bridge
```

检查：

```bash
python3 ~/.local/bin/grok-xai-token-refresh.py --check
systemctl --user status grok-xai-refresh.timer
tail -f ~/.grok/logs/xai-refresh.log
```

## 边界

- 微信 Bot 资格取决于账号；扫码失败属平台侧
- 群字段依赖 iLink 是否下发 room_id（best-effort）
- 飞书 lark skills **不**迁本机
- ai-memory HTTP MCP 未部署（可按需挂；secret 不入库）
- `ALLOW_USER_IDS` 生产应填白名单
- 节点密钥 / bot_token / auth.json **禁止入 git**
- **禁止** Mac↔linux 同步 `~/.grok/auth.json`
- **禁止** 微信任务内 `systemctl restart wechat-grok-bridge`（agent 会自杀中断；改代码由 SSH 运维重启）
