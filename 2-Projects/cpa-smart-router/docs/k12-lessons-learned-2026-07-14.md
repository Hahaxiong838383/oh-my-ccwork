# CPA K12 号池 · 经验教训与踩坑（2026-07-14）

> 三引擎共享：本文件在仓库 allowlist 内，AI Ops Grok 可读。不含 token。

## 一句话

**无 refresh_token 的号池 = 验活 + 随机补号；小内存机绝对禁止整包加载大 JSON。**

---

## 踩坑清单（按代价排序）

### 1. 1GB 机器 + 216MB JSON = OOM 全站挂死（P0）

| | |
|---|---|
| **现象** | SSH banner 超时、CPA 公网连不上、Cloud Assistant 也 Aborted |
| **根因** | 日本 SWAS 仅 **1GB RAM**；`json.load` 80500 条约 216MB 文件，Python 常占 1GB+ |
| **处理** | SWAS `reboot-instance` 恢复；全量 JSON 改名 `*.OFFLINE_DO_NOT_LOAD`；生产改用 **NDJSON 流式**（约 1 万条 / 20MB） |
| **铁律** | 小内存生产机：**禁止**整包 `json.load` 号源；只用 NDJSON / 分片 / 预抽样 |

### 2. 「有 refresh」是错觉

| | |
|---|---|
| **事实** | 80500 条 sub2 导出 **refresh_token 全是空** |
| **后果** | 不能 OAuth 自动续期；过期只能换号 |
| **正确机制** | 验活剔除死号 → 小池补 → 大源随机抽 → `used-emails` 防短时重复 |

### 3. 文件名写「验活」≠ 全都能用

| | |
|---|---|
| **数据** | 试灌 70 个 → **33 活 / 37 死**（多 `responses_401`） |
| **源质量** | `cdk-files-14`（靠前）明显优于 `generated-natural-80k` |
| **铁律** | 禁止整包盲灌；导入后必须 health-rotate；优先前面几百～两千 |

### 4. 卡面 model_mapping ≠ CPA 路由表

| 模型 | 卡面 | CPA 实测 |
|---|---|---|
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` | 有 | **可用** |
| `gpt-5.3-codex` / `gpt-5.2` | 有 | **502 unknown provider**（需 alias） |
| `gpt-5.6-*` | 无 | 走 **Team**，别指望 k12 |

### 5. 混跑日志里的「auth unavailable」

| | |
|---|---|
| **现象** | session-affinity 连续 reselected 多个 k12 后才 200 |
| **含义** | 池里有死号/冷却号，靠 failover 顶住；不是「全都能打」 |
| **做法** | 定期 rotate 清死号；目标活号数（如 25）留余量 |

### 6. AI Ops 安全边界不能破

| | |
|---|---|
| **对** | Grok 只触发 `k12-status` / `k12-rotate`；只读 allowlist 文档+脚本 |
| **错** | 把全量号源挂进 `/workspace/readonly`；飞书/任务回传 token |
| **落点** | 全量只放 `racknerd secrets/`；生产只放 NDJSON；报告脱敏 |

### 7. SSH 卡死时的恢复路径

| 顺序 | 动作 |
|---|---|
| 1 | 公网 401/超时 + 本机 SSH banner 超时 → 怀疑 OOM |
| 2 | `aliyun swas-open reboot-instance`（intl-jp / ap-northeast-1） |
| 3 | 若长期 Stopping → 等 Running，必要时 force stop/start |
| 4 | 恢复后先 `free -m` + 确认 cliproxy，**不要**再 load 大 JSON |

---

## 可复用经验

1. **先规模评估再上生产**：机型内存、单文件大小、JSON 解析倍数。
2. **先小样本验收**（5 → 15 → 50），再谈批量与自治。
3. **保活脚本要分三级源**：在线 auth → 小池 → 大源流式；每级都 probe。
4. **限权维护通道模式可复用**：forced command + 精确 sudoers + 确认词 + 脱敏 sanitize。
5. **文档双写**：运维 SOP（`k12-auth-pool-ops.md`）+ Grok harness（`aiops-k12-grok-harness.md`）+ skill 索引。

---

## 当前生产口径（落盘时）

- k12 前缀：`zz-test-k12-*.json` @ `/root/.cli-proxy-api`
- 脚本：`/opt/cliproxy/scripts/k12-health-rotate.py`
- 定时：`cpa-k12-health.timer` 每 30 分钟
- AI Ops：`k12-status` / `k12-rotate`（`ROTATE_CPA_K12`）
- 入口：`/vibe/project?id=cpa-smart-router`

---

## 相关路径

| 类型 | 路径 |
|---|---|
| 仓库脚本 | `2-Projects/cpa-smart-router/scripts/k12-health-rotate.py` |
| 运维 SOP | `docs/k12-auth-pool-ops.md` |
| Grok harness | `docs/aiops-k12-grok-harness.md` |
| systemd | `deploy/cpa-k12-health.service` / `.timer` |
| AI Ops 通道 | `2-Projects/ai-ops-cockpit/scripts/install-cpa-jp-maintenance-channel.sh` |
