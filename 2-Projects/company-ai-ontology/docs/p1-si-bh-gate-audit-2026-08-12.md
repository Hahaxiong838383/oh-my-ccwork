# P1-SI-B～H 当前门禁审计

日期：2026-08-12（Asia/Shanghai）

状态：`engineering_verified / immutable_release_verified / stage_a_completed / stage_b_not_authorized / human_review_pending / production_blocked`

## 1. 结论

P1-SI-B～G 的工程骨架已通过最近一次完整验收。旧 Artifact `9156356166` 的首次 A 阶段新准备成功后暴露成功路径未释放全局锁；该次没有执行 SQL、没有服务重建，残留锁也已在确认无进程后删除，但旧 Artifact 与旧 A 授权均已失效。Workflow `31654762489` Attempt `1` / Artifact `9163957919` 已通过 Manifest `1.6.0` 完整复验，并新增完整新准备成功和成功回放后锁目录消失的可执行回归。`2026-08-13T00:57:51Z`，新 Artifact 的 A 阶段已在公司 QNAP 完成并留证；当前下一门禁是单独授权 B 阶段既有 012 只读对账。P1-SI-H 仍不能开始正式七日 Shadow，因为来源、P003、四角色 UAT、Goal 7 B～E Evidence 和 Owner Acceptance 均未完成。

本轮没有部署战略情报 Orchestrator、没有执行 010/011、没有启动 Collector、没有新增端口、没有发布报告，也没有产生正式 P2、员工投递或 ERP/社媒写回。

## 2. 当前不可变 Runtime 与工程证据

- Ontology Contracts：`61/61`；
- Intelligence Collector：`9/9`；
- Strategic Intelligence Shadow / Readiness / Goal Completion：`137/137`；
- 当前 Runtime Workflow：`31654762489` Attempt `1`；
- 当前 Runtime Artifact：`9163957919`；
- 当前 Runtime Manifest：`1.6.0`；
- Ontology Source Commit：`8eaef798e3a9831f34bdb598c79dfd29aa735212`；
- H-Lite Source Commit：`baa00bf07089a3caf5fe6318aac28cb73bd5ae13`；
- Collector Image：`sha256:9a2606c1db7db2112d6527c34b59187ab6d24d597bbf886e78016a3c1aea36fc`，平台 `linux/amd64`；
- Runtime Components：Agent Core `2026-08-12.3`、Knowledge Connector `2026-08-11.1`、H-Lite `2026-08-12.1`；
- Candidate Ontology：Schema `3.7.0`，Hash `c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860`；
- 当前 Artifact 已让 `runtime-component-versions.json`、双仓源码归档、Collector 镜像、`image.env`、Runtime Verification、Release Manifest 与 9 项 `SHA256SUMS` 全部通过；A 阶段 Preparation 状态采集已证明不调用 Postgres，B 阶段固定为 `pre_existing_reconciliation_only / database_sql_executed=0 / SQL replay=false`，Release Plan 明确要求 A～E 五项独立授权。

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

`2026-08-13T00:40:01Z` 的公网只读复核是 A 阶段前历史基线；随后 A 阶段已完成 Artifact `9163957919` 原子入场、新备份、3 个 previous 标签与 3 个 candidate 标签。Foundation 保持 `13/13 running / unhealthy=0 / restart=0`，release 10 个文件全部 `0600`，Artifact/Preparation 锁和 transfer partial 均为 `0`；SQL、服务重建、Worker、Collector、Shadow 与回滚均为 `0`。当前实机证据见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-stage-a-artifact-9163957919.json`。旧 Artifact `9156356166` 的资产仍保留审计且明确 `reusable=false`；A 完成不构成 B～E 授权。

容量与回滚输入也已只读确认：QNAP/Docker 架构与 `linux/amd64` Artifact 匹配，可用内存约 `11.1 GiB`，热卷与备份卷容量充足，三组件旧镜像均存在且 Compose 有效。该文件是 A 阶段前历史预检；当前候选 Runtime 已按 A 授权进入 QNAP，但服务切换、SQL、Worker、Collector、Shadow 与回滚仍为 `0`。证据见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-capacity-rollback-preflight-2026-08-12.json`。

## 4. 未关闭的人审门禁

飞书用户身份只读回拉的两张审核表仍为来源 `0/8 final`、P003 `0/36 final`。飞书脱敏原始汇总见 `deploy/qnap/strategic-intelligence/evidence/p1-si-live-gate-status-2026-08-12.json`；当前 Artifact 验签见 `deploy/qnap/strategic-intelligence/evidence/p1-si-runtime-artifact-9163957919.json`。文件不包含姓名、Principal、审批正文或受控路径。

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
- Goal 7 Runtime Evidence：Manifest `1.6.0` Artifact `9163957919` 已验签，新的 A 阶段尚未授权；
- Goal 7 Authority Canary、Worker 双源读回、完整三组件 Deployment Evidence、Rollback Drill Evidence：未完成；
- Goal 7 Owner Acceptance：未完成。

## 5. 当前机器门禁

Deployment Readiness：`1 pass / 6 blocked`。

- 已通过：不可变 Release。阻断：本次部署授权、Goal 7 完成、来源批准、P003 最终审核、四角色 UAT、Goal 7 Acceptance。

Goal Completion：`1 pass / 7 blocked`。

- 已通过：不可变 Release。阻断：来源批准、P003 最终审核、四角色 UAT、Goal 7、部署完成证据、七日 Owner Acceptance、Release/Deployment/Shadow 身份一致性。

旧证据文件仍保留历史 Artifact 身份，不改写其内容或 Hash；本节按当前 Manifest `1.6.0` 契约判定，旧包不能继续计入不可变 Release 通过项。

## 6. 下一执行顺序

1. 申请 Artifact `9163957919` 的新 A 阶段授权并完成 Artifact 入场、新备份和候选镜像构建 Evidence；旧 Artifact `9156356166` 的 A 资产只保留审计；
2. A 留证后依次申请 B～E；
3. 五份 Goal 7 工程证据通过后，由川哥执行 Owner Acceptance；
4. 系统整体测试阶段，许可/合规负责人完成来源 `8/8` 最终决定；
5. P003 DRI 完成 `36/36` 最终决定，全部保持 inactive；
6. 四名真实成员完成权限 UAT，由安全负责人接受；
7. 分别申请战略情报部署、010/011 迁移、必要服务动作和真实回滚演练授权；
8. 只部署战略情报 Orchestrator/Collector，运行连续七个真实上海自然日 `PUBLISH=false` Shadow；
9. 第七日后完成 Shadow Owner Acceptance 和 Goal Completion 编译。

七日未完成前，P1-SI-H 和整个 P1-STRATEGIC-INTELLIGENCE Goal 必须保持 active/incomplete。
