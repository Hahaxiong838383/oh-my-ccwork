# P1-SI-B～H 当前门禁审计

日期：2026-08-12（Asia/Shanghai）

状态：`engineering_verified / prior_runtime_superseded / human_review_pending / production_blocked`

## 1. 结论

P1-SI-B～G 的工程骨架已通过当前全量验收。生产溯源确认 012 已由历史流程落库、原始 B 阶段 Evidence 缺失；Manifest `1.3.0` Runtime 仍允许 SQL replay，现已失效。P1-SI-H 仍不能开始正式七日 Shadow，因为当前没有 Manifest `1.4.0` 可部署 Artifact，且来源、P003、四角色 UAT 和 Goal 7 Owner Acceptance 均未完成。

本轮没有部署战略情报 Orchestrator、没有执行 010/011、没有启动 Collector、没有新增端口、没有发布报告，也没有产生正式 P2、员工投递或 ERP/社媒写回。

## 2. 已失效的旧 Runtime 与当前工程证据

- Ontology Contracts：`61/61`；
- Intelligence Collector：`9/9`；
- Strategic Intelligence Shadow / Readiness / Goal Completion：`119/119`；
- 最终 Runtime Workflow：`31614522984` Attempt `1`，状态 `success`；
- 最终 Runtime Artifact：`9148675772`，当前唯一可申请 A～E 独立授权的候选；
- Runtime Manifest：`1.4.0`；
- Ontology Source Commit：`76b5ce688b1e3cad1eb88e961bd0545c952cf5ce`；
- H-Lite Source Commit：`fab8be3f1467289400d0d63ffe378b63ad1a6957`；
- Collector Image：`sha256:59eadd7a3b95caa2a7a09604abb981b18f4ce8ec730408efd5f7d0f4efdfe39d`，平台 `linux/amd64`；
- Runtime Components：Agent Core `2026-08-12.3`、Knowledge Connector `2026-08-11.1`、H-Lite `2026-08-12.1`；
- Candidate Ontology：Schema `3.7.0`，Hash `c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860`；
- 最终 Artifact 内 `runtime-component-versions.json`、双仓源码归档、Collector 镜像、Runtime Verification、Release Manifest 与 8 项完整 `SHA256SUMS` 全部通过；B 阶段固定为 `pre_existing_reconciliation_only`，强制 `database_sql_executed=0 / SQL replay=false`。Artifact `9145915628`、中间候选 `9148389214` 及更早包仅保留历史工程证据并禁止部署。

Runtime Workflow 已验证：

- 010/011 共 `19` 张表，强制 RLS `19/19`；
- Domain Persistence 与二次幂等通过；
- ACL fail-closed 与 baseline restore 通过；
- 012 四张 Goal 7 表、二次幂等、真实 `ontology_app` 读写和敏感正文列为零通过；
- Route A operational，Route B disabled；
- `publish=false / productionDeploymentAuthorized=false`。

## 3. 公司 QNAP 当前真值

只读在线核对结果：

- 五元组：`PRNas / TS-X65 / 192.168.61.18 / 公司 AI Ontology / /share/CACHEDEV1_DATA/ai-ontology/foundation`；
- active Schema `3.3.0`，Hash `41689393289d9514d1ed9cd22455a164f1bc59286f0db16deb9235e703e6ae77`，Registry `in_sync`；
- Agent Core `2026-08-12.2` / Commit `3edbc7a73863fa5f334c06d603067427183f58ed`；
- Knowledge Connector `2026-08-11.1` / Commit `dc15ef976e258da28f0ed1f5134a48c4b466e6c0`；
- H-Lite `2026-08-11.1` / Commit `e38857ca589e3270d9cbe02ae311aa41cb898552`，飞书长连接在线；
- 012 对应四张 Goal 7 表已存在，但这不等于 Goal 7 完成；
- Foundation `13/13 running / unhealthy=0 / restart=0`；
- `strategic_intelligence` Schema 不存在、表 `0`；
- 战略情报容器、网络、发布端口均为 `0`；
- P1-SI 正式员工投递与 ActionIntent 均为 `0`。

Agent Core `2026-08-12.2` 是已授权的独立回复修复，不是 Goal 7 三组件正式发布，也不能替代 Authority Canary、Worker 双源读回、完整 Deployment Evidence 或 Owner Acceptance。

