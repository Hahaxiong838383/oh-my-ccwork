# P1-SI 来源合规与 P003 DRI 人工审核闭环验收

## 1. 结论

P1-SI-B 来源合规审批与 P1-SI-G P003 DRI 审核已形成可重复、可校验、默认失败关闭的人工审核闭环：

```text
Git 中的脱敏 JSON/CSV 模板
  -> 导入飞书多维表格或电子表格
  -> 实名审核人填写
  -> 从飞书导出 CSV
  -> 本地 import-csv 还原强类型 JSON
  -> validate --final
  -> compile 生成 Shadow Registry 或激活提案候选
```

工程闭环完成不等于真实审批完成。当前 8 个来源仍保持 `paused`，36 条 P003 关系仍保持 `inactive`；没有启用采集、发布报告、创建正式 P2、员工投递或业务写回。

真实飞书审核工作台已经建立：`https://futurus.feishu.cn/base/OqLZbB3Tza2d1ysQUFlcuZkQnZx`。来源 8 条、P003 36 条已经导入，并完成飞书读取、CSV 重建、强类型 JSON 导入和普通校验往返验证；详细证据见 `p1-si-feishu-review-workbench-acceptance-2026-08-10.md`。当前仍未邀请或替代任何实名 DRI，也未伪造 final 校验。

## 2. 交付物

| 类型 | 文件 | 用途 |
|---|---|---|
| 来源审批契约 | `packages/ontology-contracts/contracts/pestim-source-approval-v1.json` | 固定许可、合规、保留和实名审批门禁 |
| 来源 JSON 模板 | `packages/ontology-contracts/templates/reviews/source-registry-review-template-v1.json` | 机器可读脱敏模板 |
| 来源 CSV 模板 | `packages/ontology-contracts/templates/reviews/source-registry-review-template-v1.csv` | 导入飞书供实名审核 |
| P003 审核契约 | `packages/ontology-contracts/contracts/p003-impact-review-submission-v1.json` | 固定语义重写、正反证据、指标和 DRI 门禁 |
| P003 JSON 模板 | `packages/ontology-contracts/templates/reviews/p003-impact-review-template-v1.json` | 36 条候选的机器模板 |
| P003 CSV 模板 | `packages/ontology-contracts/templates/reviews/p003-impact-review-template-v1.csv` | 导入飞书供联合审核 |
| CSV 解析器 | `packages/ontology-contracts/src/review-csv.mjs` | 支持 BOM、CRLF、引号、逗号和单元格换行 |
| 来源审核编译器 | `packages/ontology-contracts/src/source-approval-workbook.mjs` | CSV 导入、校验和 Shadow Registry 编译 |
| P003 审核编译器 | `packages/ontology-contracts/src/p003-review-workbook.mjs` | CSV 导入、校验和激活提案候选编译 |

## 3. 飞书审核约定

1. CSV 中数组和对象字段统一保存为 JSON 单元格，不能改成换行文本或角色名称缩写。
2. `sourceKey`、`candidateKey`、Hash、候选名称、来源入口、原始逻辑、建议角色和候选指标属于只读锚点。
3. 从飞书导出后，导入器会保留这些只读字段，校验器会识别被修改的名称、Hash、维度、来源入口、角色和指标。
4. 来源审核需要实名许可审核人和实名合规 DRI；`approve_for_shadow` 必须同时具备许可证据、合规证据、保存级别、保留期和审批时间。
5. `full_text` 不能在表格中直接批准，必须建立独立 Change Proposal。
6. P003 的 `approve_for_activation_proposal` 必须完成语义重写、支持证据、挑战证据、适用条件、方向、强度、滞后、指标基线、实名 DRI 和建议角色联合审核。
7. P003 审核通过只生成激活提案资格，关系仍为 `inactive`。

## 4. 操作流程

### 4.1 生成脱敏模板

```bash
cd 2-Projects/company-ai-ontology/packages/ontology-contracts
npm run review:source:generate
npm run review:p003:generate
```

把两个 CSV 文件分别导入飞书。JSON 模板用于机器对照，不在飞书中手工编辑。

### 4.2 导入飞书审核结果

实名审核结果包含人员信息，默认保存到 `~/work-private/company-ai-ontology/reviews/` 或批准的公司受控目录，不进入 Git、共享记忆、截图或公开日志。

```bash
npm run review:source:import-csv -- \
  --input /受控目录/source-registry-reviewed.csv \
  --output /受控目录/source-registry-reviewed.json

npm run review:p003:import-csv -- \
  --input /受控目录/p003-impact-reviewed.csv \
  --output /受控目录/p003-impact-reviewed.json
```

### 4.3 最终校验

```bash
node bin/source-approval-workbook.mjs validate \
  --input /受控目录/source-registry-reviewed.json --final

node bin/p003-review-workbook.mjs validate \
  --input /受控目录/p003-impact-reviewed.json --final
```

任一行仍为 `pending`、实名 Principal 无效、证据缺失、候选锚点漂移或审核字段不完整时，命令必须返回非零状态。

### 4.4 编译受控结果

```bash
node bin/source-approval-workbook.mjs compile \
  --input /受控目录/source-registry-reviewed.json \
  --output /受控目录/source-registry-shadow-reviewed.json

node bin/p003-review-workbook.mjs compile \
  --input /受控目录/p003-impact-reviewed.json \
  --output /受控目录/p003-impact-human-reviewed.json
```

来源编译结果只允许用于 `PUBLISH=false` Shadow；P003 编译结果只允许进入独立 Ontology Change Proposal。两个 compile 都不部署、不发布、不创建正式 P2，也不激活因果关系。

## 5. 安全与失败关闭

- CSV 缺列、多列、重复列、列数错误、非法引号或未闭合引号会被拒绝。
- 数组和对象字段不是合法 JSON 时会被拒绝。
- 来源目录或 P003 候选发生 Hash 漂移时会被拒绝。
- 来源只读字段和 P003 候选只读字段被修改时会被拒绝。
- 未完成全部最终决定时，`validate --final` 和 compile 会失败。
- 来源编译结果固定 `productionCollectionAllowed=false / publishAllowed=false`。
- P003 编译结果固定 `productionActivationAllowed=false / formalP2Allowed=false / employeeDeliveryAllowed=false`。

## 6. 本轮验收

- 人工审核测试：`11/11` 通过。
- CSV 模板生成、CSV 导入和非 final 校验均通过。
- 来源模板覆盖 8 个候选来源。
- P003 模板覆盖 36 条候选并包含 `reviewChecklist`。
- CSV 往返后数组、对象、数字、空值和审核状态保持强类型。
- 已验证只读字段篡改、非法 JSON、缺失证据、保留级别升级、模板化语义和来源 Hash 漂移负测。

## 7. 仍未完成的真实门禁

1. 8 个来源的公司实名许可与合规审批。
2. P003 产品、AI、研发、销售、采购、财务及必要合规 DRI 的真实联合审核。
3. Goal 7 P1-PROD-READINESS。
4. 从最终目标 Commit 生成公司 QNAP 不可变发布包。
5. 公司 QNAP 五元组在线复核和当次部署授权。
6. 七个真实自然日 `PUBLISH=false` Shadow。
