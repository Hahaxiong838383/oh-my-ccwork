# P1-SI Demo v1 交接说明

日期：2026-08-13（Asia/Shanghai）

## 1. 结论

当前阶段按“初步搭建架构和可体验 Demo”收口，不以正式生产运营闭环作为本阶段完工条件。

本阶段目标名称：`P1-SI Demo v1｜公司 PESTIM 战略情报架构骨架与可体验 Demo`。

当前工程骨架、不可变候选、QNAP 工程验证、内部采集样例和 H 控制面模拟审批均已具备。接手人应优先完成一次 5～10 分钟人工体验验收；通过后可关闭 Demo Goal。不要继续扩建正式审核、七日 Shadow、员工投递或业务写回。

## 2. Demo 完工标准

同时满足以下五项即可关闭本阶段：

1. **骨架完整**：Source Registry、Collector、Evidence、Signal、Impact Assessment、ReportRun/Report、P003 传导审核和 QNAP 部署拓扑均有契约、代码和测试。
2. **端到端样例跑通**：公开来源采集 → 准入 → 去重 → Hash/证据 → Signal/Impact → 报告草稿链路可以演示。
3. **H 控制面可体验**：架构白盒、运行看板和审批中心可打开；审批中心能展示并模拟 8 个来源、36 条 P003 关系。
4. **公司 Bot 可演示**：能解释架构状态、战略信号、对 P003 的潜在影响和报告草稿；证据不足时明确未知与置信等级。
5. **零业务副作用**：`PUBLISH=false`，P003 保持 `inactive`，正式 P2、员工投递、ERP 写回、社媒写回、因果激活均为 0。

## 3. 已完成工程事实

| 项目 | 当前证据 |
|---|---|
| Contracts | `61/61` |
| Collector | `9/9` |
| Strategic Intelligence | `142/142` |
| 当前不可变候选 | Workflow `31663036837` Attempt `1` / Artifact `9166921089` / Manifest `1.6.0` |
| Ontology Commit | `4a158d1d17141da905e9206dd54013cdac987039` |
| H-Lite Commit | `baa00bf07089a3caf5fe6318aac28cb73bd5ae13` |
| Goal 7 工程链 | A～E 已完成，五份 Evidence Hash 已由编译器复核 |
| H Worker | `cpa-openai-compatible / grok-4.5 / route-a` 双源读回一致 |
| Authority Canary | `7/7`，撤权收敛 `0.015 秒`，拒绝路径正文读取 0 |
| 回滚恢复 | 候选 → 旧版 → 候选，`34.709 秒`，012 保留 |
| QNAP Foundation | `13/13 running / unhealthy=0 / restart=0`（2026-08-13 只读快照） |
| 内部采集样例 | 3 个公开来源、60 条、Hash-only、正文 0、重复 0、业务副作用 0 |
| H 审批中心 | H 仓提交 `5dc4ee545fec02bf479bdc6f6c0cba2f65c351be`，8 来源 + 36 P003 工程模拟 |
| 公网入口 | `https://ai.kidshub.cn/admin/company-ontology`，未认证应跳转 `/admin` |

权威详情：

- `README.md`
- `docs/goal7-owner-acceptance-pack-2026-08-13.md`
- `docs/goal7-p1-prod-readiness-engineering-acceptance-2026-08-11.md`
- `deploy/qnap/strategic-intelligence/evidence/p1-si-current-gate-snapshot-2026-08-13.json`
- `docs/pestim-strategic-intelligence-architecture-2026-08-10.md`

## 4. 5～10 分钟接手验收

1. 打开 `https://ai.kidshub.cn/admin/company-ontology`，确认未登录跳转管理员登录。
2. 登录后分别查看“总体架构”“纵深诊断”“运行看板”“审批中心”。
3. 确认审批中心显示 8 个来源和 36 条 P003 关系；只做模拟填充/重置，不把它描述为实名终审。
4. 向公司智慧中枢 Bot 依次提问：
   - “当前战略情报系统有哪些数据来源和运行边界？”
   - “最近的外部信号可能如何影响 P003？”
   - “生成一份 P003 战略情报周报草稿，并列出证据、未知项和置信等级。”
5. 检查 Bot 不创建正式 P2、不投递员工任务、不写回 ERP/社媒。
6. 验收结果只需记录：页面是否可用、三次回答是否满足证据/未知/置信表达、业务副作用是否为 0。

## 5. 明确不属于当前 Demo Goal

以下事项转入后续生产化 Goal，不阻塞当前 Demo：

- 来源 `8/8` 实名合规终审；
- P003 `36/36` 实名联合 DRI 正式审核；
- 四角色真实权限 UAT；
- 公司专用 CPA 凭据和 Route B；
- 正式定时 Collector；
- 连续七个上海自然日 `PUBLISH=false` Shadow；
- 正式 P2、员工任务投递；
- ERP、社交媒体系统写回；
- 正式审核中心、工作簿导出等生产化功能。

## 6. 安全与运维红线

- 本项目 QNAP 只指公司 `PRNas / TS-X65 / 192.168.61.18`，根目录 `/share/CACHEDEV1_DATA/ai-ontology/foundation`；不得与家庭 QNAP 混淆。
- 未获得新的明确授权，不部署、不迁移数据库、不运行 Collector、不重启 Foundation/H 控制面、不执行真实回滚。
- Secret 只保存在批准的 Secret Store 或 QNAP 本地 `0600` 文件；不得进入 Git、文档、日志、截图或记忆。
- 外部资讯与模型结论只能形成 Observation、Signal、Hypothesis 或报告草稿，不得直接升级为 Fact、Decision、P2 或 Action。
- H 主仓可能存在 CC 在途修改；接手前先检查工作区，禁止覆盖、重置或混入无关变更。

## 7. 接手第一步

1. 只读核对仓库 HEAD、H 控制面版本和公网入口。
2. 按第 4 节完成 Demo 人工体验。
3. 若体验通过，新增一份简短 `P1-SI Demo v1 验收记录`，记录时间、页面结果、三次 Bot 问答结果和副作用计数。
4. 关闭 Demo Goal；生产审核、七日 Shadow 和业务动作另开 Goal，不能继承本次授权。

## 8. 仓库边界

本独立仓库只包含 `company-ai-ontology` 项目快照，不包含完整 `mycc`、H 平台仓库、个人凭据或其他项目。H 控制面实现位于独立的 `feishu-grok-bridge` 仓库，提交锚点见第 3 节。
