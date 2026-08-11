# P1-SI 实名 DRI 候选交接与部署门禁补强

日期：2026-08-10（Asia/Shanghai）

## 1. 结论

P1-SI-B 来源许可/合规和 P1-SI-G P003 联合审核的实名候选已完成只读收敛，但尚未任命、邀请或回填飞书：

- 通讯录初始候选：134；
- 进入岗位详情复核：42；
- 岗位详情读取失败：0；
- 产品、AI、研发、销售/市场、采购/供应链、财务、质量/制造：每类保留 4 名候选；
- 来源许可与合规/法务：未检索到可确认候选，必须由川哥人工指定；
- 任命人数：0；
- 邀请人数：0；
- 飞书回填数：0。

含员工个人信息的候选清单只保存在：

`/Users/rayman.chen/work-private/company-ai-ontology/reviews/p1-si-dri-candidates-2026-08-10.md`

对应机器数据只保存在同目录 JSON 文件，权限均为 `0600`；目录权限为 `0700`。姓名、Open ID、岗位和部门信息未进入 Git、共享记忆、截图或公开验收报告。

## 2. 候选生成原则

1. 只使用当前用户只读通讯录搜索和公司 Bot 只读岗位详情接口。
2. 排除未激活和跨租户用户。
3. 关键词搜索只形成候选，不代表组织授权或管理关系。
4. 每个角色按搜索相关度、岗位名称和部门线索排序，最多保留 4 人供川哥选择。
5. 合规、法务、审计和风控没有结果时，不允许用质量、财务或其他角色自动替代。
6. 模型不得自动任命 DRI、邀请员工或填写 final decision。

## 3. 川哥待拍板项

每类角色确认 1 名主审核人，可选 1 名备份审核人：

- 来源许可审核人；
- 公司合规/法务 DRI；
- 产品；
- AI；
- 研发；
- 销售/市场；
- 采购/供应链；
- 财务；
- 质量/制造。

确认后仍需单独授权将人员邀请到飞书审核工作台。邀请只授予审核入口，不代表来源获批或 P003 关系获准进入激活提案。

## 4. 本轮发现并修复的 P0 门禁

原 `deploy-shadow.sh` 已校验 Goal 7、来源审批、Collector Config 和不可变发布包，但没有机器校验 P003 36 条候选的实名最终审核。因此存在“来源已审批，但 P003 仍 pending 时进入 Shadow”的绕过可能。

现已新增：

- `scripts/validate-approved-p003-review.mjs`；
- 部署必填参数 `SI_APPROVED_P003_REVIEW_FILE`；
- 部署前强制执行 P003 `requireFinal=true` 校验；
- 36 条必须全部具有最终人工决定；
- 候选 Hash、源行 Hash、实名参与者、审核字段和状态必须通过契约；
- 所有关系必须继续保持 `inactive`；
- `productionActivationAllowed / formalP2Allowed / employeeDeliveryAllowed` 固定为 false。

任何 pending、候选漂移、缺实名参与者、字段缺失或关系被提前激活，都会在数据库迁移和服务启动前失败关闭。

## 5. 验证证据

- Ontology Contracts：`52/52`；
- Intelligence Collector：`7/7`；
- Strategic Intelligence Shadow：`11/11`；
- Shadow package validate：通过；
- 新增负测覆盖：pending 审核拒绝、提前激活拒绝、部署脚本必须接入 P003 审核验证器。

## 5.1 Goal 7 证据门禁补强

继续完成性审计后发现，原部署入口只检查 `GOAL7_STATUS=complete` 环境变量。该值可由操作者直接设置，不能证明 Goal 7 已完成工程验证，更不能证明川哥已人工验收。

现新增：

- `schemas/goal7-acceptance-evidence.schema.json`；
- `config/goal7-acceptance.template.json`，默认状态不可通过；
- `scripts/validate-goal7-acceptance.mjs`；
- 部署和独立数据库迁移入口均强制要求 `SI_GOAL7_ACCEPTANCE_FILE`；
- 部署只调用不可变发布包内的迁移脚本，不再调用外部旧脚本。

Goal 7 验收文件必须证明：

- `engineeringVerified=true`；
- `ownerAccepted=true`；
- Principal、实际发送者隔离、用途收窄、撤权 fail-closed 和正文读取前 ACL 已验证；
- Runtime 熔断、重试预算、成本预算和真实模型读回已验证；
- Route B 仍关闭；
- 产品研究部整库导入、真实员工 Canary、私人 Bot 迁移及 ERP/社媒写回仍关闭。

因此，单独设置 `GOAL7_STATUS=complete` 已无法进入数据库迁移或 Shadow 部署。

旧 Artifact `p1-si-runtime-2974c19eaab1282a0f2dd168ed7056e5a79e6f68` 不包含 P003 最终审核、成员真实权限体验和 Goal 7 文件化验收三项门禁，现仅作为历史 Runtime 证据保留，不再具有部署资格。Release Manifest 已升级为 `1.2.0 / P1-SI-F-shadow-candidate-gated`，并要求 `reviewerRoleAccessGateRequired=true`；旧 `1.1.0` 及更早 Manifest 会失败关闭。最终包必须在实名审核、成员权限体验和 Goal 7 完成后，从当时的已推送目标 Commit 重新生成。

## 6. 当前门禁

P1-SI Goal 继续保持 active：

1. 川哥确认实名 DRI；
2. 获得邀请审核人的独立授权；
3. 8 个来源完成真实许可/合规 final decision；
4. P003 36 条完成真实联合审核；
5. Goal 7 P1-PROD-READINESS 完成；
6. 从最终目标 Commit 生成新的不可变发布包；
7. 公司 QNAP 五元组在线复核；
8. 获得数据库迁移、部署、服务重启和真实回滚的分别授权；
9. 连续运行七个真实自然日 `PUBLISH=false` Shadow。

以上门禁完成前，不连接、部署或重启公司 QNAP，不关闭 Goal。
