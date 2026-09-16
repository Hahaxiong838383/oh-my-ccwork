# H 平台每日巡检条件门控验收｜2026-09-16

## 结果

已安装并完成真实采集、同快照报告复验和唯一时钟验收。每天由脚本采集一次，平稳日零模型调用、零新会话；变化或恢复、严重、未知、失败时由 Luna 解读，未变化且仍需人工处理的待办每 7 天提醒。没有修改生产服务、补签、重启、覆盖租户或外发消息。

| 配置 | 已核实状态 |
|---|---|
| Codeg ID4 | `manual`，`cron=null`，`next_run_at=null`，enabled |
| agent / model | `codex` / `gpt-5.6-luna`，字段 `config.config_values.model` |
| workspace | `/home/hahaxiong83/.local/share/h-platform-daily-ops/workspace` |
| root / isolation | `root_folder_id=23` / `shared_in_root` |
| 唯一每日时钟 | `h-platform-daily-gate.timer`，09:10 Asia/Shanghai，`Persistent=true` |
| 新 timer | `enabled / active / waiting`，下次 `2026-09-17 09:10 CST` |
| 旧 timer | `h-platform-daily-ops.timer`，`disabled / inactive` |
| 用户服务驻留 | `Linger=yes` |

## 测试与运行证据

- **106 项离线测试通过**，含已知测试例外与其他待办共存的日报渲染测试；runtime 与版本化源 hash 全部一致。
- bridge 仓维护的现役 v2 wrapper **未变**，没有用本目录 v1 归档覆盖 runtime。
- 真实采集 history **29 → 30**，仅采集一次。首次 `run22/session62` succeeded；报告修订后的复验只消费同一快照，history 仍为 **30**。
- 最终 `run23/session63` succeeded。rollout 核实实际模型为 `gpt-5.6-luna`，唯一工具读取是一次 `cat CURRENT.json`；模型没有再次采集或 SSH。

| 指标 | 旧日报 run21/session61 | 首轮 run22/session62 | 验收轮 run23/session63 |
|---|---:|---:|---:|
| 模型任务耗时（秒） | 159.111 | 45.325 | 57.792 |
| 累计 token | 687282 | 38910 | 40302 |
| 非缓存输入 | 85165 | 21281 | 24407 |
| 缓存输入 | 596992 | 15872 | 13056 |
| 输出 | 5125 | 1757 | 2839 |

验收轮累计 token 比旧样本约少 **94.1%**，模型任务耗时约少 **63.7%**。累计 token 含缓存，不等于费用或单次上下文长度；这是一轮实测，不是固定收益承诺。

## 报告语义纠正

首次任务执行成功，但报告把已确认的测试例外写成“需人工核实”；因此技术 succeeded 不等于语义验收通过。仅强化精简 prompt 后，用同一快照复验，未新增采集。

最终报告明确：精确匹配 `u-001422f6e5 / 陈川测试bot / agent-method` 的空壳是已知测试用例，保留、无需追平；`stopped by user` 本身不能证明故障。其他真实待办仍单列，不能因存在测试例外而全部静默。

## 记忆、状态与报告边界

每日由脚本直接核对 A canonical 本机副本的四源：`project_feishu_grok_h_byos`、`feedback_tenant_capability_drift_mechanism`、`feedback_identifier_shape_is_not_identity`、`feedback_concurrent_sessions_shared_checkout`。来源目录为 `/home/hahaxiong83/.claude/projects/-home-hahaxiong83-mycc/memory/`，不以旧 B 镜像替代。

脚本算全文 hash，模型只收尾部有界摘录（平台约 3800 字符，其余各约 1600 字符）和来源、mtime、行号、截断标记，**不能声称模型读过四份全文**。源变化会触发；若截断使变更覆盖未确认，明确标未知，不猜新结论。配置、模型或调度失败不推进成功比较基线，保留重试标记；这指门控状态，不是 Git 提交。

独立 workspace 的 `latest.md` 为最新报告，`index.md` 汇总最近 30 次按日记录，`daily/YYYY-MM/` 保留每日汇总，`runs/<runKey>/` 保留逐轮输入/报告及成功 AI 结果，`CURRENT.json` 只供当前解读。**30 次是索引长度，不是删除期限；原 Codeg 会话、日报与证据不删除。** 模型只回复，文件由固定脚本保存。

## 时钟首次初始化与并发保护

13:35:40，在真实手工验收完成后，为原本不存在 stamp 的新 timer 初始化一次持久化时间戳，再 `enable --now`。这是记录本次已完成验收的首次初始化，**不是声称 timer 此前真正触发过**。启用后下次为次日 09:10，未额外补采。保留 `Persistent=true` 用于未来漏跑补执行；**禁止每天刷新 stamp**，否则会吞掉真实漏跑。

代码变更使用隔离 worktree `/tmp/mycc-h-daily-v2-sparse.qmyCOA`，不替其他 session 提交在途工作、不全量 stash/reset。安装器通过正式 API 与完整 AutomationDraft 保存原态、更新并回读，不直写 SQLite；回滚发现 ID4 已有他人修改则停止，不拿旧备份覆盖。回滚不删报告或会话。

原计划的 `0-System` 落点是仓内 symlink，隔离 worktree 中指向不存在的 `/tmp/.mycc-global/0-System`；本轮未替换 symlink、未写 global 仓，回执落在本资产目录随 mycc 版本化。

署名：codex（OpenAI）| 2026-09-16（最终验收记录）
