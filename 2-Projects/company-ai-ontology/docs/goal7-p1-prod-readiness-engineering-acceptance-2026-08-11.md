# Goal 7 P1-PROD-READINESS 工程候选验收

日期：2026-08-11（Asia/Shanghai）

状态：`engineering_verified / prior_runtime_superseded / production_not_deployed / owner_acceptance_pending`

## 1. 结论

Goal 7 的 P1-AUTHORITY 与 P1-RUNTIME 已从规划进入本地工程候选：飞书部门/群聊 Principal 映射、发送者隔离、用途收窄、当前群成员证据、会话授权快照、Route A 独立熔断、有限重试、Token/费用预算、真实 provider/model/usage 读回和 Route B 默认关闭已经进入 Agent Core、Knowledge Connector、候选迁移和不可变 Runtime Workflow。Goal 7 最终验收也已由可手填布尔值升级为五份原始 Evidence 绑定的编译产物。

双仓候选曾由 Runtime Workflow `31607792883` Attempt `1` / Artifact `9145915628` 取得 Linux/amd64 与 PostgreSQL Runtime Evidence。`2026-08-12 23:10 CST` 生产溯源进一步确认：012 四表已由更早的历史 Workflow `31555822727` 落库，原始 B 阶段 Evidence 缺失；旧 Artifact 仍包含可再次执行 SQL 的入口，因此已失效并禁止部署。新 Runtime 必须使用 Manifest `1.4.0`，把 B 阶段改为只读对账并强制 `database_sql_executed=0`。当前仍不能把 Goal 7 标记为完成：没有可部署 Artifact，且未执行真实 H Worker 双源读回、合成飞书 Authority Canary、完整三组件 Deployment Evidence、撤权演练或川哥 Owner Acceptance。

## 2. P1-AUTHORITY 工程能力

- 飞书成员同时兼容 `type` 与 `member_type`；`user/openid`、`department/opendepartmentid`、`chat/openchat/group/groupid` 分别归一化为人员、部门和 chat Principal；
- 未识别成员类型返回 `feishu_acl_member_type_unknown` 并在读取正文前失败关闭，不降级为人员或全员权限；
- 请求 Principal 永远来自 H-Lite HMAC 签名中的实际发送者；被艾特成员不参与权限计算；
- 私聊不继承群聊权限；群聊资源 ACL 只有在发送者当前成员 Evidence 新鲜且 `status=active` 时进入检索范围；
- 群聊成员 Evidence 默认 60 秒失效，过期、缺失和撤权分别归为 `unknown/deny`，chat ACL 不进入 SQL；
- 用途固定为 `company_knowledge_query / task_execution_support / decision_support / result_submission`，非法用途回落到最小查询用途；
- 资源 `allowedPurposes` 只收窄已有 ACL，不能扩大人员、部门或群聊权限；
- 每次检索生成 `ConversationAuthoritySnapshot`，只持久化发送者、用途、规则、结果、有效期和 chat Hash，不保存群聊原始 ID、文档标题或正文。

## 3. P1-RUNTIME 工程能力

- Route A 作为当前主路由独立维护熔断状态；Route B 固定 `disabled`，不能复用同一 CPA Key 伪装冗余；
- 只对网络失败、超时、限流和上游 5xx 执行指数退避；权限拒绝、证据不足、预算拒绝和业务校验失败不重试；
- 默认单请求最多重试 2 次，单日重试 200 次，连续 3 次失败打开 60 秒熔断；
- 提供单请求/单日请求数、Prompt Token、总 Token 和费用预算；超预算返回稳定 `budget_blocked`；
- 远程模式强制真实读回 provider、model 和完整 Token usage；空对象、缺字段、负数或总量小于分项时返回 `runtime_readback_missing` 或 `runtime_usage_readback_missing`，不以配置标签冒充真实模型；
- 用量审计只保存 Route、WorkCase 类型、部门、Token、费用、重试、Provider、Model 和 Credential Mode，不保存员工问题、Prompt 或模型回复正文；
- 模型已实际消耗后才发现单请求/单日 Token 或费用超限时，回答仍失败关闭，但本次真实消耗必须以 `budget_blocked` 写入账本，不能形成成本盲区；
- 当前凭据模式显式标记 `temporary_personal_credential`，不伪装成公司专用凭据。

## 4. 数据与发布候选

候选迁移：`deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql`

新增四张表：

1. `iam.principal_memberships`：部门/chat 成员关系、业务有效时间、观测时间和撤权状态；
2. `work.conversation_authority_snapshots`：会话授权判据、用途、结果、规则和有效期；
3. `runtime.h_engine_route_state`：Route A/B、熔断、Provider、Model 和凭据模式；
4. `runtime.h_engine_usage_events`：无正文的请求、Token、费用和重试审计。

四表均启用并强制 RLS，应用角色无 DELETE 权限。迁移保留在 `candidate-migrations/`，不会被当前生产 `migrate.sh` 自动加载。

Goal 7 Acceptance Evidence 升级为 `2.0.0`，必须由同目录五份原始证据自动编译：

