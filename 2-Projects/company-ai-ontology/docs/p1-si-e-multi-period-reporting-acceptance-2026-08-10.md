# P1-SI-E 多周期战略情报报告工程验收

日期：2026-08-10（Asia/Shanghai）

## 1. 结论

日报、周报、月报、季度、半年度、年度、即时 Alert、公司经营和 P003 专项报告的机器契约已经完成：

- `engineering_verified=true`；
- `ontology_candidate=3.7.0`；
- `projection_templates_verified=true`；
- `sql_static_verified=true`；
- `sql_runtime_verified=false`；
- `production_deployed=false`；
- `publish_enabled=false`。

报告系统当前只定义结构化输入、运行谱系和只读投影，不调用模型、不创建飞书文档、不向全员 Bot 发布。

## 2. 报告类型

| 类型 | 窗口 |
|---|---|
| Daily | 上一个完整上海自然日 |
| Weekly | 上一个完整 ISO 周，周一至下周一 |
| Monthly | 上一个完整自然月 |
| Quarterly | 上一个完整自然季度 |
| Semiannual | 上一个完整半年 |
| Annual | 上一个完整自然年 |
| Alert | 重大事件显式窗口 |
| Company | 公司经营显式窗口 |
| P003 | P003 读写台及 AI 产品显式窗口 |

所有周期统一使用 `Asia/Shanghai`，内部保存 UTC ISO timestamp，避免日报、周报和月报在边界处使用不同口径。

## 3. 非递归报告原则

Report Input Set 只允许：

- Raw Snapshot；
- External Observation；
- Strategic Signal；
- Evidence；
- Impact Assessment；
- Operating Metric。

明确禁止：

- report；
- report text；
- 飞书文档正文；
- rendered summary。

因此周报不能总结日报正文，月报不能总结周报正文。不同周期必须重新读取对应窗口内的结构化事实、证据和评估并计算 input hash。

## 4. Ontology 增量

P1-SI-E 以 P1-SI-D `3.6.0` 为不可变基线，生成候选 `3.7.0`：

- 3 Object：`ReportInputSet`、`ReportProjection`、`StrategicIntelligenceAlert`；
- 4 Link；
- 3 Function；
- 0 Action；
- 4 Policy；
- 5 Constraint。

Alert 只能打开 WorkCase 或形成 Decision Proposal，不能创建正式 P2 或员工任务。

## 5. ReportRun 谱系

每次运行必须记录：

- report type；
- period start/end；
- evidence cutoff；
- source snapshot IDs；
- source registry、Ontology 和 causal graph 版本；
- input hash；
- model provider 和真实 model ID；
- prompt version；
- input/output token；
- cost microunits；
- duration；
- status、error code 和 retry count。

即使报告因 Evidence 不足或模型失败而失败，也必须保留 ReportRun，而不能只保存一段错误文字。

## 6. 三类投影

### 飞书文档

包含经营结论、变化、PESTIM 地图、P003 影响、正反证据、未知限制、Decision Proposal 和完整谱系。禁止 Raw Body、Secret、个人标识和无权内容。

### 飞书卡片

只允许“打开有权报告”和“请求审核”，禁止创建正式 P2、员工任务以及 ERP/社媒写回。

### H 控制面

显示 Run Health、Source Coverage、Signal Freshness、Evidence Conflict、P003 Impact Graph、Lineage、成本和关闭门禁。服务端白名单投影，`writeControls=false`。

## 7. 候选数据库扩展

`deploy/qnap/candidate-migrations/011-pestim-reporting.sql` 新增：

- `report_input_sets`；
- `report_projections`；
- `alerts`；
- `alert_evidence`；
- `report_runs.input_set_id`；
- Report/Alert ACL 读取策略。

SQL 仍留在 `candidate-migrations/`，未进入自动生产迁移目录。

## 8. 测试证据

执行：

```bash
cd 2-Projects/company-ai-ontology/packages/ontology-contracts
npm test
npm run compile:reporting
```

结果：

- 初始验收时总测试 `36/36` 通过；`2026-08-11` 补齐模型失败终态谱系后，Ontology Contracts 全量回归为 `60/60`；
- P1-SI-E 新增测试 `6/6` 通过；
- P1-SI-D candidate Hash 保持 `2088f360866285a9f860107a91c3da32faefae6dc7c573ed9580603f9a4fea5d`；
- Candidate Schema：`3.7.0`；
- Candidate Hash：`c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860`；
- 兼容性变化 19 项，全部为 `compatible`；
- `migration_required=0`；
- 新增 Action Type：0；
- 上海时区日/周/月/季/半年/年窗口测试通过；
- 输入顺序变化不改变 input hash；
- report text 递归输入负测通过；
- 缺失模型、成本、状态和弱 Hash 负测通过；
- 模型失败必须保留 `failed` 状态、稳定错误码、重试次数、开始/结束时间、耗时、token 与成本；缺错误码或结束时间失败关闭，成功状态夹带错误码同样拒绝；
- 三类投影模板的只读及敏感字段门禁通过。

## 9. 未执行事项

- 未调用 H 引擎或任何模型；
- 未生成真实日报、周报或 P003 报告；
- 未创建飞书文档或卡片；
- 未修改 H 控制面；
- 未执行数据库迁移；
- 未连接公司 QNAP；
- 未创建 WorkCase、Decision、P2、员工任务或业务写回。

## 10. 下一步

1. P1-SI-F 实际构建 Collector 镜像，并在隔离环境执行 010/011 候选迁移与回滚；
2. 固定 CPU、内存、磁盘、网络、超时、失败率、成本和 last-good 指标；
3. 形成 QNAP Shadow 部署包，但不执行生产切换；
4. P1-SI-G 形成 P003 20–50 条关系候选和 DRI 审核包。
