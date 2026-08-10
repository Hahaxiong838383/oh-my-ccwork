# P1-SI-B Source Registry 工程验收

日期：2026-08-10（Asia/Shanghai）

## 1. 结论

P1-SI-B 的工程契约、候选数据模型、首批来源清单和 fail-closed 判定器已经完成并通过本地验收：

- `engineering_verified=true`；
- `compliance_approved=false`；
- `owner_accepted=false`；
- `production_deployed=false`。

当前 Source Registry 是 `candidate`，首批 8 个来源全部保持 `paused + license pending + compliance pending`。这不是缺陷，而是防止工程实现代替公司合规 DRI 作许可判断。任何 Collector 现在都会得到拒绝决定，直到来源被实名审批为 `enabled`。

## 2. 交付物

| 交付物 | 路径 | 状态 |
|---|---|---|
| Source Registry Ontology Contract | `packages/ontology-contracts/contracts/pestim-source-registry-v1.json` | 完成 |
| 首批来源候选目录 | `packages/ontology-contracts/catalogs/pestim-source-registry-candidate-v1.json` | 完成，全部暂停 |
| 结构校验、加载和 fail-closed 判定 | `packages/ontology-contracts/src/pestim-source-registry.mjs` | 完成 |
| CLI 编译入口 | `packages/ontology-contracts/bin/source-registry-compile.mjs` | 完成 |
| 正向和负向测试 | `packages/ontology-contracts/test/pestim-source-registry.test.mjs` | 完成 |

## 3. Ontology 增量

P1-SI-B 以 P1-SI-A `3.4.0` 为基线生成新的 contract-only 候选 `3.5.0`，没有修改 P1-SI-A 文件或 Hash。

新增：

- 2 Object：`SourceRegistryEntry`、`SourceRegistryDecision`；
- 3 Link：来源覆盖外部因素、Evidence 来源追溯、来源决策审计；
- 2 Function：来源结构校验、采集前授权判定；
- 0 Action；
- 3 Policy；
- 5 Constraint。

Source Registry 不提供采集、写回或激活动作，只提供采集前的确定性准入判定。

## 4. 数据模型覆盖

每个来源候选已结构化记录：

- source key、名称、类型、类别和业务 Owner；
- PESTIM 覆盖层；
- 官方入口和许可证据引用；
- 内部使用范围；
- 抓取频率、限流、超时和采集模式；
- 可信等级、历史准确率状态；
- 数据分类、保留期、删除策略和允许保存级别；
- 合规负责人、故障联系人和审批状态；
- 凭据模式、是否要求登录、是否涉及反自动化绕过；
- pending、enabled、paused、revoked 生命周期。

## 5. 首批来源候选

首批 8 个候选覆盖政治、经济、社会、技术、行业和市场：

1. arXiv official RSS/API；
2. OpenAlex official API；
3. World Bank Indicators API；
4. UNICEF Data Warehouse SDMX API；
5. U.S. Federal Register API；
6. SEC EDGAR Data APIs；
7. NIST NVD CVE API；
8. GitHub 指定仓库 Releases API。

选择原则：优先官方 RSS/API、公开结构化数据、无需个人登录和可限制为引用/元数据/摘要/结构化事实的来源。Google News、Hacker News、GDELT、媒体正文、社媒、登录态来源和浏览器反自动化来源没有进入首批可批准集合。

当前目录只是一份工程候选，不代表公司法务、合规或业务 Owner 已批准使用。

## 6. Fail-closed 判定顺序

每次采集前必须使用同一 Registry Snapshot 判定：

1. Registry 结构无效：`REGISTRY_INVALID`；
2. 来源不存在：`SOURCE_NOT_REGISTERED`；
3. pending、paused 或 revoked：拒绝；
4. 合规审批缺失：`COMPLIANCE_NOT_APPROVED`；
5. 许可未批准：`LICENSE_NOT_APPROVED`；
6. 许可过期：`LICENSE_EXPIRED`；
7. 使用个人账号：`PERSONAL_ACCOUNT_FORBIDDEN`；
8. 依赖登录：`LOGIN_REQUIRED_FORBIDDEN`；
9. 反自动化绕过：`ANTI_AUTOMATION_BYPASS_FORBIDDEN`；
10. 全文保存未经明确许可：`FULL_TEXT_RETENTION_NOT_APPROVED`。

只有全部门禁通过，才返回 `SOURCE_APPROVED`，同时把频率、限流、超时、存储级别、保留期和内部用途作为 Collector 的硬约束。

## 7. 验收证据

执行：

```bash
cd 2-Projects/company-ai-ontology/packages/ontology-contracts
npm test
npm run compile:pestim
npm run compile:source-registry
```

结果：

- 总测试 `24/24` 通过；
- P1-SI-B 新增测试 `6/6` 通过；
- P1-SI-A candidate Hash 保持 `e254ee1f82d985828e50b6148b9ffd22f6f0e0ce920ebe75ff6bc6e55d9a5410`；
- P1-SI-B candidate Schema：`3.5.0`；
- P1-SI-B candidate Hash：`082c4eec516ecc8a08fbd24ce21f3e97a34500dc5a010a715b108ef0137c6154`；
- Source Registry version：`1.0.0-candidate.1`；
- Source Registry Hash：`0ce4022adcfc177ced670a8d7fd2e4b4e119c2fc1bc5c19cabefb3223c010eae`；
- 兼容性变化 15 项，全部为 `compatible`；
- `migration_required=0`；
- 新增 Action Type：0。

## 8. 未执行事项

- 没有连接公司 QNAP；
- 没有部署、重启或修改生产 Registry；
- 没有启用任何真实来源；
- 没有保存外部正文；
- 没有使用任何个人账号、Cookie、Token 或 API Key；
- 没有发布飞书报告；
- 没有创建正式 P2、员工任务或 ERP/社媒写回。

## 9. 下一门禁

1. P1-SI-C 使用本 Registry Contract 建立独立 Collector Contract 和可部署雷达包；
2. 公司合规 DRI 逐项确认来源许可、存储级别、保留期和负责人；
3. 只有审批后的条目才能从 `paused` 变更为 `enabled`；
4. 来源审批不能授权 QNAP 部署，P1-SI-H 仍需 Goal 7 和当次明确生产授权。
