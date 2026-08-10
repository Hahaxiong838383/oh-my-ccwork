# P1-SI-D 战略情报数据底座工程验收

日期：2026-08-10（Asia/Shanghai）

## 1. 结论

P1-SI-D 已完成 contract-only 数据契约和 Postgres 候选物理模型：

- `engineering_verified=true`；
- `ontology_candidate=3.6.0`；
- `sql_static_verified=true`；
- `sql_runtime_verified=false`；
- `production_deployed=false`。

当前环境没有 Docker 或本地 PostgreSQL，因此候选迁移没有被执行。SQL 文件位于 `candidate-migrations/`，不会被现有 QNAP `migrate.sh` 自动加载，也没有连接或修改公司 QNAP。

## 2. Ontology 增量

P1-SI-D 以 P1-SI-B `3.5.0` 为不可变基线，叠加候选 `3.6.0`：

- 3 Object：`RawSnapshot`、`ExternalObservation`、`StrategicSignal`；
- 5 Link：Source → Snapshot → Observation → Signal → Assessment/Evidence；
- 3 Function：Raw Identity、Dual Time Validation、Replay Validation；
- 0 Action；
- 4 Policy；
- 5 Constraint。

既有 `core.epistemic.Evidence`、`ImpactHypothesis`、`ImpactAssessment`、`ReportRun` 和 `StrategicIntelligenceReport` 继续复用，不建立第二套认识论对象。

## 3. 唯一事实真源

合同固定：

- Postgres 是唯一结构化事实真源；
- Qdrant 只能保存可删除、可重建的向量召回派生；
- Raw Snapshot 是 append-only 原始证据；
- 冷归档必须保留 Postgres manifest、内容 Hash 和归档 Hash；
- 外部内容默认 `untrusted`，不得直接进入模型 Prompt、Evidence、Fact 或 Decision；
- 报告正文和飞书/H 控制面展示只是投影。

## 4. 候选物理模型

候选迁移：

`deploy/qnap/candidate-migrations/010-pestim-strategic-intelligence.sql`

主要表：

| 分组 | 表 |
|---|---|
| Source Governance | `source_registry_entries`、`source_registry_decisions` |
| Ingestion | `ingestion_runs`、`raw_snapshots`、`external_observations` |
| Signal/Evidence | `strategic_signals`、`signal_observations`、`evidence` |
| Causal | `impact_hypotheses`、`impact_assessments`、`assessment_evidence` |
| Reporting | `report_runs`、`report_run_inputs`、`reports` |
| Security | `acl_entries` |

## 5. 双时间与可重放

关键对象同时保存：

- `valid_from / valid_to`：业务世界何时有效；
- `recorded_at`：系统何时记录；
- `observed_at / fetched_at`：来源事件或采集发生时间；
- Collector、Parser、Source Registry、Ontology、Causal Graph、Model、Prompt 和 Input Hash 版本。

Raw Snapshot identity：

- `snapshot_key` 和 `dedup_key` 由 tenant、source 和 content hash 确定；
- 同一内容重试不会产生第二份事实；
- `idempotency_key` 额外包含 run key，保留运行级幂等证据；
- Replay 只能生成新的 derived record，不能修改原 Snapshot identity 或内容 Hash。

## 6. 权限边界

候选 SQL 建立三个 NOLOGIN group role：

- `intelligence_collector`；
- `intelligence_orchestrator`；
- `intelligence_retrieval`。

权限规则：

- Collector 只能读取 Source Registry、写入准入决策/运行/Raw/Observation；
- Collector 没有 Raw Snapshot UPDATE/DELETE 权限；
- Raw 更新或删除还受 `app.retention_job=approved` 触发器保护；
- Retrieval 没有 Raw Snapshot 读取权限；
- Signal、Evidence、Assessment 和 Report 必须同时存在 tenant、principal 和 purpose ACL；
- session 缺少 `app.principal_key` 或 `app.purpose` 时 RLS 自动返回 0 行；
- PUBLIC 对 schema、table 和 function 的权限全部撤销。

## 7. 保留与删除

- Hot：Postgres 保存原始字节和结构化记录；
- Cold：QNAP 归档文件保存原始字节，Postgres 保留 archive reference/hash 和 lineage；
- Purged：只有批准的 Retention Job 可以清除负载；
- Qdrant：随时可按 Postgres 重新构建，不参与保留或删除真值判断；
- Evidence 已被报告、Assessment 或 Decision 引用时，删除策略必须先完成引用审计。

## 8. 测试证据

执行：

```bash
cd 2-Projects/company-ai-ontology/packages/ontology-contracts
npm test
npm run compile:data-foundation
```

结果：

- 总测试 `30/30` 通过；
- P1-SI-D 新增测试 `6/6` 通过；
- P1-SI-B candidate Hash 保持 `082c4eec516ecc8a08fbd24ce21f3e97a34500dc5a010a715b108ef0137c6154`；
- Candidate Schema：`3.6.0`；
- Candidate Hash：`2088f360866285a9f860107a91c3da32faefae6dc7c573ed9580603f9a4fea5d`；
- 兼容性变化 20 项，全部为 `compatible`；
- `migration_required=0`；
- 新增 Action Type：0；
- Raw identity、非法双时间、弱 Hash、Replay 输入变化、RLS/ACL 和 Raw 不可变负测通过。

## 9. 未执行事项

- 未执行数据库迁移；
- 未创建生产角色；
- 未写入真实 Raw Snapshot、Evidence 或 Signal；
- 未连接 Qdrant；
- 未连接公司 QNAP；
- 未启用真实来源；
- 未发布报告；
- 未创建正式 P2 或业务写回。

## 10. 下一步

1. P1-SI-E 在 `report_runs / report_run_inputs / reports` 上建立多周期报告机器契约；
2. P1-SI-F 在隔离 Postgres 和镜像构建环境执行迁移、回滚、容量及保留期测试；
3. P1-SI-H 前不得把 candidate migration 移入生产 `migrations/` 目录。
