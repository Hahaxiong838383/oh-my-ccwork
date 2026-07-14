# CPA K12 账号池运维

> 更新：2026-07-14  
> 节点：`aliyun-jp` / CLIProxyAPI `cliproxy.service`  
> 目标：在 **无 refresh_token** 的前提下，让 CPA 上始终保留可用的 k12 codex 账号。

## 结论（先看这个）

| 项 | 现状 |
|---|---|
| 源包 | `sub2api_20260714_验活_80500个 k12_...json`（本地 `Documents/陈川个人站/`） |
| refresh_token | **整包 80500 全无**，无法 OAuth 自动续期 |
| 保活机制 | **验活 → 删死号 → 从备用池补号**（不是 refresh） |
| 可用模型（k12） | `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` |
| 不可用/未接 | `gpt-5.3-codex`、`gpt-5.2` 在 CPA 侧 `unknown provider`；`gpt-5.6-*` 走 Team |
| 生产 auth-dir | `/root/.cli-proxy-api` |
| k12 文件前缀 | `zz-test-k12-*.json`（`type=codex`） |
| 2026-07-14 筛后在线 | **33 个 k12 活号** + 正式 Team Codex + xAI |
| 备用池 | `/opt/cliproxy/k12-pool`（约 200） |
| 状态/报告 | `/opt/cliproxy/k12-state/last-report.json` |
| 定时器 | `cpa-k12-health.timer` 每 30 分钟 |

## 目录与组件

| 路径 | 作用 |
|---|---|
| `/root/.cli-proxy-api/zz-test-k12-*.json` | 当前参与调度的 k12 账号 |
| `/root/.cli-proxy-api/codex-*-team.json` | 正式 Team（必须保留） |
| `/opt/cliproxy/k12-pool/pool-*.json` | 备用池 |
| `/opt/cliproxy/k12-state/` | 报告、历史、脱敏 tombstone |
| `/opt/cliproxy/scripts/k12-health-rotate.py` | 验活+轮换脚本（仓库副本见 `scripts/`） |
| `deploy/cpa-k12-health.service` / `.timer` | systemd 单元 |

## 运维命令

```bash
# 只检查不改动
ssh aliyun-jp 'python3 /opt/cliproxy/scripts/k12-health-rotate.py --check-only --target 25'

# 验活 + 清理死号 + 从池补到 25
ssh aliyun-jp 'python3 /opt/cliproxy/scripts/k12-health-rotate.py --target 25'

# 看最近报告
ssh aliyun-jp 'python3 -m json.tool /opt/cliproxy/k12-state/last-report.json | head -80'

# 定时器
ssh aliyun-jp 'systemctl status cpa-k12-health.timer --no-pager'
```

## 导入规则

1. 优先源文件**前面几百～两千**（`cdk-files-14` 验活区更稳；`generated-natural-80k` 大量 401）。
2. 转 CPA 格式字段：`type=codex`、`email`、`account_id`、`access_token`、`id_token`、`expired`、`last_refresh`、`disabled`。
3. 文件名：`zz-test-k12-{序号}-{email}.json`。
4. **禁止**提交 token / 账号文件进 git。
5. 导入后必须跑 `k12-health-rotate.py`，只保留验活通过的。

## 安全

- 不把 access_token / API key 写入记忆、飞书、git。
- tombstone 归档会脱敏 token 正文。
- 正式 Team 与 xAI 账号不要用本脚本删除（脚本只匹配 `zz-test-k12-` 前缀）。

## 与 smart-router 的关系

- k12 与 Team 都在 CLIProxyAPI `auth-dir` 混池；`api-direct.hahaxiong.top` 与 `smart-api.hahaxiong.top` 最终都可能落到这些 auth。
- smart-router 的 provider 前缀候选（`ccsub2/`、`gw1052/`）是另一条上游兼容链，和 k12 file-auth 不是同一层。