1. `runtime-verification.json`：已推送 Commit 的 Linux/PostgreSQL Workflow；
2. `worker-readback.json`：真实 H Worker provider/model/完整 usage；
3. `authority-canary.json`：私聊、群聊、多人艾特、Purpose、撤权和正文前 ACL 合成 Canary；
4. `deployment-evidence.json`：公司 QNAP 五元组、012、版本、容器、端口、Route 与零业务副作用；
5. `owner-acceptance.json`：川哥在全部工程证据之后作出的独立验收。

`compile-goal7-acceptance.mjs` 绑定五份文件 Hash、Ontology Source Commit、独立 H-Lite Source Commit 和时间顺序；`validate-goal7-acceptance.mjs` 会重新读取原始文件并重算结果。Runtime Workflow 会直接下载并运行指定已推送 H-Lite Commit 的公司 Profile 定向测试，生成独立 `h-lite-source.tar.gz` 及 SHA-256；后续 `main` 新提交不会改变该发布身份。直接修改 `goal7-acceptance.json`、替换任一原始文件、任一仓 Commit 漂移或提前填写 Owner Acceptance 都失败关闭。

新增 `validate-goal7-foundation-isolated.sh`，已接入 `.github/workflows/p1-si-runtime-verify.yml`。CI 必须使用固定 PostgreSQL 17/pgvector 镜像验证：

- 迁移可执行且二次幂等；
- 4/4 强制 RLS；
- 无 Tenant 时应用角色读取为 0；
- `ontology_app` 以真实应用角色完成成员、会话授权、Route 状态和用量事件的受控读写；
- Route A enabled / Route B disabled；
- 无员工问题、Prompt 或回复正文字段；
- Agent Core 与 Knowledge Connector 全量回归。

正式 Foundation 部署候选新增三段机器门禁：

1. `validate-goal7-runtime-release.mjs` 重新计算 Artifact `SHA256SUMS`、六项内部 Evidence/Archive Hash 与 Release Manifest 绑定；
2. `GOAL7_APPROVED_SOURCE_COMMIT` 和 `GOAL7_APPROVED_H_LITE_SOURCE_COMMIT` 将本次部署授权精确绑定到 Ontology/H-Lite 双仓 Commit，任一漂移在迁移前失败关闭；
3. `deploy-goal7-foundation.sh` 只逐个切换 Agent Core、Knowledge Connector、H-Lite，并在每个服务健康后才继续；强制 `KNOWLEDGE_SYNC_ON_START=0`，自动捕获部署前后状态、零业务副作用和编译后的 `deployment-evidence.json`。失败自动恢复旧配置和三个旧镜像；012 为 additive migration，自动及显式回滚都明确保留，不执行 DROP。

部署、012 迁移、三个服务重建和真实回滚演练已经拆分为四项独立授权。机器发布计划固定总维护窗口预计 8～20 分钟、员工可感知间歇中断累计 15～120 秒、回滚预计 2～6 分钟，并列出三个受影响能力、七个不应重启的 Foundation 服务、13 步验收顺序和 7 类回滚触发条件。运行手册见 `goal7-foundation-release-runbook-2026-08-11.md`。

## 5. 本地验收

| 检查 | 结果 |
|---|---|
| Agent Core | `66/66` |
| Knowledge Connector | `18/18` |
| Strategic Intelligence | `119/119` |
| Node 语法 | 通过 |
| Shell 语法 | 通过 |
| Compose / Workflow YAML | 通过 |
| `git diff --check` | 通过 |
| PostgreSQL 隔离 Runtime | 通过，Artifact `9145915628` |

覆盖的负向场景包括：多人艾特不扩权、私聊不继承群权限、群成员过期/撤权、未知飞书成员类型、非法用途、Route B 调用、非重试错误、Token/费用超预算、熔断、provider/model/usage 读回缺失、部署/回滚未独立授权、Artifact SHA 篡改、内部 Hash 重新签名漂移和获批双 Commit 漂移。

## 6. 当前门禁

- `engineeringVerified=true`：代码与 PostgreSQL 工程证据已完成；旧不可变 Runtime 已失效，必须重建 Manifest `1.4.0`；
- `ownerAccepted=false`：不得由测试自动填写；
- 公司专用 CPA Key 与同厂冗余仍缺失，Route B 继续关闭；
- 产品研究部整库导入、10 人真实 Canary、员工私人 Bot 迁移、ERP/社媒写回继续关闭；
- P1-SI 来源最终决定仍为 `0/8`，P003 最终决定仍为 `0/36`；
- 未部署、未迁移、未启动服务、未重启 Foundation。

## 7. 下一步

1. 从本修复的新推送 Commit 生成并验签 Manifest `1.4.0` Artifact，确认旧 `1.3.0` 包失败关闭；
2. 重新签发授权卡，再分别申请 A 发布准备、B 既有 012 只读对账与 C Agent Core/Knowledge Connector/H-Lite 服务重建；
3. 发布后验证真实 H Worker 返回 provider/model/usage，不满足新契约时停止验收并恢复安全状态；
4. 执行合成部门、群聊、私聊、多人艾特、撤权和 API 失败 Authority Canary；
5. 编译并验证三组件 Deployment Evidence，确认 active Schema 未漂移、无新增端口、Foundation restart=0 和五类业务副作用为 0；
6. 川哥体验验收后写入独立 `owner-acceptance.json`，再由编译器生成 `goal7-acceptance.json`；禁止人工设置最终布尔值或 Hash。
