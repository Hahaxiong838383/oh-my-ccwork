# P1-SI cc 选择性提交交接

日期：2026-08-11（Asia/Shanghai）

状态：`engineering_verified / runtime_updated / pending_cc_selective_commit`

## 1. 结论

P1-SI-B～G 工程代码和不可变 Artifact 已在前序提交中完成。Artifact `9108034290` 已更新为公司 QNAP 当前内部 Runtime并完成首次内部 Collector。本次新增实机更新/运行 Evidence，同时修复 Shadow Compose、内部部署和生产部署中错误的 Foundation 网络默认名，并增加对应回归测试。

Goal 7 P1-AUTHORITY/P1-RUNTIME 未部署工程候选也已进入同一待提交集合：实际发送者唯一主体、多人艾特不扩权、私聊隔离、60 秒群成员 Evidence、用途收窄、会话授权快照、Route A 熔断、有限重试、预算、完整 provider/model/usage 读回、无正文 Postgres 用量账本和 Route B disabled。复核后补强了两处地基：空/不自洽 usage 失败关闭；模型已消耗后触发预算拒绝仍记录 `budget_blocked`，不形成成本盲区。012 隔离验证同时要求真实 `ontology_app` 角色完成四类候选表读写。

正式 Foundation 部署候选也已补齐但未执行：`validate-goal7-runtime-release.mjs` 在任何迁移或服务切换前重算完整 `SHA256SUMS`、六项内部 Evidence/Archive Hash 与 Release Manifest；`GOAL7_APPROVED_SOURCE_COMMIT`、`GOAL7_APPROVED_H_LITE_SOURCE_COMMIT` 将当次授权精确绑定双仓 Commit。部署只逐个切换 Agent Core、Knowledge Connector、H-Lite，强制 `KNOWLEDGE_SYNC_ON_START=0`；失败自动恢复旧配置和旧镜像，012 作为 additive migration 明确保留。部署、显式回滚仍分别需要独立授权。

进一步复核后，原部署脚本把 012 和三个服务重建包含在同一个发布授权中，不满足当前治理边界；后续又确认 012 已由历史流程落库，原始 B 阶段 Evidence 缺失。现行门禁为 `GOAL7_DEPLOY_APPROVED`、`GOAL7_MIGRATION_012_RECONCILIATION_APPROVED`、`GOAL7_SERVICE_RECREATION_APPROVED`，B 阶段只能只读对账并证明 `database_sql_executed=0`；真实回滚继续由第四个独立授权控制。新增机器发布计划和运行手册，固定维护窗口预计 8～20 分钟、员工可感知间歇中断 15～120 秒、回滚 2～6 分钟，并验证影响范围不能扩大到 Postgres、Redis、Qdrant、Registry、Gateway 等服务。

四角色 UAT 原验收文件也存在同类问题：可以直接把十项布尔值手填为 `true`。现已升级为 `2.0.0` 编译产物，必须由四个不同真实成员的 Session 文件和一份安全负责人接受记录生成；安全负责人接受记录绑定四份 Session SHA-256，任何 Session 篡改、同一成员代测、提前接受或手改最终 JSON 都失败关闭。

最新复核进一步关闭了 Goal 7 的两处“配置标签冒充真实运行”风险。第一，真实 H Worker 读回必须由 H-Lite 正式 Agent Core Adapter 发起固定合成请求，再读取 Postgres 中同 request 的唯一 usage ledger 行；HTTP 与 ledger 的双仓 Commit、request Hash、provider、model、credential mode、token、费用、重试和 Route 必须一致，最终 `worker-readback.json` 只能由两份脱敏原始证据编译。第二，Goal 7 Owner Acceptance 不再允许手填：受控记录器必须先重验 Runtime、Worker、Authority Canary、Deployment 四份工程 Evidence，再绑定其 SHA-256、双仓 Commit、接受时间和脱敏 Owner Principal Hash。

