# P1-SI 剩余门禁最小执行包

状态：`ENGINEERING_CONTINUES_WITH_SYSTEM_APPROVAL_SIMULATION`

> 2026-08-12 决策：飞书多维表格不再作为工程推进卡点。审批最终在 H 控制面的公司 Ontology「审批中心」完成；当前先使用 `engineering_simulation` 验证流程，真人实名审批、角色权限 UAT 和 Evidence 绑定延后到系统整体测试阶段。该调整只解除工程开发阻塞，不解除生产门禁。

## 1. 结论

P1-SI-B～G 工程能力已完成，Strategic Intelligence 当前 `119/119`。当前唯一合格不可变候选为 Runtime Workflow `31607792883` Attempt `1` / Artifact `9145915628`，Manifest `1.3.0`、8 项完整 `SHA256SUMS`、Ontology Commit `b504f1295bf98b018479556c06e1072516966562`、H-Lite Commit `fab8be3f1467289400d0d63ffe378b63ad1a6957` 和三个组件版本身份均通过正式验证；Artifact `9142197870` 及更早候选仅保留历史工程证据。公司 QNAP 当前内部 Runtime 仍为 Artifact `9108034290`，且仅完成一次不计入生产 Shadow 的 accepted Collector。当前无需扩大本体、来源或 P003 范围；工程阶段继续完成系统审批中心和 Goal 7 准备，真人审核在整体测试阶段关闭，正式七日 Shadow 仍须等待全部真实门禁。

当前实测状态：

| 门禁 | 当前值 | 关闭条件 |
|---|---:|---|
| 来源最终决定 | 0/8 | 8/8 都有 final decision |
| P003 最终决定 | 0/36 | 36/36 都有 final decision，关系继续 inactive |
| 系统审批模拟 | ready for release | H 控制面 8/36 模拟交互、持久化、推荐和重置通过；不计入 final |
| 四角色成员 UAT | 0/4 | 四个真实账号完成允许与拒绝场景 |
| Goal 7 | incomplete | 工程证据和川哥 Owner Acceptance 完成 |
| 生产 Readiness | 1/7 | 当前仅不可变 Release 通过；其余六项全部关闭 |
| Goal Completion | 1/8 | 当前仅不可变 Release 通过；七个真实自然日及最终 Owner Acceptance 完成 |

`2026-08-12 13:54 CST` 飞书实时只读回拉确认：来源表 revision `38`，`8 pending / 0 final`；P003 表 revision `91`，`36 pending / 36 inactive / 0 final`，语义重写、支持证据、反证和审核时间完成数均为 `0`。`2026-08-12 22:50 CST` 新 Artifact `9145915628` 通过不可变 Release 门禁；现有门禁仍为 Deployment Readiness `1 pass / 6 blocked`、Goal Completion `1 pass / 7 blocked`。

## 2. 最小来源审核方案

推荐不一次性启用 8 个来源：

| 批次 | 数量 | 推荐决定 | 人工工作 |
|---|---:|---|---|
| 首批公开来源 | 3 | `approve_for_shadow` | 核对许可、合规证据、保存级别和 3 天保留期 |
| 其余候选来源 | 5 | `keep_paused` | 填写暂停原因、时间和合规 DRI，不进行采集 |

首批 3 个来源固定为当前内部 Runtime 已验证的 arXiv 官方 API、Federal Register 官方 API、GitHub 指定白名单仓库 Releases。批准只允许 Shadow，不代表生产采集许可，不允许全文保存，也不允许个人凭据、登录态或反自动化绕过。

全部 8 条必须有最终决定，是为了避免“未处理的 pending 来源”进入发布包；最终决定可以是继续暂停或撤销，不要求全部启用。

预计人工时间：许可/合规负责人集中审核约 30～45 分钟。

## 3. 最小 P003 审核方案

36 条已经满足目标要求的 20～50 条审核范围，不再扩大到 4644 条。推荐两级处理：

| 层级 | 数量 | 推荐决定 | 审核深度 |
|---|---:|---|---|
| 六类深审关系 | 6 | 4 条条件性 `approve_for_activation_proposal`、2 条 `reject` | 每类 1 条完整深审；不强求六类都批准 |
| 其余候选 | 30 | 21 条 `keep_inactive`、9 条 `reject` | 填写决定理由、审核时间和实名参与者，继续 inactive |

六类深审建议改为 `p003-impact-005 / 007 / 013 / 019 / 026 / 031`。其中 `005 / 007 / 013 / 026` 只有在实名 DRI 补齐真实正反证据和全部门禁后才建议形成激活提案候选；`019` 的目标是 HUD 销售，`031` 的目标是公司运营治理，建议作为负向对照直接拒绝。内部 Runtime 的六条样例只用于工程验证，不构成人审选样约束。

