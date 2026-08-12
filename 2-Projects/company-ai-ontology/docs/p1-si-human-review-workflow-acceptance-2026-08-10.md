# P1-SI 来源合规与 P003 DRI 人工审核闭环验收

> 2026-08-12 架构更新：飞书多维表格只保留为早期原型、历史数据导入和应急导出通道，最终审批操作面迁移到 H 控制面的公司 Ontology「审批中心」。当前审批中心先以 `engineering_simulation` 验证 8 个来源和 36 条 P003 关系的字段、交互、持久化与失败关闭；正式实名审批、角色权限和 Evidence 绑定在系统测试阶段接入。模拟审批不得满足任何生产门禁。

## 1. 结论

P1-SI-B 来源合规审批与 P1-SI-G P003 DRI 审核已形成可重复、可校验、默认失败关闭的审核数据契约。最终目标链路调整为：

```text
Ontology/Postgres 审批对象与 Evidence
  -> H 控制面公司 Ontology「审批中心」
  -> 实名 Principal 按角色和 ACL 审核
  -> 审批结果写回 Ontology/Postgres
  -> validate --final
  -> compile 生成 Shadow Registry 或激活提案候选
```

飞书 Base/CSV 链路继续可用，但定位为原型、历史导入和灾备导出，不再是审批真源，也不再阻塞当前工程推进。系统审批中心当前采用本地 `0600` 模拟草稿 Store，等生产 `010/011` 和审批对象迁移获得单独授权后，再切换到 Ontology/Postgres 真源。

工程闭环完成不等于真实审批完成。当前 8 个来源仍保持 `paused`，36 条 P003 关系仍保持 `inactive`；没有启用采集、发布报告、创建正式 P2、员工投递或业务写回。

历史飞书审核工作台已经建立：`https://futurus.feishu.cn/base/OqLZbB3Tza2d1ysQUFlcuZkQnZx`。来源 8 条、P003 36 条已经导入，并完成飞书读取、CSV 重建、强类型 JSON 导入和普通校验往返验证；详细证据见 `p1-si-feishu-review-workbench-acceptance-2026-08-10.md`。该工作台不再承担最终操作面或事实真源。当前仍未邀请或替代任何实名 DRI，也未伪造 final 校验。

H 控制面系统审批中心的当前工程状态：

- 三个页面 Tab：架构白盒、运行看板、审批中心；
- 8 个来源和 36 条 P003 关系均可交互填写模拟决定与备注；
- 支持一键填充推荐模拟决策、持久化和重置；
- P003 的 `activationStatus` 始终固定为 `inactive`；
- `productionApprovalEligible=false`；
- `productionGateSatisfied=false`；
- 模拟完成不授权 Collector、010/011、七日 Shadow、P003 激活、正式 P2 或任何写回。

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

## 3. 系统审批约定

1. Ontology/Postgres 是最终审批真源，H 控制面只提供权限化交互投影；飞书 Base/CSV 只用于原型、历史导入和应急导出。
2. `sourceKey`、`candidateKey`、Hash、候选名称、来源入口、原始逻辑、建议角色和候选指标属于只读锚点。
3. 系统必须识别只读锚点、Evidence、Principal、角色、时间和决定的漂移；导入飞书历史数据时沿用现有 CSV 校验器。
4. 来源审核需要实名许可审核人和实名合规 DRI；`approve_for_shadow` 必须同时具备许可证据、合规证据、保存级别、保留期和审批时间。
5. `full_text` 不能在表格中直接批准，必须建立独立 Change Proposal。
6. P003 的 `approve_for_activation_proposal` 必须完成语义重写、支持证据、挑战证据、适用条件、方向、强度、滞后、指标基线、实名 DRI 和建议角色联合审核。
7. P003 审核通过只生成激活提案资格，关系仍为 `inactive`。

## 4. 操作流程

### 4.1 当前工程模拟

当前通过 H 控制面 `/admin/company-ontology#approvals` 验证操作流程。模拟 Store 只允许保存脱敏决定和备注，文件权限为 `0600`，不写入生产 Ontology 表，也不具备生产放行资格。

### 4.2 历史飞书模板与导入

```bash
cd 2-Projects/company-ai-ontology/packages/ontology-contracts
npm run review:source:generate
npm run review:p003:generate
```

把两个 CSV 文件分别导入飞书。JSON 模板用于机器对照，不在飞书中手工编辑。

### 4.3 导入历史飞书审核结果

实名审核结果包含人员信息，默认保存到 `~/work-private/company-ai-ontology/reviews/` 或批准的公司受控目录，不进入 Git、共享记忆、截图或公开日志。

```bash
npm run review:source:import-csv -- \
  --input /受控目录/source-registry-reviewed.csv \
  --output /受控目录/source-registry-reviewed.json

npm run review:p003:import-csv -- \
  --input /受控目录/p003-impact-reviewed.csv \
  --output /受控目录/p003-impact-reviewed.json
```

### 4.4 最终校验

```bash
node bin/source-approval-workbook.mjs validate \
  --input /受控目录/source-registry-reviewed.json --final

node bin/p003-review-workbook.mjs validate \
  --input /受控目录/p003-impact-reviewed.json --final
```

任一行仍为 `pending`、实名 Principal 无效、证据缺失、候选锚点漂移或审核字段不完整时，命令必须返回非零状态。

### 4.5 编译受控结果

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
- `engineering_simulation` 数据无论是否 8/8、36/36 完成，都不能进入 final 校验或生产编译输入。
- 系统审批中心正式模式必须绑定真实 Principal、角色授权、Evidence 和审计记录；缺一项即失败关闭。
- 来源编译结果固定 `productionCollectionAllowed=false / publishAllowed=false`。
- P003 编译结果固定 `productionActivationAllowed=false / formalP2Allowed=false / employeeDeliveryAllowed=false`。

## 6. 本轮验收

- 人工审核测试：`11/11` 通过。
- CSV 模板生成、CSV 导入和非 final 校验均通过。
- 来源模板覆盖 8 个候选来源。
- P003 模板覆盖 36 条候选并包含 `reviewChecklist`。
- CSV 往返后数组、对象、数字、空值和审核状态保持强类型。
- 已验证只读字段篡改、非法 JSON、缺失证据、保留级别升级、模板化语义和来源 Hash 漂移负测。
- H 控制面审批中心专项测试覆盖 8 个来源、36 条 P003 关系、模拟持久化、一键推荐、重置、非法决定拒绝和 P003 始终 inactive。
- 真实浏览器验收覆盖 Tab 切换、8/36 显示、推荐后 `8/8` 与 `36/36`、重置后 `0/8` 与 `0/36`，且生产门禁始终关闭。

## 7. 仍未完成的真实门禁

1. 8 个来源的公司实名许可与合规审批。
2. P003 产品、AI、研发、销售、采购、财务及必要合规 DRI 的真实联合审核。
3. Goal 7 P1-PROD-READINESS。
4. 从最终目标 Commit 生成公司 QNAP 不可变发布包。
5. 公司 QNAP 五元组在线复核和当次部署授权。
6. 七个真实自然日 `PUBLISH=false` Shadow。
