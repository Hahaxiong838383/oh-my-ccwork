# CPA K12 账号池运维

> 更新：2026-07-27  
> 节点：`aliyun-jp` / CLIProxyAPI `cliproxy.service`  
> 目标：在 **无 refresh_token** 的前提下，让 CPA 上始终保留可用的 k12 codex 账号。

## 结论（先看这个）

| 项 | 现状 |
|---|---|
| 源包（生产抽样） | `aliyun-jp:/opt/cliproxy/k12-source/accounts.ndjson`（约 1 万条可流式读取，root 600） |
| 全量备份 | `racknerd:/opt/ai-ops-cockpit/secrets/cpa-k12-source/accounts.json`（216MB，**不进 Grok 只读**） |
| 机器限制 | 日本 SWAS **仅 1GB 内存**；禁止整包 `json.load` 80500 条，否则会 OOM 挂死 sshd/CPA |
| refresh_token | **整包 80500 全无**，无法 OAuth 自动续期 |
| 保活机制 | **验活 → 删死号 → 小池/大源随机补号**（不是 refresh） |
| AI Ops 动作 | `k12-status` / `k12-rotate`（确认词 `ROTATE_CPA_K12`） |
| Grok harness | `docs/aiops-k12-grok-harness.md` |
| 可用模型（k12） | `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` |
| **gpt-5.5 路由** | **优先 k12**（auth `priority: 100`）；Team `priority: 10` 作兜底 |
| 路由策略 | `routing.strategy: fill-first` + `session-affinity: true` |
| 图生冲突 | `disable-image-generation: "chat"`（避免 Codex `image_gen.imagegen` 与 hosted 工具冲突） |
| 生产 auth-dir | `/root/.cli-proxy-api` |
| k12 文件前缀 | `zz-test-k12-*.json`（`type=codex`） |
| 备用池 | `/opt/cliproxy/k12-pool` |
| 状态/报告 | `/opt/cliproxy/k12-state/last-report.json` |
| 定时器 | `cpa-k12-health.timer` 每 30 分钟 |
| 2026-07-27 生产状态 | 激活 k12=0；`k12-pool`=0；生产抽样源 `accounts.ndjson` 仍有 10000 条但 JWT 已全过期；定时轮换只能产出 `after_total_k12=0` |
| Codex Plus 自动刷新 | 正式 Codex OAuth 授权带 `refresh_token` 时，由 CLIProxyAPI `auth-auto-refresh-workers: 16` 自动刷新；K12 源包无 `refresh_token`，不适用 |

## gpt-5.5 优先 k12（2026-07-14 川哥确认测试 OK）

> 2026-07-27 注意：该策略只有在 `zz-test-k12-*.json` 实际存在且验活通过时才成立。当前生产激活 k12 为 0，`gpt-5.5` 实际由正式 Codex Plus OAuth 混池承载。

| auth | priority | 说明 |
|---|---|---|
| `zz-test-k12-*.json` | **100** | 选 `gpt-5.5` 时先绑 k12 |
| Team `codex-*-team.json` | **10** | k12 全不可用时再兜底；**不**写 `excluded-models`（避免 5.5 无兜底） |
| `gpt-5.6-*` | — | 仍主要走 Team（k12 卡面不带 5.6） |

改 priority 后需 **重启 cliproxy** 清 session-affinity；客户端 **新开 Codex 会话**。

```bash
# 查看当前 priority（不打印 token）
ssh aliyun-jp 'python3 -c "
import json; from pathlib import Path
a=Path(\"/root/.cli-proxy-api\")
for p in list(a.glob(\"codex-*-team.json\"))+sorted(a.glob(\"zz-test-k12-*.json\"))[:1]:
 d=json.loads(p.read_text()); print(p.name, d.get(\"priority\"), d.get(\"excluded-models\"))
"'
```

## 目录与组件

| 路径 | 作用 |
|---|---|
| `/root/.cli-proxy-api/zz-test-k12-*.json` | 当前参与调度的 k12 账号 |
| `/root/.cli-proxy-api/codex-*-team.json` | 正式 Team（必须保留） |
| `/opt/cliproxy/k12-source/accounts.json` | 大源（token，禁止进 git/Grok） |
| `/opt/cliproxy/k12-pool/pool-*.json` | 小备用池 |
| `/opt/cliproxy/k12-state/` | 报告、历史、used-emails、脱敏 tombstone |
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
- 清理失效 Team/Plus 授权时只移动整个 auth 文件到禁用目录并重启 `cliproxy.service`；不要打印、复制或记录文件内 token。
- 判断“自动刷新是否可用”只看布尔事实：auth 是否存在 `refresh_token`、服务日志是否启动 core auth auto-refresh、低成本模型请求是否 200；不要把 token 正文带出服务器。

## 与 smart-router 的关系

- k12 与 Team 都在 CLIProxyAPI `auth-dir` 混池；`api-direct.hahaxiong.top` 与 `smart-api.hahaxiong.top` 最终都可能落到这些 auth。
- smart-router 的 provider 前缀候选（`ccsub2/`、`gw1052/`）是另一条上游兼容链，和 k12 file-auth 不是同一层。
