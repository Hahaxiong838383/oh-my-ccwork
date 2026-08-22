---
name: linux-lan-wechat
description: 家用 linux-lan 微信↔Grok 通道运维与假死排障。触发词："微信通道"、"wechat-grok"、"prepare failed"、"linux-lan 微信"、"Bot 没回复"、"微信卡死"
---

# linux-lan 微信 ↔ Grok 通道

> 主机：家用 Ubuntu `linux-lan` / 外网 `linux-lan-pub`（frp `:22119`）  
> 详细 SOP：`4-Assets/SOP/linux-lan-wechat-grok-channel.md`  
> 源码真源（仓）：`4-Assets/SOP/wechat-grok-bridge/` · 运行态：`~/wechat-grok-bridge`

## 组件

| 组件 | unit / 路径 |
|------|-------------|
| QR | `wechat-qr-login` · `~/wechat-qr-login-module` · `:3100` |
| 桥 | `wechat-grok-bridge` · `~/wechat-grok-bridge` |
| Leader | `grok agent leader` · `data/leader.sock` |
| 代理 | 本机 xray `127.0.0.1:10808`；微信 API NO_PROXY |
| OAuth | **仅本机** `~/.grok/auth.json`（禁与 Mac 互拷） |


<!-- 以下自 .agents 入口副本合并（2026-08-22），原属「## 组件」 -->
| Context 软保活 | `wx-context-keepalive*.timer` · `scripts/wechat-context-keepalive.mjs` |
## Git 规则（second-brain）

- `~/second-brain` 的 GitHub 远端是 `github`，推送必须走 linux-lan 本机 xray：`http://127.0.0.1:10808`。
- **禁止 push 到 NAS**：`origin` 是家里 NAS 裸仓，只能作为 fetch/参考；不要执行 `git push origin ...`。
- 已在 linux-lan 固化：`remote.pushDefault=github`、`branch.main.pushRemote=github`、`remote.origin.pushurl=DISABLED-NAS-PUSH-FORBIDDEN`。
- 规则文档：`~/second-brain/90-System/docs/GIT-RULES.md`。

## 「没动静」先分三层

1. **收**：`grep inbound ~/wechat-grok-bridge/logs/bridge.log`
2. **跑**：`ps` 是否有 `grok -p` / leader；session 是否反复 `timeout after 900000ms`
3. **回**：是否 `Wechat sendmessage failed: prepare failed`

进程 active 但 2+3 红 = **假死**（不是整桥挂了）。

## 高频根因

| 症状 | 根因 | 处置 |
|------|------|------|
| `prepare failed` | context_token 过期/缺失 | 入站会写 `data/context-tokens.json`；发送链 provided→cached→no_ctx。让用户再发一条消息种 token |
| 长任务无进度 | 同上 + 旧闭包 token | 修在 bridge `sendWechatTextRetry`（已合） |
| 反复 15min 超时 | 大 sticky session | soft **2MB** 归档；必要时手动归档+改 `.session-map.json` |
| 做完了 IM 无汇报 | 回消息失败掩盖交付 | 查磁盘/`docs/QUICKSILVER-SPEED.md`/启动日志 `leader=on stream=on` |
| agent 自杀 | 任务内 restart bridge | **禁止**；仅 SSH `systemctl --user restart wechat-grok-bridge` |


<!-- 以下自 .agents 入口副本合并（2026-08-22），原属「## 高频根因」 -->
| `prepare failed` | context_token 过期/缺失 | 入站会写 `data/context-tokens.json`；发送链 provided→cached→empty_ctx→no_ctx。让用户发 `ping` / `保活` 种 token |
| 梦志未主动推送 | iLink 主动发依赖新鲜 context | `kb-dream-morning-retry` 保留 pending；用户入站刷新后 bridge 自动触发 pending 补发 |
## 标准排障命令

```bash
ssh linux-lan-pub   # 或家中 linux-lan
systemctl --user status wechat-grok-bridge wechat-qr-login --no-pager
tail -100 ~/wechat-grok-bridge/logs/bridge.log
node ~/wechat-grok-bridge/bridge.mjs --check
ps -eo pid,etime,cmd | grep -E 'bridge.mjs|grok -p|grok agent leader' | grep -v grep
# 杀卡住的 grok -p：用 PID，禁止 pkill -f 误伤 shell
cat ~/wechat-grok-bridge/workspace/.session-map.json
```

微信验收：`ping` / `健康` → `pool=` `leader=ready` `stream=on`。


<!-- 以下自 .agents 入口副本合并（2026-08-22），原属「## 标准排障命令」 -->
systemctl --user status wechat-grok-bridge wechat-qr-login wx-context-keepalive.timer wx-context-keepalive-pre.timer --no-pager
node ~/wechat-grok-bridge/scripts/wechat-context-keepalive.mjs --status
微信验收：`ping` / `健康` → `pool=` `leader=ready` `stream=on` `ctx_token_age=`；`保活` → `✓ 会话已续期`。
## Context 软保活（2026-07-31 收口）

- **边界**：iLink `context_token` 不能由脚本凭空刷新；必须由用户入站消息刷新。
- **已上机制**：`wx-context-keepalive-pre.timer` 06:45 预检；`wx-context-keepalive.timer` 12:00 / 18:00 / 21:30 检查年龄，风险高时提醒用户回 `ping` / `保活`。
- **补发机制**：若存在 `second-brain/90-System/state/pending-morning-push.json`，bridge 在新 context 入站后 debounce 触发 `dream-morning-push.mjs --pending-only --no-memory`。
- **验证口径**：`node scripts/wechat-context-keepalive.mjs --status` 显示 `risk=low`；用户回 `保活` 后 `updatedAt` 应刷新为当前时间。

## 加速能力（Hermes 水银版映射 · 已上）

- 关 wechat-bot MCP（避免每轮 ~30s `mcp_wait`）
- `GROK_LEADER=1` + `GROK_WORKER_POOL_SIZE=2`
- `WX_STREAM=1` 流式气泡
- `WX_STATUS_FIRST_SEC=12` 早期进度
- 笔记：`docs/QUICKSILVER-SPEED.md`

## 改代码后

1. 同步到 `~/wechat-grok-bridge`（或从本 SOP rsync）
2. **SSH** `systemctl --user restart wechat-grok-bridge`
3. 微信 `ping` 验收

Agent **禁止**在微信任务里 restart 本通道。

## 记忆指针

- 假死双故障：`feedback_wechat_ilink_prepare_failed_zombie`
- 项目：`project_linux_lan_wechat_grok_channel`
- SSH：`reference_linux_lan_ssh`
