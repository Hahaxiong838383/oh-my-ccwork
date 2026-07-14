# AI Ops Grok · CPA K12 号池运维 Harness

> 给 ops.hahaxiong.top 上的 Grok / 项目页使用。  
> **禁止**读取、外发、回显任何 access_token / API key / OAuth 原文。

## 你能做什么

通过 CPA 项目生产维护通道（限权 SSH forced command）执行：

| 动作 | 确认词 | 作用 |
|---|---|---|
| `inspect` | 无 | 服务/端口/模型列表/低成本对话探测（脱敏） |
| `k12-status` | 无 | 当前 k12 号数量、邮箱列表、备用池/大源是否就绪、上次轮换摘要 |
| `k12-rotate` | `ROTATE_CPA_K12` | 验活 → 删死号 → 从小池/大源**随机**抽号补到目标（默认 25） |
| `restart-cliproxy` | `RESTART_CPA_CORE` | 重启 CPA 核心（慎用） |
| `restart-router` | `RESTART_CPA_ROUTER` | 重启 Smart Router（慎用） |

页面入口：`/vibe/project?id=cpa-smart-router`  
生产 API：`/vibe/project/production/action`

## 日常自治策略（推荐）

1. **先 `k12-status`**：看 `k12.count`、`source.exists`、`poolRemaining`、`lastReport`。
2. 若 `k12.count < 20` 或 `lastReport` 显示大量 removed / 对话探测不稳：
   - 触发 **`k12-rotate`**，确认词 `ROTATE_CPA_K12`。
3. 轮换后再 `inspect`：确认 `cliproxy` active、`directChat`/`smartChat` 为 ok（若通道返回这些字段）。
4. **不要**为了“多一点号”无脑 rotate；默认目标 25，活号够用就停。
5. **不要**要求打开 `/opt/cliproxy/k12-source/accounts.json`；该文件仅 root 脚本可读，含全量 token。

## 机制说明（必须理解）

- 源包 **无 refresh_token**，不能 OAuth 续期。
- 保活 = **验活剔除 + 随机补号**。
- 生产可流式大源：`/opt/cliproxy/k12-source/accounts.ndjson`（约 1 万候选，NDJSON）。
- 全量 8 万备份只在 racknerd secrets，**永不**被 Grok 读取，也**不要**在 1GB 日本机上 `json.load`。
- 已用邮箱记入 `used-emails.json` 避免短时间重复抽死号。
- 定时器 `cpa-k12-health.timer` 每 30 分钟自动跑；Grok 侧按 `k12-status` 判断后按需 `k12-rotate`。

## 安全边界

- 只读 allowlist 可见：运维文档、脚本源码、systemd 单元模板。
- **不可见**：真实 auth 文件、大源 JSON、env、sqlite、API key。
- 飞书通知只允许：项目、动作、ok/失败、数量、耗时、入口；禁止 token/邮箱批量外发（状态接口里邮箱仅给运维页，通知文案仍按 AI Ops 脱敏规则）。

## 验收清单

- [ ] `k12-status` 返回 `source.exists=true` 且 `k12.count` 为数字
- [ ] `k12-rotate` 需确认词，成功后 `after_total_k12` ≥ 目标或说明大源探针耗尽
- [ ] `inspect` 仍可用；任意 shell / 读 secret 仍被拒绝
- [ ] vibe 回归 `OK vibe regression` 不破坏 Grok 主按钮
