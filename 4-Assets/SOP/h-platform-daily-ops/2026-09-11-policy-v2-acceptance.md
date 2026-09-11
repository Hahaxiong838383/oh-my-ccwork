# H 平台每日巡检策略 v2 接入回执

## 范围与配置

按 cc《HANDOFF-codex-巡检判读策略-v2.md》（2026-09-11 17:14 收工版）更新 Codeg Automation ID 4。
本轮只改每日任务判读与模型，不改 dev198 / Mini / 控制面生产状态，不覆盖 cc 已安装的探针。

| 字段 | 验收值 |
|---|---|
| 自动化 | 4 / H 平台每日运维巡检 / enabled=true |
| 时间 | 每天 09:10 Asia/Shanghai；下一次 2026-09-12 09:10 |
| agent / 模型 | codex / `gpt-5.6-luna` |
| cwd / isolation | `/home/hahaxiong83/mycc` / `shared_in_root` |
| 模型字段 | `config.config_values.model`，不是顶层 model 或单纯 prompt 文案 |
| 其他配置 | cron、timezone、root_folder_id、branch、mode_id 等保持原值 |

Codeg 的实时模型列表提供 `gpt-5.6-luna` / `GPT-5.6-Luna`。旧任务 config_values 为空，
2026-09-11 09:10 的 run 15 实际继承 `gpt-6-astra`；本轮通过正式 automation_update API 显式锁 Luna，
随后 automation_get 逐字段回读。未直接写 SQLite。

Prompt（去末尾换行）SHA256：`59536c6c434722eb3f56a65f5745b659852ecde03f4a37871c33003293602f0c`。

## 判读变化

- 每轮直接召回 A canonical 本机副本中的四个稳定键；B 镜像不跨机同步，只作历史参考。
- 先看 schemaVersion / checkedAt，再看 levels / issues.details；非零退出但新鲜的 critical 报告仍判读，过期报告不得冒充当前。
- warning / info 不包装成平台故障；同版本 release drifted 是明确升级例外；已知测试用例不建议覆盖。
- 年龄、责任方、真实 Bot 身份分开报告；孤儿数扣除 live，liveUnknown 保留未知。
- egress 与飞书连接分别判读；同出口保活告警合并归因，不从单个出口推断未覆盖站点/引擎。
- 基线更新为 v1.67.0、18/18 Bot、17/17 记忆、待办1与合法个性化4人6项；仅用于对比，不作为永恒数量阈值。
- 只运行既有 daily-readonly-check 一次；不自动补签、部署、重启、覆盖、重放或外发。

## 运行时保护

探针真源已迁到 feishu-grok-bridge 仓 `ops/home-studio/`。mycc 同目录旧脚本是 v1 历史快照，
不能拿它们重新安装。本轮运行时文件指纹（验收前后相同，未改动）：

- wrapper：`ae2a62c7edc7655cabc7ddb66fce3210031741d9d984cf970b5317012882285f`
- checker：`e55ed742a99483765f2ec295fabdbfccf90573edbd4cf2474c10c58c77191277`

Codeg 是唯一时钟，同名 systemd timer 保持 disabled。代码资产在最新 origin/main 的稀疏 worktree 修改，
不 stash、不提交其他 session 在主 checkout 的改动；主 checkout 分叉状态不在本轮收口范围。

## 验收记录

- 现役 v2 checker 离线自检：12/12 通过（不联网）。
- 仓库离线契约：17/17 通过（v1 归档5项 + v2策略静态12项）；git diff --check 通过。
- Prompt 经独立只读复核：附件全部 code、等级例外、记忆召回、只读边界均已覆盖。
- 正式实跑：run 16 / conversation 51，2026-09-11 18:57:19 → 18:59:33 CST，succeeded / end_turn / 无执行错误。
- 模型双锚：API conversation.summary.model 与 Codex rollout turn_context.model 均为 `gpt-5.6-luna`。
- 四个 A 文件均实际读取，项目记忆包含 09-11 收工与后续纠正；wrapper 恰好一次，history.jsonl 行数 23 → 24。
- checkedAt=2026-09-11T10:58:55Z，schemaVersion=2、serviceExit=0；本轮新鲜报告，不是旧 latest.json。
- 原始结果 WARNING：critical=0 / warning=1 / info=2。唯一 warning 为 `陈川测试bot/agent-method`，Luna 正确标“已知测试用例”，未建议覆盖。
- info：恢复候选 total=1 / live=0 / liveUnknown=0，compute=1，确认未运行1项，留给人工决定；合法个性化4人6项，保留。
- 控制面 v1.67.0 / in_sync / mismatch0，releaseId 与收工基线一致；18/18 connected，egressOk=true；记忆17/17、bad0；RPC孤儿0。
- 完整执行轨迹只有本机读取和一次 wrapper，没有另发 SSH、生产修复、仓库写入或外部消息；主 checkout 的 `git status --porcelain=v1 -z` SHA256 前后同为 `18aa03a751f8e797eca894609e030117f993712d8532dc83fadd82afff8fd057`（证明状态清单未变，不当作全仓字节证明）。
- 证据：本机 Codex 会话 `01a0901d-60a9-7c30-8a16-b95f7f3a5622`，2026/09/11 rollout；签名分钟显示18:58，真实任务完成时间以API的18:59:33为准。

凭据只在本机程序内读取，未打印、未进入 argv 或 Git。原任务配置备份在本机临时验收目录，
版本化旧 Prompt 可从父提交恢复；回滚自动化仍须走正式 API 并回读，不改 SQLite。

署名：codex（OpenAI）| 2026-09-11 19:01（Asia/Shanghai）
