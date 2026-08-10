# P1-SI 飞书人工审核工作台验收

日期：2026-08-10（Asia/Shanghai）

## 1. 结论

P1-SI-B 来源合规与 P1-SI-G P003 联合 DRI 审核已从 Git 脱敏模板落成真实飞书多维表格工作台：

- `engineering_verified=true`；
- `feishu_workbench_created=true`；
- `source_review_count=8`；
- `p003_review_count=36`；
- `source_final_decision_count=0`；
- `p003_final_decision_count=0`；
- `production_collection_allowed=false`；
- `production_activation_allowed=false`；
- `publish=false`。

工作台链接：`https://futurus.feishu.cn/base/OqLZbB3Tza2d1ysQUFlcuZkQnZx`

该 Base 使用当前用户 OAuth 身份创建在个人云空间，未使用公司 Bot 作为所有者，也未执行 owner 转移。当前只完成审核基础设施和数据模板落地，不代表任何来源或因果关系已获批准。

## 2. 表与数据

| 数据表 | Table ID | 字段 | 记录 | 当前状态 |
|---|---|---:|---:|---|
| 审核说明 | `tblRbjMftLcrowvc` | 4 | 8 条说明 | 仅操作说明 |
| 来源合规审批 | `tblNzcQnTKgkXvIt` | 21 | 8 | 全部 `pending` |
| P003 传导关系审核 | `tblxv6dYDmoOElhs` | 30 | 36 | 全部 `pending / inactive` |

两张审核表严格使用机器契约中的 CSV 原始列名，没有增加 ID、辅助状态或人员类型字段，避免飞书导出后因多列、少列或字段改名被 `assertCsvHeaders` 拒绝。

JSON 数组和对象继续保存为文本单元格，例如 Evidence、条件、指标、实名 Principal、参与者和 Review Checklist。这样飞书导出的内容能被现有 `import-csv` 还原为强类型 JSON，不依赖飞书人员字段的展示名格式。

## 3. 审核视图

来源表已建立：

- 全部来源；
- 待来源审批：8；
- Shadow 批准候选：0；
- 保持暂停或撤销：0。

P003 表已建立：

- 全部候选；
- 待联合审核：36；
- 产品定义与功能：6；
- 儿童用户与场景：6；
- 供应链成本质量：6；
- 渠道销售竞争：6；
- AI 技术能力：6；
- 隐私安全合规：6。

飞书 `OpenAPIUpdateViewFilter` 在连续设置筛选时触发方法级限流。执行过程没有立即重试；等待 65 秒后以 2 秒间隔补齐剩余筛选。最终所有视图均有预期条件，没有重复记录或数据写入漂移。

## 4. 飞书往返验证

实际从飞书 API 重新读取两张表，根据字段名恢复机器契约规定的列顺序并生成 CSV，再执行 `import-csv` 与普通 `validate`。

验证结果：

- 飞书来源表 `reviews` 与 Git 模板逐条 Hash 一致；
- 飞书 P003 表 `reviews` 与 Git 模板逐条 Hash 一致；
- 来源普通校验：`ok=true / reviewCount=8 / finalDecisionCount=0`；
- P003 普通校验：`ok=true / reviewCount=36 / finalDecisionCount=0 / approvalProposalCount=0`；
- Source Catalog Hash：`0ce4022adcfc177ced670a8d7fd2e4b4e119c2fc1bc5c19cabefb3223c010eae`；
- P003 Candidate Catalog Hash：`ba6a77fd52d1558c946bdaf5bad290f9898d3ce0d4c8af399a7ebba98df866ff`。

当前模板仍是 pending 状态，因此未执行或伪造 `validate --final` 成功。

## 5. 实名审核填写规则

1. `sourceKey`、`candidateKey`、Hash、来源入口、候选名称、原始逻辑、建议角色和候选指标属于只读锚点。
2. 数组和对象字段必须是合法 JSON 单元格。
3. 实名 Principal 使用：

```json
{"displayName":"姓名","principalRef":"company-directory:唯一标识"}
```

4. P003 `reviewParticipants` 是 JSON 数组，每个参与者必须包含 `displayName`、`principalRef`、`role` 和 `decision`。
5. 审核完成后分别导出两张表 CSV，先运行 `import-csv`，再运行 `validate --final`。
6. 任何缺列、锚点漂移、非法 JSON、证据缺失、角色缺失或 Principal 不合法都必须 fail-closed。

## 6. 当前未完成

- 尚未确定并邀请来源许可审核人和公司合规 DRI；
- 8 个来源没有真实 final decision，继续保持 `paused`；
- 尚未确定并邀请产品、AI、研发、销售、采购、财务及必要合规实名 DRI；
- P003 36 条没有真实 final decision，继续保持 `inactive`；
- 未执行 `validate --final`、compile、采集、发布、正式 P2、员工投递或业务写回；
- Goal 7、公司 QNAP 五元组复核、部署授权和七日 Shadow 仍未完成。

因此，本工作台关闭的是“没有真实审核入口”的工程缺口，不关闭任何真人审批或生产门禁。
