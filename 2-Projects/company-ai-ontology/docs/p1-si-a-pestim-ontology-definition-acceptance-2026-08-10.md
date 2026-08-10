# P1-SI-A PESTIM Ontology Definition 验收记录

更新时间：2026-08-10（Asia/Shanghai）

## 1. 结论

P1-SI-A 已完成本地工程验收：在生产 Ontology Schema `3.3.0` 上建立了独立、可编译、纯增量兼容的 PESTIM 候选定义 `3.4.0`，但没有修改 active `definitions/manifest.json`、没有部署 Registry、没有执行数据库迁移，也没有连接或重启公司 QNAP。

候选定义保持：

- `status=contract_only`
- `deploymentAllowed=false`
- `compatibility=compatible`
- 新增 Action Type 数量为 0
- 自动创建正式 P2、下发员工任务、写回 ERP/社媒和自动激活因果关系全部禁止

## 2. 稳定命名空间与对象

新增一个稳定命名空间：

| 命名空间 | 职责 |
|---|---|
| `domain.intelligence` | 外部战略情报、PESTIM 因果假设、影响评估和多周期报告 |

新增六个候选对象：

| 对象 | 作用 | 默认治理状态 |
|---|---|---|
| `domain.intelligence.ExternalFactor` | 43 个 PEST、Industry、Market 稳定外部维度 | 定义对象，不等于实时事实 |
| `core.work.GoalFacet` | 108 个 Goal、Purpose、Principle、Reason 目标要素 | 必须保留语义质量状态 |
| `domain.intelligence.ImpactHypothesis` | 外部因素到 GoalFacet 的候选传导关系 | `generated_draft / unverified / inactive` |
| `domain.intelligence.ImpactAssessment` | 在明确时间窗内基于 Evidence 对某条假设形成影响判断 | 必须带 evidence cutoff 和置信等级 |
| `domain.intelligence.StrategicIntelligenceReport` | 公司级或产品线级日、周、月、季、半年、年度报告 | 权限过滤后的投影，不是事实真源 |
| `domain.intelligence.ReportRun` | 报告执行、输入、模型、Prompt、成本和版本回放记录 | 必须可复现、可审计 |

## 3. 因果与报告关系

候选定义新增十条关系：

```text
GoalFacet ──FACET_OF──> Goal
ExternalFactor ──TRANSMITS_TO──> ExternalFactor
ImpactHypothesis ──HAS_DRIVER──> ExternalFactor
ImpactHypothesis ──TARGETS_GOAL_FACET──> GoalFacet
ImpactAssessment ──ASSESSES_HYPOTHESIS──> ImpactHypothesis
ImpactAssessment ──USES_EVIDENCE──> Evidence
ReportRun ──RUN_USES_ASSESSMENT──> ImpactAssessment
ReportRun ──PRODUCES_REPORT──> StrategicIntelligenceReport
StrategicIntelligenceReport ──REPORT_INFORMS_DECISION──> DecisionCase
StrategicIntelligenceReport ──REPORT_SCOPES_PRODUCT_LINE──> ProductLine
```

这组关系明确区分：

1. 外部世界的结构化因素；
2. 尚未验证的传导假设；
3. 某个时间窗内的证据化评估；
4. 面向经营决策的报告投影；
5. 经人审进入既有 Decision → P2 → Task 链路的入口。

## 4. 确定性函数与禁止能力

新增三个只读确定性函数：

- `validateImpactHypothesisActivation`：只校验 DRI、证据覆盖和状态，不执行激活。
- `buildStrategicReportInput`：按独立时间窗构造权限化结构化报告输入。
- `validateStrategicReportLineage`：校验来源快照、Evidence cutoff、模型、Prompt、Ontology 和因果图版本。

候选定义没有新增 Action Type。以下能力继续硬关闭：

- 自动创建正式 P2；
- 自动给员工下发任务；
- 自动写回 ERP；
- 自动写回社交媒体系统；
- 自动激活 Impact Hypothesis。

## 5. 兼容性方案

### 5.1 版本边界

| 项目 | 当前值 |
|---|---|
| 生产 active Schema | `3.3.0` |
| 生产 active Definition Hash | `41689393289d9514d1ed9cd22455a164f1bc59286f0db16deb9235e703e6ae77` |
| PESTIM 候选 Schema | `3.4.0` |
| PESTIM 候选 Definition Hash | `e254ee1f82d985828e50b6148b9ffd22f6f0e0ce920ebe75ff6bc6e55d9a5410` |
| 兼容性分类 | `compatible` |
| migration-required 变更 | `0` |

### 5.2 为什么不造成生产漂移

1. active `packages/ontology-contracts/definitions/manifest.json` 继续固定 `3.3.0`，没有引用 PESTIM 候选文件。
2. PESTIM 定义位于独立 contract，通过 `compilePestimStrategicIntelligenceProposal()` 与 active Definition 合并后离线编译。
3. 编译器只允许新增命名空间、对象、关系、函数、政策和约束；名称碰撞立即失败。
4. 兼容性比较必须返回 `compatible`；出现删除、继承变更、签名变更或 required 属性追加时立即失败。
5. `deploymentAllowed=false`，本阶段不存在 Registry 部署入口。

## 6. 激活门禁

候选 `3.4.0` 只有同时满足以下条件，才允许另行提交 Ontology Change Proposal：

1. Goal 7 P1-PROD-READINESS 完成；
2. P1-SI-B Source Registry 和许可策略获批；
3. HUD 首批 20–50 条关系完成多部门 DRI 评审；
4. 公司 QNAP 七天 Shadow 验收通过；
5. Ontology Change Proposal 由 `ontology-change-approver` 批准；
6. 部署后 Registry reconciliation 为 `in_sync`；
7. 自动 P2、员工任务下发、ERP/社媒写回继续使用独立授权门禁。

## 7. 自检证据

执行：

```bash
cd 2-Projects/company-ai-ontology/packages/ontology-contracts
npm test
```

结果：

- 测试 `18/18` 通过；
- P1-SI-A 新增测试 `3/3` 通过；
- 基线对象计数：`70 / 69 / 9 / 3 / 10 / 14`；
- 候选对象计数：`76 / 79 / 12 / 3 / 14 / 18`；
- 新增：6 Object、10 Link、3 Function、0 Action、4 Policy、4 Constraint；
- 兼容性变更共 27 项，全部为 `compatible`；
- `migration_required=0`。

## 8. 后续边界

P1-SI-A 只解决“语义骨架和兼容性”，不提前完成后续任务：

- P1-SI-B：Source Registry、许可、采集频率和保留期；
- P1-SI-C：公司版 Horizon Collector Contract；
- P1-SI-D：Raw Snapshot、Signal、物理数据表、双时间、去重和保留策略；
- P1-SI-E：报告机器契约、飞书模板和 H 控制面投影；
- P1-SI-F：公司 QNAP 七天 Shadow 验收包；
- P1-SI-G：HUD 20–50 条真实传导关系 DRI 评审。