这样既完成 36 条真实审核，又把完整深审工作压缩到 6 条，同时证明目标错配会被门禁拒绝。即使 4 条通过，也只获得“激活提案资格”，本 Goal 内仍保持 `inactive`，不能自动生成 Decision、P2 或 Action。详细填写建议见 `p1-si-p003-review-recommendations-2026-08-11.md`。

预计人工时间：六类 DRI 可并行，深审约 60～90 分钟；其余 30 条快速决定约 30～45 分钟。

## 4. 四角色 UAT 最小闭环

四个真实成员分别只需一次 10～15 分钟会话：

1. 登录本人账号；
2. 验证允许类别可临时编辑并立即恢复；
3. 验证未分配类别不可编辑；
4. 验证来源表、新增、删除、复制、下载和修改视图均被拒绝；
5. 写入受控 Evidence 引用，不把截图、姓名或 Principal 放入 Git。

四个角色可以并行执行。全部完成后由安全负责人统一 `securityOwnerAccepted=true`。

## 5. Goal 7 最小闭环

Goal 7 不重复做 P1-SI 工程测试，只验收公司级生产地基：

- Principal、发送者隔离、Purpose 收窄和撤权失败关闭；
- 读取正文前 ACL；
- 熔断、重试预算、成本预算和真实模型读回；
- Route A 可用，Route B 保持关闭；
- 产品研究部整库导入、真实员工 Canary、员工私人 Bot 迁移、ERP/社媒写回继续关闭；
- 川哥对以上证据执行 Owner Acceptance。

Agent Core `2026-08-12.2` 已作为独立回复修复上线并通过真实主体正测、未知主体权限负测，但该单服务发布不能替代 Goal 7 的三组件 Deployment Evidence、Authority Canary、Worker 双源读回或 Owner Acceptance。

Goal 7 验收文件只引用既有工程证据，不复制敏感内容。

## 6. 调整后的最短执行顺序

1. ✅ 已完成一次内部 Collector：3 来源、60 条、Hash-only、零业务副作用，机器 Evidence accepted；
2. 完成 H 控制面系统审批中心工程版并发布；飞书 Base 只保留历史导入/导出；
3. 继续完成 Goal 7 Authority Canary、Worker 双源读回和完整三组件 Deployment Evidence 的工程准备；
4. 系统整体测试阶段，由许可/合规负责人完成 3 批准 + 5 暂停；
5. 六类 DRI 并行完成 6 条深审，其他 30 条快速保持 inactive；
6. 四名角色成员在系统审批中心完成实名权限 UAT；
7. 由川哥完成 Evidence-bound Goal 7 Owner Acceptance；
8. 若人审或代码改变发布输入，从最终已推送 Commit 重建不可变生产 Artifact；否则沿用并再次校验 Artifact `9145915628`；
9. 分别取得 Foundation 发布、012 候选迁移、三组件服务重建授权；
10. 连续运行七个真实上海自然日 `PUBLISH=false` Shadow；
11. 第七日后完成 Owner Acceptance 和 Goal Completion 编译。

## 7. 当前需要真人完成的最小动作

| 责任角色 | 最小动作 | 完成证据 | Agent 可否代办 |
|---|---|---|---|
| 来源许可/合规审核人 | 在来源表逐条完成 8 个 final decision；推荐 3 条 `approve_for_shadow`、5 条 `keep_paused` | revision 提升、8/8 final、许可/合规证据和保存期限完整 | 不可代签 |
| P003 各类实名 DRI | 六类各完成 1 条深审，其余 30 条完成快速决定；全部继续 `inactive` | 36/36 final，正反证据、语义重写、审核时间和参与者完整 | 不可代签或伪造证据 |
| 四名真实角色成员 | 各完成一次本人权限允许与拒绝 UAT | 4 份不同真实成员 Session Evidence | 不可模拟真实账号 |
| 安全负责人 | 核验四份 Session 后完成统一接受 | `securityOwnerAccepted=true` 且绑定四份 Session Hash | 不可提前接受 |
| 川哥 | 在 Authority Canary、Worker 双源读回和三组件 Deployment Evidence 完成后执行 Goal 7 Owner Acceptance | Evidence-bound Owner Acceptance | 必须本人拍板 |

在上述真人动作完成前，Agent 可以继续系统审批中心、Goal 7 和发布准备等工程开发，也可以使用明确标记的模拟数据自检；不得把模拟或 pending 批量改成真实 final，不得运行生产 Collector、010/011、七日 Shadow，也不得申请把当前 Goal 标记完成。

## 8. 仍不可合并的授权

- 内部一次性 Collector；
- 生产部署；
- 数据库迁移；
- 必要服务重启；
- 真实回滚演练；
- 七日 Shadow Owner Acceptance。

任何一项授权不得自动继承到下一项。
