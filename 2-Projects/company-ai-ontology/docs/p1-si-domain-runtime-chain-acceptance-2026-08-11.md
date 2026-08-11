# P1-SI Domain Runtime Chain 工程验收（2026-08-11）

## 结论

P1-SI 的 Collector 后处理已从“只生成 JSON 候选”补齐为“Domain Batch 编译、敏感审计、单事务 Postgres 持久化、逐日证据和七日门禁”完整工程链。当前本地工程验收及公司 QNAP 隔离 PostgreSQL 17 Runtime 验证均已通过；但本次证据绑定未提交工作树快照，而不是最终已推送 Commit 的不可变发布包，因此只能标记为 `engineering_verified`，不能开始生产七日 Shadow。

## 已完成

1. Collector 成功后编译 Source Entry/Decision、Ingestion Run、Raw Snapshot、Observation、零置信 Candidate Signal、Context Evidence、六类 P003 inactive Hypothesis/Assessment，以及 Daily/Company/P003 报告草稿。
2. Shadow 原始内容继续保持 hash-only；Domain Batch 不保存正文，Raw Snapshot 映射为 `storage_tier=purged / sanitization_status=untrusted`，与 010 表约束一致。
3. Observation/Signal 状态已对齐 010 枚举：`valid / fresh|aging|stale / none / observed|candidate`。
4. `compile-shadow-domain-sql.mjs` 输出一笔 tenant-scoped、`row_security=on`、`ON CONFLICT` 幂等事务，覆盖 010/011 的 Source、Run、Snapshot、Observation、Signal、Evidence、Impact、Report Input Set、ReportRun 和 Report Draft。
5. `persist-shadow-domain-batch.sh` 只有部署环境显式设置 `SI_PERSIST_DOMAIN_TO_POSTGRES=YES` 才执行；正式部署脚本在候选迁移完成后才写入该开关并启动 Orchestrator。
6. Domain 编译或 Postgres 持久化失败时，Dispatcher 不会中途丢失证据或卡住 running 队列：失败记录为 `status=failed / persistenceState=not_persisted`，后续撤销、敏感输出、业务副作用审计和 Evaluation 继续执行。
7. 单日与七日验收新增硬门禁：`domainCompilationCompleted=true`、`domainPersistenceCompleted=true`、`persistenceState=postgres_committed`。

## 本地证据

- Strategic Intelligence：`67/67`；
- Ontology Contracts：`61/61`；
- Collector：`9/9`；
- package validate：通过；
- Node/Shell/JSON：通过；
- `git diff --check`：通过；
- 新增敏感词扫描仅命中负测中的字段名 `access_token`，未发现真实凭据、私钥或 Token。

## 新增 Runtime 验证

现有 `.github/workflows/p1-si-runtime-verify.yml` 会继续调用 `validate-candidate-migrations-isolated.sh`。Workflow 已同步到 Release Manifest `1.2.0 / P1-SI-F-shadow-candidate-gated`，并且只有从隔离 PostgreSQL 输出中逐项读到 `domain_persistence=verified`、`domain_persistence_idempotent=verified` 和 `acl_fail_closed=verified` 后，才会写入 Runtime Verification Artifact。该脚本现已增加：

1. 生成真实 Domain Batch fixture；
2. 编译持久化 SQL；
3. 在 PostgreSQL 17 隔离容器内连续执行两次；
4. 验证行数保持 `1,1,1,1,1,6,6,3,3`，证明幂等且对象完整；
5. 切换到 `intelligence_retrieval`，在无 ACL 条件下读取 Report 必须为 0；
6. 恢复 candidate 前 baseline，继续证明候选 Schema 未污染生产基线。

QNAP 宿主机不提供 `node` 命令，因此隔离验证器支持显式 `NODE_BIN`。公司 QNAP 验证时使用受限、`network=none`、无端口、无 Docker Socket 的临时 H-Lite Node 容器作为编译 Runtime；PostgreSQL 仍使用独立临时容器和临时卷，不连接或迁移 Foundation 生产数据库。

## 公司 QNAP 隔离 Runtime 证据

`2026-08-11 14:16 CST` 在公司 `PRNas / TS-X65 / 192.168.61.18` 完成真实隔离验证：

1. PostgreSQL 使用固定 digest `pg17-bookworm@sha256:7ae605...75e38`，容器网络为 `none`，数据使用一次性 Docker Volume；
2. Node 编译使用固定 H-Lite 镜像 ID 的受限临时容器，`network=none`、无端口、无 Docker Socket、只读根文件系统；
3. 候选迁移通过，Strategic Intelligence 表 `19` 张，强制 RLS `19/19`；
4. Domain Batch SQL 连续执行两次后行数保持稳定，`domain_persistence=verified / domain_persistence_idempotent=verified`；
5. `intelligence_retrieval` 在无 ACL 时读取报告为 0，`acl_fail_closed=verified`；
6. candidate 前 baseline 恢复后不存在 `strategic_intelligence` Schema，Foundation 基线保留；
7. Foundation 13 个服务前后指纹一致、累计 restart 仍为 0、异常服务 0；战略情报目录前后均不存在；
8. 验证容器、临时卷和验证目录清理后均为 0/absent。

机器证据：`deploy/qnap/strategic-intelligence/evidence/qnap-isolated-runtime-verification-2026-08-11.json`。

## 仍关闭的门禁

1. 公司 QNAP 隔离 Runtime 已证明当前工程快照可执行，但新 CI Runtime 尚未在最终已推送 Commit 上运行；旧 Run 和未提交工作树证据均不能生成正式不可变发布包。
2. 来源实名许可及合规最终决定未完成。
3. P003 36 条联合 DRI 最终审核未完成，关系全部保持 `pending / inactive`。
4. 四名角色成员真实权限体验和安全 Owner Acceptance 未完成。
5. Goal 7 文件化工程证据与川哥 Owner Acceptance 未完成。
6. 已连接公司 QNAP并完成临时隔离 Runtime 验证，但未部署战略情报服务、未迁移生产数据库、未启动 Orchestrator/Collector，也未开始连续七个上海自然日 Shadow。

当前状态继续为 `WAIT_FINAL_APPROVALS_GOAL7_RUNTIME_VERIFY_AND_EXPLICIT_DEPLOY_AUTH`。
