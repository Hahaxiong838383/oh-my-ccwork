# Goal 7 P1-PROD-READINESS 工程候选验收

日期：2026-08-11（Asia/Shanghai）

状态：`engineering_verified / immutable_release_verified / stage_a_completed / stage_b_not_authorized / production_not_deployed / owner_acceptance_pending`

## 1. 结论

Goal 7 的 P1-AUTHORITY 与 P1-RUNTIME 已从规划进入本地工程候选：飞书部门/群聊 Principal 映射、发送者隔离、用途收窄、当前群成员证据、会话授权快照、Route A 独立熔断、有限重试、Token/费用预算、真实 provider/model/usage 读回和 Route B 默认关闭已经进入 Agent Core、Knowledge Connector、候选迁移和不可变 Runtime Workflow。机器 Release Plan 已升级为五阶段授权，D 阶段在任何合成写入前要求显式授权与公司 QNAP 五元组预检，E 阶段必须证明旧版本已验证且获批候选版本已恢复。Goal 7 Owner Acceptance 现绑定五份工程 Evidence，最终 Acceptance 共绑定六份文件。

工程契约现已升级为 Manifest `1.6.0`：Runtime 包必须包含 `image.env` 在内的 9 项 `SHA256SUMS`，并通过隔离上传、严格根目录白名单和原子晋级。旧 Artifact `9156356166` 的新准备成功路径曾留下全局锁，因此旧 Artifact 和旧 A 授权均已失效。Workflow `31654762489` Attempt `1` / Artifact `9163957919` 绑定 Ontology Commit `8eaef798e`、H-Lite Commit `baa00bf` 与 Collector Image `sha256:9a2606c1...`，离线 9/9 Hash、Release Validator、Goal 7 Runtime、PostgreSQL Runtime 和 Foundation 验证全部通过。`2026-08-13T00:57:51Z`，新 Artifact 的 A 阶段已完成：公司 QNAP release 10 个文件全部 `0600`，新备份与 3 个候选镜像完成，Preparation Evidence 校验通过；Foundation `13/13 running / unhealthy=0 / restart=0`，服务容器身份不变，SQL、服务重建、Worker、Collector、Shadow 与回滚均为 `0`，成功退出后两类锁均为 `0`。Goal 7 尚未取得 B～E 的独立授权，也未执行真实 H Worker 双源读回、合成 Authority Canary、完整三组件 Deployment Evidence、Rollback Drill Evidence 或川哥 Owner Acceptance。

同一真实 Artifact 的本机 staging 演练也已通过首次原子晋级、幂等重放、损坏包拒绝和失败清理；发布目录 10 个文件均为 `0600`。该结果只证明执行脚本与真实包兼容，明确 `countsTowardStageA=false / companyQnapTouched=false`，不把本地工程演练冒充生产 A 阶段完成。

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

Goal 7 Owner Acceptance Evidence 升级为 `3.0.0`，必须先绑定同目录五份工程证据：

1. `runtime-verification.json`：已推送 Commit 的 Linux/PostgreSQL Workflow；
2. `worker-readback.json`：真实 H Worker provider/model/完整 usage；
3. `authority-canary.json`：私聊、群聊、多人艾特、Purpose、撤权和正文前 ACL 合成 Canary；
4. `deployment-evidence.json`：公司 QNAP 五元组、012、版本、容器、端口、Route 与零业务副作用；
5. `rollback-drill-evidence.json`：候选版本、旧版本验证、候选版本恢复、012 保留、零 restart/端口/业务副作用。

随后川哥在全部五份工程证据之后生成独立 `owner-acceptance.json`；Goal 7 Acceptance Evidence `3.0.0` 共绑定六份文件。`compile-goal7-acceptance.mjs` 绑定全部文件 Hash、Ontology Source Commit、独立 H-Lite Source Commit 和时间顺序；`validate-goal7-acceptance.mjs` 会重新读取原始文件并重算结果。直接修改最终 JSON、替换任一原始文件、任一仓 Commit 漂移或提前填写 Owner Acceptance 都失败关闭。

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

Foundation 发布准备、既有 012 只读对账、三个服务重建、H Worker Readback/Authority Canary 和真实回滚恢复演练已经拆分为五项独立授权。机器发布计划固定总维护窗口预计 8～20 分钟、员工可感知间歇中断累计 15～120 秒、回滚预计 2～6 分钟，并列出三个受影响能力、七个不应重启的 Foundation 服务、21 步验收顺序和 8 类回滚触发条件。运行手册见 `goal7-foundation-release-runbook-2026-08-11.md`。

## 5. 本地验收

| 检查 | 结果 |
|---|---|
| Agent Core | `66/66` |
| Knowledge Connector | `18/18` |
| Strategic Intelligence | `137/137` |
| Node 语法 | 通过 |
| Shell 语法 | 通过 |
| Compose / Workflow YAML | 通过 |
| `git diff --check` | 通过 |
| PostgreSQL 隔离 Runtime | Manifest `1.6.0` Artifact `9163957919` 已通过 |

覆盖的负向场景包括：多人艾特不扩权、私聊不继承群权限、群成员过期/撤权、未知飞书成员类型、非法用途、Route B 调用、非重试错误、Token/费用超预算、熔断、provider/model/usage 读回缺失、D 阶段未授权写入、部署/回滚未独立授权、旧版本未验证、候选版本未恢复、迁移丢失、restart/业务副作用、Artifact SHA 篡改、内部 Hash 重新签名漂移和获批双 Commit 漂移。

## 6. 当前门禁

- `engineeringVerified=true`：五阶段授权和回滚证据链代码已完成本地工程验证；
- `immutableReleaseVerified=true`：Artifact `9163957919` 的 Manifest `1.6.0` 与 9 项 Hash 已完整复验；
- `ownerAccepted=false`：不得由测试自动填写；
- 公司专用 CPA Key 与同厂冗余仍缺失，Route B 继续关闭；
- 产品研究部整库导入、10 人真实 Canary、员工私人 Bot 迁移、ERP/社媒写回继续关闭；
- P1-SI 来源最终决定仍为 `0/8`，P003 最终决定仍为 `0/36`；
- 未部署、未迁移、未启动服务、未重启 Foundation。

## 7. 下一步

1. 申请 Artifact `9163957919` 的新 A 阶段独立授权；A 留证后依次申请 B、C、D、E；D 同时完成真实 H Worker 双源读回和 Authority Canary；
2. A 阶段只允许 Artifact 入场、Hash、原子晋级、配置/旧镜像备份和三个候选镜像构建；Preparation 状态采集必须继续保持零 SQL；
3. E 完成旧版本验证与候选版本恢复后，编译 `rollback-drill-evidence.json`；
4. 五份工程证据全部通过后，由川哥独立生成 `owner-acceptance.json`，再编译 `goal7-acceptance.json`。