`2026-08-12 22:48 CST` 经公网 Mini 跳板完成无落盘纯只读预检：公司 QNAP 五元组一致，Foundation `13/13 running / unhealthy=0 / restart=0`，唯一宿主端口仍为 `192.168.61.18:19080`；active Schema `3.3.0 / in_sync`，Goal 7 候选四表存在；战略情报 Schema、表、容器和网络均为 `0`，正式 P2、员工投递、ERP 写回、社媒写回和因果激活均为 `0`，Artifact `9145915628` 尚未进入 QNAP。证据见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-readonly-preflight-2026-08-12.json`。该预检不构成部署、迁移、服务重建、Worker 读回或回滚授权。

容量与回滚输入也已只读确认：QNAP/Docker 架构与 `linux/amd64` Artifact 匹配，可用内存约 `11.1 GiB`，热卷与备份卷容量充足，三组件旧镜像均存在且 Compose 有效；候选 Runtime 尚未传入 QNAP，Artifact 传输、镜像构建、镜像打标和服务动作均为 `0`。证据见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-capacity-rollback-preflight-2026-08-12.json`。

## 4. 未关闭的人审门禁

`2026-08-12 13:54 CST` 已再次通过飞书用户身份只读回拉两张审核表；`2026-08-12 23:53 CST` 使用最终 Artifact `9148675772` 复核不可变 Release 与现有门禁身份。飞书脱敏原始汇总仍见 `deploy/qnap/strategic-intelligence/evidence/p1-si-live-gate-status-2026-08-12.json`，最终 Artifact 验签见 `deploy/qnap/strategic-intelligence/evidence/p1-si-runtime-artifact-9148675772.json`；文件不包含姓名、Principal、审批正文或受控路径。

### 来源审核

- 分配完整：`8/8`；
- 最终决定：`0/8`；
- 飞书表 revision：`38`，decision/license/compliance 均为 `8 pending`，批准时间、存储级别和保留期完成数均为 `0`；
- 推荐最小批次仍为 `3 approve_for_shadow + 5 keep_paused`；
- 任何 `pending`、许可证据缺失、保留期缺失或合规决定缺失都会失败关闭。

### P003 审核

- 候选：`36`，六类各 `6`；
- 个人 DRI：`30/36`；
- 必要角色位：`90/150`；
- 全角色覆盖：`12/36`；
- 最终决定：`0/36`；
- 飞书表 revision：`91`，`36 pending / 36 inactive`，语义重写、支持证据、反证和审核时间完成数均为 `0`；
- 所有关系仍为 `generated_draft / unverified / inactive`。

当前主要缺口是供应链六条个人 DRI，以及 AI 技术、渠道、隐私安全等类别的知识产权、财务、AI 安全、法务、采购和质量角色。不能由 Agent 代签、推断或批量伪造真人审核。

### 四角色 UAT 与 Goal 7

- 四个真实成员 Session：`0/4`；
- 安全负责人接受：未完成；
- Goal 7 Runtime Evidence：Manifest `1.4.0` 最终 Artifact `9148675772` 已生成并验签；
- Goal 7 Authority Canary、Worker 双源读回、完整三组件 Deployment Evidence：未完成；
- Goal 7 Owner Acceptance：未完成。

## 5. 当前机器门禁

Deployment Readiness：`1 pass / 6 blocked`。

- 通过：不可变 Release；阻断：本次部署授权、Goal 7 完成、来源批准、P003 最终审核、四角色 UAT、Goal 7 Acceptance。

Goal Completion：`1 pass / 7 blocked`。

- 通过：不可变 Release；阻断：来源批准、P003 最终审核、四角色 UAT、Goal 7、部署完成证据、七日 Owner Acceptance、Release/Deployment/Shadow 身份一致性。

旧证据文件仍保留 `22:50 CST` 的历史 Artifact 身份，不改写其内容或 Hash；本节是使用 Artifact `9148675772` 重新运行机器检查器后的当前判定。

## 6. 下一执行顺序

1. 先申请 A，让 Artifact `9148675772` 进入受控 staging，完成 Hash、备份和候选镜像构建；
2. A 留证后依次申请 B～E，完成 Goal 7 剩余工程证据并由川哥执行 Owner Acceptance；
3. 系统整体测试阶段，许可/合规负责人完成来源 `8/8` 最终决定；
4. P003 DRI 完成 `36/36` 最终决定，全部保持 inactive；
5. 四名真实成员完成权限 UAT，由安全负责人接受；
6. 分别申请战略情报部署、010/011 迁移、必要服务动作和真实回滚演练授权；
7. 只部署战略情报 Orchestrator/Collector，运行连续七个真实上海自然日 `PUBLISH=false` Shadow；
8. 第七日后完成 Shadow Owner Acceptance 和 Goal Completion 编译。

七日未完成前，P1-SI-H 和整个 P1-STRATEGIC-INTELLIGENCE Goal 必须保持 active/incomplete。
