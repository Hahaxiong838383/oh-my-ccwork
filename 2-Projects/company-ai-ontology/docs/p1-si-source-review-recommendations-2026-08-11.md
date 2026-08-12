# P1-SI 来源许可与合规审核建议稿

日期：2026-08-11（Asia/Shanghai）

状态：`recommendation_only / human_final_decision_required / production_blocked`

## 1. 结论

建议首轮只对已经通过内部工程采集验证的 3 个公开来源执行窄范围 `approve_for_shadow`，其余 5 个来源明确 `keep_paused`。全部 8 条都需要实名许可审核人与合规 DRI 在飞书工作台作出最终决定，但本建议稿不能代替任何人工许可、合规判断或签字。

首轮批准范围统一收窄为：

- 仅限 `PUBLISH=false` Shadow；
- 仅保留引用、Hash 和必要元数据，不保存正文；
- 建议保留期 3 天；
- 不使用个人账号、登录态、Cookie、个人 Token 或反自动化绕过；
- 不允许正式报告发布、正式 P2、员工投递、ERP/社媒写回或因果关系激活；
- 任一许可、合规、来源状态或 Evidence 失效时立即失败关闭。

## 2. 8 个来源建议

| 来源 | 建议最终决定 | 建议保存级别 | 建议保留期 | 主要理由 | 人工审核必须补齐 |
|---|---|---|---:|---|---|
| `arxiv-official-rss-api` | `approve_for_shadow` | `reference_only` | 3 天 | 官方公开 RSS/API；无需登录和凭据；内部运行已验证 20 条、正文保留 0 | 官方条款快照、内部用途确认、实名许可审核人与合规 DRI、批准时间 |
| `federal-register-api` | `approve_for_shadow` | `reference_only` | 3 天 | 官方公开 API；无需登录和凭据；适合监管信号验证；内部运行已验证 20 条、正文保留 0 | 官方 API 条款快照、内部用途确认、实名许可审核人与合规 DRI、批准时间 |
| `github-approved-repository-releases` | `approve_for_shadow` | `reference_only` | 3 天 | 仅访问固定仓库白名单的 Release API；无需个人凭据；内部运行已验证 20 条、正文保留 0 | GitHub API 条款、逐仓库许可证核对、白名单确认、实名许可审核人与合规 DRI、批准时间 |
| `openalex-official-api` | `keep_paused` | 不变 | 不变 | 首轮与 arXiv 重叠，且 `company_managed` 凭据和内部账号治理尚未闭环，不应为扩大覆盖提前引入新依赖 | 暂停原因、实名合规 DRI、决定时间 |
| `world-bank-indicators-api` | `keep_paused` | 不变 | 不变 | 宏观结构化数据有价值，但尚未定义首轮指标白名单、地区口径、版本策略和 1095 天保留必要性 | 暂停原因、指标范围负责人、实名合规 DRI、决定时间 |
| `unicef-data-sdmx-api` | `keep_paused` | 不变 | 不变 | 与儿童及家庭场景相关，但 SDMX 数据集范围、许可证据、字段映射和最小必要保留尚未完成 | 暂停原因、数据集白名单、实名合规 DRI、决定时间 |
| `sec-edgar-data-api` | `keep_paused` | 不变 | 不变 | 竞争与供应商财务信号有价值，但公司标识映射、请求头/限流要求、使用范围和 1095 天保留必要性尚未验证 | 暂停原因、公司映射范围、实名合规 DRI、决定时间 |
| `nvd-cve-api` | `keep_paused` | 不变 | 不变 | 安全情报有价值，但产品组件/SBOM 映射、告警阈值、误报处置和高频采集成本尚未闭环 | 暂停原因、组件映射方案、实名合规 DRI、决定时间 |

## 3. 飞书工作台填写规则

### 3.1 `approve_for_shadow` 三条

人工审核人应填写：

- `decision=approve_for_shadow`；
- `licenseDecision=approved`；
- `complianceDecision=approved`；
- `approvedStorageLevel=reference_only`；
- `approvedRetentionDays=3`；
- `licenseExpiresAt` 按真实条款填写，长期有效才允许为 `null`；
- `licenseEvidenceRefs` 与 `complianceEvidenceRefs` 使用受控证据引用；
- `namedLicenseReviewer`、`namedComplianceDri` 使用结构化 Principal；
- `approvedAt` 使用真实审核时间；
- `decisionReason` 明确写出“仅限 Shadow、无正文、无业务副作用”。

不得把本文件中的建议文字直接当作许可或合规 Evidence。

### 3.2 `keep_paused` 五条

人工审核人应填写：

- `decision=keep_paused`；
- `namedComplianceDri` 使用结构化 Principal；
- `approvedAt` 使用真实决定时间；
- `decisionReason` 写明尚未闭环的具体条件；
- 其他批准字段保持空值，不得伪造 `approved` 状态。

## 4. 机器门禁

完成飞书人工填写后，必须重新导出并依次执行：

1. CSV 强类型导入；
2. `inspect-progress` 脱敏进度检查；
3. `validate --final` 最终校验；
4. Shadow Registry 编译；
5. 核对编译结果仅有 3 条 `approve_for_shadow`、5 条 `keep_paused`；
6. 核对 `productionCollectionAllowed=false / publishAllowed=false` 保持不变。

只有机器校验和实名人工决定同时通过，来源门禁才可从 `0/8` 更新为 `8/8`。这仍不授权生产部署、数据库迁移、Collector 运行或正式七日 Shadow。