本轮另新增两份 Git-safe、无实名、仅供人工参考的审核建议稿：来源建议为 3 条窄范围 Shadow 批准候选 + 5 条继续暂停；P003 建议为 4 条条件性激活提案候选、11 条拒绝和 21 条保持 inactive。建议稿不替代任何实名人工决定，也不改变当前 `0/8`、`0/36` 门禁状态。

当前协作规则下 Git 提交权由 cc 收口。本次包含 Runtime 配置与 Goal 7 候选代码；提交后应运行 Runtime Workflow 生成包含 `company_ai_data` 修复及 Goal 7 PostgreSQL 17 Evidence 的新 Artifact，但不得自动替换当前 QNAP Runtime、运行 Collector、迁移生产数据库、部署 Agent Core/Knowledge Connector、启动生产 Shadow 或重启 Foundation。

## 2. 允许纳入本次提交的范围

1. `.claude/skills/company-ai-ontology/SKILL.md`；
2. `0-System/RECENT_EVENTS.md`；
3. `0-System/memory-items.md`；
4. `2-Projects/company-ai-ontology/` 下本轮 Runtime 更新证据、授权包、审计、README、TODO、方案和经验文件。
5. `.github/workflows/p1-si-runtime-verify.yml`。

本轮新增审核建议文件：

- `docs/p1-si-source-review-recommendations-2026-08-11.md`；
- `docs/p1-si-p003-review-recommendations-2026-08-11.md`。

本轮新增 Goal 7 Foundation 发布门禁文件：

- `deploy/qnap/strategic-intelligence/scripts/goal7-runtime-release-lib.mjs`；
- `deploy/qnap/strategic-intelligence/scripts/validate-goal7-runtime-release.mjs`；
- `deploy/qnap/strategic-intelligence/scripts/capture-goal7-deployment-state.sh`；
- `deploy/qnap/strategic-intelligence/scripts/deploy-goal7-foundation.sh`；
- `deploy/qnap/strategic-intelligence/scripts/rollback-goal7-foundation.sh`；
- `deploy/qnap/strategic-intelligence/scripts/goal7-deployment-lib.mjs`；
- `deploy/qnap/strategic-intelligence/scripts/compile-goal7-deployment-evidence.mjs`；
- `deploy/qnap/strategic-intelligence/test/goal7-foundation-deployment.test.mjs`；
- `deploy/qnap/strategic-intelligence/test/goal7-deployment-evidence.test.mjs`。
- `deploy/qnap/strategic-intelligence/config/goal7-foundation-release-plan.json`；
- `deploy/qnap/strategic-intelligence/schemas/goal7-foundation-release-plan.schema.json`；
- `deploy/qnap/strategic-intelligence/scripts/goal7-release-plan-lib.mjs`；
- `deploy/qnap/strategic-intelligence/scripts/validate-goal7-release-plan.mjs`；
- `deploy/qnap/strategic-intelligence/test/goal7-release-plan.test.mjs`；
- `docs/goal7-foundation-release-runbook-2026-08-11.md`。
- `deploy/qnap/strategic-intelligence/schemas/reviewer-role-member-session.schema.json`；
- `deploy/qnap/strategic-intelligence/schemas/reviewer-role-security-owner-acceptance.schema.json`；
- `deploy/qnap/strategic-intelligence/scripts/reviewer-role-access-lib.mjs`；
- `deploy/qnap/strategic-intelligence/scripts/compile-reviewer-role-access-acceptance.mjs`；
- `deploy/qnap/strategic-intelligence/test/reviewer-role-access-evidence.test.mjs`。

本轮新增 H Worker 双源读回与受控 Owner Acceptance 文件：

