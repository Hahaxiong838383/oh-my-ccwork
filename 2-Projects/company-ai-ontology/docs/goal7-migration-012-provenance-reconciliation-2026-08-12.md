# Goal 7 迁移 012 生产溯源与证据修复

日期：2026-08-12（Asia/Shanghai）

状态：`PRE_EXISTING_VERIFIED / ORIGINAL_PHASE_EVIDENCE_MISSING / DO_NOT_REPLAY_SQL`

## 结论

Goal 7 的四张 Authority/Runtime 表已于 `2026-08-12 10:13 CST` 左右进入公司 QNAP 生产 PostgreSQL，早于 Agent Core `2026-08-12.2` 的独立发布。它们不是当前只读检查临时创建，也不是 Agent Core `2026-08-12.2` 意外自动迁移。

历史一体化 Goal 7 发布流程同时打开了发布准备、012 和三组件服务动作；流程随后因镜像运行权限问题自动恢复旧服务，但 additive 012 按设计保留。历史目录只留下发布前快照，没有留下 `migration-012-evidence.json`，因此不能把现有四表直接冒充一份完整的原始迁移证据。

修复原则是：**不再次执行 SQL，只在新的独立授权下，对历史不可变 SQL Hash、现有四表、RLS、授权和真实 `ontology_app` 能力做只读对账，再生成编译校验的迁移对账证据。**

## 证据

- 公司资产五元组：`PRNas / TS-X65 / 192.168.61.18 / 公司 AI Ontology / /share/CACHEDEV1_DATA/ai-ontology/foundation`；
- 四表 Owner 均为 `ontology_admin`，全部 `ENABLE + FORCE RLS`，均有 `tenant_isolation`；
- `ontology_app` 必需权限 `10/10`，DELETE `0/4`，敏感正文列 `0`；
- 当前行数：Membership `0`、Authority Snapshot `7`、Route State `0`、Usage Event `2`；
- 两张基础关系文件时间为 `2026-08-12 10:13:55 CST`；
- 历史 Workflow `31555822727` / Artifact `9125968266` 的 012 SQL SHA-256 与当前候选完全一致：`8ea8648effbd7ab6d3ef81283678afc2fb16250f526e73c6a421abcb4d723a74`；
- 历史发布前快照 SHA-256 为 `5c6c10e8aeb9ebd8db0e87ad30b5f8ce8ed5a5ac94be53068baca75a04b0b723`；
- Agent Core `2026-08-12.2` 容器启动于 `2026-08-12 12:24 CST`，晚于 012 落库约两小时。

脱敏机器证据：`deploy/qnap/strategic-intelligence/evidence/goal7-migration-012-provenance-2026-08-12.json`。

## 新 B 阶段

`reconcile-goal7-migration-012.sh` 替代旧 `apply-goal7-migration-012.sh`：

1. 必须先验证 A 阶段不可变准备证据；
2. 校验历史 Source Archive、发布前快照和固定 SQL Hash；
3. 只读验证四表、4/4 强制 RLS、Tenant Policy、应用权限、无 DELETE 和无敏感正文列；
4. 记录当前四表行数，防止把空库假验证冒充运行状态；
5. 生成 `goal7-migration-012-reconciliation` v2 证据，明确 `originalEvidenceStatus=missing_at_source`；
6. 输出 `database_sql_executed=0`，任何再次执行 012 SQL 的实现都被 Release Plan Validator 拒绝。

## 授权边界

历史部署授权不能继承为本次对账、服务重建、Worker 读回或回滚授权。B 阶段仍需要一次独立授权，因为它会在公司 QNAP 受控证据目录写入新的对账文件；但它不迁移数据库、不重启服务、不运行模型。

旧 Artifact `9145915628` 仍包含“可再次执行 012”的旧 B 阶段，因此从本次修复起降级为历史工程证据，禁止进入公司 QNAP。必须从本修复后的新 Commit 生成 Manifest/Release Plan `1.4.0` 新 Artifact。