- `deploy/qnap/scripts/run-goal7-worker-readback.sh`；
- `deploy/qnap/canary/goal7-worker-readback-seed.sql`；
- `deploy/qnap/canary/goal7-worker-readback-ledger.sql`；
- `deploy/qnap/canary/goal7-worker-readback-cleanup.sql`；
- `deploy/qnap/strategic-intelligence/schemas/goal7-worker-http-response.schema.json`；
- `deploy/qnap/strategic-intelligence/schemas/goal7-worker-ledger-row.schema.json`；
- `deploy/qnap/strategic-intelligence/schemas/goal7-worker-readback.schema.json`；
- `deploy/qnap/strategic-intelligence/config/goal7-worker-readback.template.json`；
- `deploy/qnap/strategic-intelligence/scripts/goal7-worker-readback-lib.mjs`；
- `deploy/qnap/strategic-intelligence/scripts/compile-goal7-worker-readback.mjs`；
- `deploy/qnap/strategic-intelligence/scripts/validate-goal7-worker-readback.mjs`；
- `deploy/qnap/strategic-intelligence/test/goal7-worker-readback.test.mjs`；
- `deploy/qnap/strategic-intelligence/schemas/goal7-owner-acceptance.schema.json`；
- `deploy/qnap/strategic-intelligence/config/goal7-owner-acceptance.template.json`；
- `deploy/qnap/strategic-intelligence/scripts/record-goal7-owner-acceptance.mjs`；
- `deploy/qnap/strategic-intelligence/test/goal7-owner-acceptance.test.mjs`；
- `deploy/qnap/strategic-intelligence/scripts/goal7-evidence-lib.mjs`；
- `deploy/qnap/strategic-intelligence/package.json`；
- `deploy/qnap/strategic-intelligence/scripts/validate-shadow-package.mjs`；
- `deploy/qnap/strategic-intelligence/README.md`；
- `docs/goal7-foundation-release-runbook-2026-08-11.md`；
- `docs/p1-si-bh-completion-audit-2026-08-11.md`；
- `docs/next-todos.md`；
- `docs/p1-si-cc-selective-commit-handoff-2026-08-11.md`。

明确排除：

- `.claude/launch.json`；
- `.claude/skills/evomap-assets/`；
- `.claude/skills/kidshub-growth-insight/`；
- `.claude/skills/mycc/current.json`；
- `.claude/skills/scheduler/history.md`；
- `.claude/skills/xray/`；
- `2-Projects/kidshub-growth-insight/`；
- `2-Projects/ai-engineering-briefs/`；
- `2-Projects/geo-engine/`；
- `0-System/status.md` 自动刷新文件；
- 其他不属于 P1-SI 的并发脏文件。

## 3. 提交前复核

- Ontology Contracts：`61/61`；
- Agent Core：`63/63`；
- Knowledge Connector：`18/18`；
- Collector：`9/9`；
- Strategic Intelligence：`114/114`；
- Node、Shell、YAML、JSON 语法与 `git diff --check` 通过；
- Artifact `9108034290` 已更新为内部 Runtime，更新前后 Foundation `13/13 running / unhealthy=0 / restart=0`、指纹一致；
- 旧 `a7aeae25e` 备份非空、tar 可读、package/config/env 齐全且 SHA-256 通过；
- 首次真实 Collector：3 来源各 20 条、总计 60 条、Hash-only、正文 0、重复 0，Evidence accepted；
- Foundation 13/13、异常 0、restart 0、指纹一致，运行后战略情报容器/网络/端口归零，五类业务副作用为 0；
- 网络默认值回归证明 Foundation Compose、Shadow Compose、env、内部部署和生产部署统一使用 `company_ai_data`；
- 正式 readiness `0/7`、Goal Completion `0/8`，继续失败关闭；本轮未连接、迁移、部署或重启公司 QNAP。

建议提交信息：

```text
feat(ontology): add Goal 7 authority runtime foundation
```

## 4. 推送后执行

推送后运行 Runtime Workflow，确认 010/011/012、Goal 7 四表 4/4 强制 RLS、真实 `ontology_app` 读写、Route B disabled、既有 19/19 RLS、Domain 幂等、ACL、baseline restore、Artifact Hash 和全量回归全部通过。新 Artifact 只作为后续生产门禁完成后的发布候选，不自动部署。

## 5. 提交后仍关闭

1. 8 个来源最终审批；
2. 36 条 P003 最终审核；
3. 四角色真实成员权限 UAT；
4. 受控 Goal 7 Owner Acceptance 的真实确认和 Evidence 记录；
5. 真实 H Worker 双源读回与飞书合成部门/群聊/私聊/撤权 Canary；
6. 012 候选迁移、Agent Core/Knowledge Connector 部署、生产数据库和服务动作的分别授权；
7. 七个真实上海自然日 `PUBLISH=false` Shadow；
8. 川哥第七日 Owner Acceptance。

## 6. H-Lite 群聊授权闭环补充

本轮已修复此前代码审计发现的真实运行阻断：`company-qnap-lite` 不再只传平铺 `chatType`，而是从飞书事件保留消息创建时间和 mention open ID，并把实际发送者作为唯一请求 Principal，向 Agent Core 传递结构化 `conversation`、60 秒内 `membership` Evidence、`purpose` 和 `mentions`。私聊明确标记为 `private` 且不携带群成员权限；多人艾特只进入语境，不进入权限并集。H-Lite 未部署候选版本提升为 `2026-08-11.1`。

新增部署后 Goal 7 权限合成 Canary：

- `deploy/qnap/scripts/run-goal7-authority-canary.sh`；
- `deploy/qnap/canary/goal7-authority-canary.sql`；
- `deploy/qnap/canary/goal7-authority-canary-cleanup.sql`；
- `deploy/qnap/strategic-intelligence/test/goal7-authority-canary.test.mjs`；
- 独立 `feishu-grok-bridge` 仓的 `ops/goal7-authority-canary.mjs` 及 H-Lite Dockerfile/客户端/传输层/测试改动。

Canary 只使用 `simulation=true` 的临时 Principal、知识资源和 ACL，验证私聊发送者隔离、活跃群成员、过期成员、撤权、多人艾特不扩权、用途收窄和 ACL 拒绝七项场景。它不会运行 Collector、迁移数据库、部署或重启 Foundation；只有合成资源、授权快照和审计记录清理为零后，才生成 `0600 authority-canary.json`。

最新工程回归：

- H 平台：`325/325`；
- Agent Core：`63/63`；
- Knowledge Connector：`18/18`；
- Strategic Intelligence：`114/114`，`npm run validate` 通过；
- Ontology Contracts：`61/61`；
- 定向 H-Lite/Canary：`11/11`；
- `git diff --check`、Node 语法和 Shell 语法通过。

提交必须分两个仓选择性收口：主 `mycc` 仓提交公司 Ontology 的 Canary SQL、运行脚本、测试和文档；独立 `2-Projects/feishu-grok-bridge` 仓只提交上述 H-Lite 8 个已跟踪文件与 `ops/goal7-authority-canary.mjs`，继续排除 `.playwright-cli/`、`__pycache__/`、`output/`、`workspace/.acceptance/` 等并发或运行产物。2026-08-12 川哥已明确授权 Codex 直接完成本项目双仓提交、推送、Runtime Artifact 构建和 Goal 7 Foundation 部署；该授权仍不包含 Collector、010/011 生产迁移、七日 Shadow、真实回滚演练或 Owner Acceptance 代签。

双仓提交后 Runtime Workflow 必须显式输入独立 H-Lite 仓本次发布候选的完整 Commit。Workflow 会下载该指定 Commit、运行公司 Profile 定向测试、生成 `h-lite-source.tar.gz` 并记录 SHA-256；不要求它在执行时仍是最新 `main`。Agent Core、Knowledge Connector 与 H-Lite 镜像分别写入 OCI revision 标签，健康读回暴露对应 Source Commit。Goal 7 最终证据同时绑定 Ontology Commit 与 H-Lite Commit，任一漂移均失败关闭。

提交前 Git 基线已通过干净 worktree 隔离：主仓从 `origin/main=f4f407f9baa8b7cb197a009c936977d0690c1862` 创建 `codex/p1-si-goal7-release-20260812`，不携带主工作区并发 voice-agent Commit；独立 `feishu-grok-bridge` 从 `origin/main=61394ff358a44978a603762d4b8226219408dcca` 创建 `codex/goal7-hlite-release-20260812`。两个发布分支只选择性收口本 Goal 文件，继续排除运行产物目录。
