# 公司 AI Ontology 后续 TODO

更新时间：2026-08-14（Asia/Shanghai）

## 当前结论

P0-A 至 P0-F、公司 Bot、通讯录、CPA H 引擎、知识 Connector `2026-08-08.3`、V3 P0-S、Goal 4 P0-EPI、Goal 5 P0-DEC、Goal 6-A P1-DOMAIN 和 Task 6-R 均已完成工程验收。Goal 6-A 已获川哥人工体验确认；H `v1.58.2` 发布溯源为 `in_sync`，真实 Chrome `99/99`。10 名真实员工 Canary 继续关闭，不能因为工程 Goal 完成自动启动。

GEO Engine `0.4.1` 动态 API Control Room 已于 `2026-08-14` 上线 `geo.kidshub.cn`，Commit `4cade6c`。新文章固定使用 `deepseek-v4-flash` + 最高推理 `max`；当前 2 篇草稿、5 篇已审核待发布、0 篇仅导出、0 篇公开发布。最新同口径可见性实验为爱视可/`eyescare.cn` `0/100`、提及 `0/6`、域名引用 `0/6`，说明当前没有可观测效果。

## GEO 公网前端后续门禁

1. ✅ DNS、独立 TLS、认证、只读路径白名单、隧道 systemd、续期 dry-run 和重启恢复已通过。
2. ✅ GEO 主进程已迁入系统级 `geo-engine.service`，旧 user service 已 disabled/inactive，监听固定为 `127.0.0.1:8080`，模型 Key 已迁入 `0600` EnvironmentFile。
3. ✅ 新版 Control Room 已改为 `/health`、`/stats`、`/kb`、`/articles`、`/visibility/history`、`/meta`、`/experiments` 真实 API 动态加载，Tab active 在六个页面逐项通过。
4. ✅ 生成链路已锁定 `deepseek-v4-flash` + `reasoning_effort=max`，真实生产 Key 最小调用确认模型、最高推理和 reasoning usage 生效。
5. ✅ 已新增“AI 可见性检测”操作页，真实运行爱视可/`eyescare.cn` 获得 `0/100`，结果进入历史与实验账本。
6. ✅ 已新增“网站审计”操作页，公网目标校验、重定向逐跳校验、5MB 上限和 SSRF 内网阻断已测试；`ai.kidshub.cn` 登录页 smoke 为 `19/100`，不代表营销官网审计结论。
7. ✅ 资料包版本 `kbp-6adb88da8625` 与实验记录已上线；每次操作绑定资料包版本、引擎版本、耗时和结果摘要，实验时间按上海时区显示。
8. ✅ 已精确放行 POST `/articles/update`、`/publish`、`/gen`、`/kb/create`、`/kb/add`、`/fix`、`/visibility/multi`；全部保留 Basic Auth、方法白名单、限流、请求体上限和分接口超时，未开放整个 `8080`。接口可达不等于内容已获发布授权，Public Claim Package、人审和发布效果证据仍需在业务层落实。
9. ⏳ 选择首批已审核文章和外部发布平台，取得单独发布确认后记录公开 URL，再用同一问题集复测效果。
10. 🟡 多人使用前将 Basic Auth 升级为 H 管理员认证或公司统一身份；当前独立凭据不得进入 Git、Skill、记忆或协作消息。
11. 详细部署、验收和回滚见 `docs/geo-public-dashboard-deployment-2026-08-14.md`。

## 2026-08-10 Goal 顺序重排

1. `Goal 4`：✅ P0-EPI + 公司大脑工作逻辑显式建模，Intake 至可解释回答已生产 active。
2. `Goal 5`：✅ P0-DEC + Decision/P2/Task/Action/Verification/Learning 实践闭环已生产 active。
3. `Goal 6`：✅ QNAP P1-DOMAIN、Operating Model、3D-ready 协议、H `v1.58.2` 白盒和 Domain Connector 回滚恢复均已完成；Capability Governance v1 按范围保持 `contract_only`。
4. `Goal 6-UAT`：✅ 川哥人工体验验收通过。
5. `Task 6-R`：✅ 发布溯源、零重启补签、完整运行时 Manifest、单次重启发布与 Chrome `99/99` 已完成。
6. `Goal 7`：推荐下一工程 Goal，完成生产归属与权限主体就绪。
7. `Goal 3`：10 名真实员工 Canary，在 Goal 7 完成并单独授权后启动，仍是 20/50 人放量前硬门禁。

## 推荐后续 Goal 路线

### Goal 7：P1-PROD-READINESS 生产归属与权限主体就绪（推荐下一 Goal）

1. 🟡 P1-AUTHORITY 本地候选已完成：兼容 `type/member_type`、人员/部门/chat Principal、实际发送者隔离、多人艾特不扩权、私聊隔离、60 秒群成员 Evidence、用途收窄和会话授权快照；Agent Core `63/63`、Knowledge Connector `18/18`，尚未部署或执行飞书合成 Canary。
2. 🟡 P1-RUNTIME 本地候选已完成：Route A 独立熔断、有限重试、Token/费用预算、完整 provider/model/usage 强制读回和无正文用量审计；模型实际消耗后触发预算拒绝仍落账，Route B 固定关闭，当前凭据显式标记 `temporary_personal_credential`。
3. 🟡 012 Goal 7 候选迁移与独立 PostgreSQL 验证脚本已接入 Runtime Workflow；本机无 Docker，等待已推送 Commit 的 Linux CI 取得 4/4 RLS、二次幂等、真实 `ontology_app` 读写和 Route B disabled Evidence。
4. 🟡 Goal 7 Acceptance `2.0.0` 已完成：最终文件只能由 Runtime Workflow、真实 Worker 双源读回、飞书合成 Canary、QNAP 部署和 Evidence-bound Owner Acceptance 五份 Evidence 编译，并绑定 Ontology/H-Lite 双仓 Commit 与 H-Lite 源码归档 Hash；Owner Acceptance 记录器会重验前四份 Evidence 并保存其 SHA-256 与脱敏 Owner Principal Hash。替换原始文件、任一 Commit 漂移、提前验收、复制模板或手改最终 JSON 均失败关闭。四角色 UAT 同样升级为五份原始 Evidence 编译产物；Foundation 部署候选已把部署授权精确绑定双仓 Commit，并在迁移前重算完整 SHA/内部 Hash/Release Manifest；部署、012 迁移、三个服务重建、真实 Worker 读回和真实回滚演练均为独立授权；Strategic Intelligence 当前 `114/114`。
5. ⏳ 用公司专用 H 引擎账号/CPA Key 替换个人凭据依赖，并建立同厂第二路由；在此之前 Route B 不启用。
6. ⏳ 对少量合成知识资源执行部门、群聊、私聊、多人艾特、撤权、跨部门和 API 失败负测；不执行产品研究部整库导入。
7. ⏳ 完成 QNAP 备份、候选迁移、Agent Core/Knowledge Connector 部署、真实 H Worker读回、回滚、看板和 Bot 只读验收后，由川哥执行 Owner Acceptance。

### Goal 3：10 名真实员工 Canary

1. Goal 7 完成后，由川哥选择 10 名真实员工并明确 Canary 时间窗。
2. 覆盖私聊、多人群聊 @、并发隔离、权限差异、任务提案、批准、投递、ACK、成果提交、失败重投和 DRI 验收。
3. 不切换员工私人 Bot，不导入私人会话，不开放 ERP/社媒写回。
4. 输出真实送达率、权限拒绝率、错误率、P95 延迟、H 引擎成本和用户反馈。

### Goal 8：P1-SCALE 20/50 人扩容地基

1. 采集至少 24 小时并发、队列、限流、Outbox、错误率、P95 和 QNAP 资源数据。
2. 完成 H-Lite lease/fencing、待命副本、故障接管和短/长任务 Worker 分池。
3. 10 人 Canary 通过后先扩 20 人，容量指标和权限负测通过后再扩 50 人。

### 后续独立 Goal

- `Goal 9`：产品研究部整库导入，必须在 Principal/撤权语义完成后单独审批范围和窗口。
- `Goal 10`：Capability Governance 从 `contract_only` 升级为运行闭环。
- `Goal 11`：Agent-to-Agent Gateway，连接员工私人 Agent 与 Company Agent。
- `Goal 12`：真 3D WebGL 观察模式；不替代二维默认视图。
- `Goal 13`：ERP/社媒受控写回；ERP M4 与 MediaCrawler 仍需各自独立指令。

## P1-STRATEGIC-INTELLIGENCE：PESTIM 战略情报系统

1. ✅ 已读取 PESTIM 关系文档、27 个目标、108 个 GoalFacet、43 个外部维度和 4644 条完整传导矩阵。
2. ✅ 已确认 4644 条应作为 `generated_draft / unverified` Impact Hypothesis，不得直接成为事实或触发正式 P2。
3. ✅ 已完成个人站前沿资讯雷达评估：可复用 Horizon/Theory Radar 的采集、去重、评分、富化、影子运行和 last-good 门禁；不得原样迁移个人站、公开 Webhook、个人账号和报告目录。
4. ✅ `P1-SI-A`：已定义 ExternalFactor、GoalFacet、ImpactHypothesis、ImpactAssessment、StrategicIntelligenceReport 和 ReportRun；候选 Schema `3.4.0` 编译兼容并已以 contract-only 能力发布到公司 QNAP，生产 active `3.3.0` 未变更，测试 `18/18`、Registry `in_sync`、切换 2 秒、restart count 0。
5. 🟡 `P1-SI-B`：Source Registry contract-only 候选 `3.5.0`、首批 8 个来源、fail-closed 判定，以及“飞书 CSV → 强类型 JSON → final 校验 → Shadow Registry compile”人工审核闭环已完成工程验证；脱敏分配检查确认 8/8 已配置结构化许可审核 Principal 与合规 DRI，缺失和非法 Principal 均为 0，但最终决定仍为 0/8，全部来源继续 `paused`。
6. 🟡 `P1-SI-C`：公司独立 Collector Contract、3 份 JSON Schema、oneshot Worker、Source Registry 前置准入、去重、last-good、固定 Base Digest 和构建脚本已通过 `9/9` 测试；Artifact `9096846710` 因 QNAP 格式兼容问题拒绝，`9107441466` 因非原子切换风险被取代；最终 Commit `0342fcd39` 与 Artifact `9108034290` 已通过全量 Hash、QNAP 暂存和原子切换负测，并已更新到公司 QNAP 内部 Runtime。首次内部 Collector 已 accepted，正式生产采集仍为 0。
7. 🟡 `P1-SI-D`：contract-only 候选 `3.6.0`、Postgres 唯一真源、Raw/Observation/Signal、双时间、幂等/Replay、热冷保留和 ACL fail-closed 候选迁移已完成；Domain Batch → 010/011 单事务持久化、失败证据续写、逐日 `postgres_committed` 门禁和两次幂等/RLS 无 ACL 负测已在 Runtime Workflow `31508346323` 通过。当前只能标记 `engineering_runtime_verified`，生产数据库仍未迁移。
8. 🟡 `P1-SI-E`：候选 `3.7.0`、上海时区日/周/月/季/半年/年窗口、Alert/公司/P003 报告、非递归 Input Set、完整 ReportRun 谱系和飞书文档/卡片/H 控制面只读模板已通过 `36/36` 测试；未调用模型、未创建飞书产物、未执行候选 SQL。
9. 🟡 `P1-SI-F`：Shadow Compose、资源上限、无端口/无 Docker Socket、授权门禁、备份/Freeze/回滚、真实运行审计、Domain/Postgres 持久化证据、七日连续性/版本一致性、受控 Owner Acceptance、生产与内部独立 readiness、统一 QNAP Node Runtime、两阶段运行快照、首次内部运行 Evidence、四角色 UAT 编译验收、Goal 7 编译验收、H Worker 双源读回和 Goal Completion 门禁当前通过 `114/114`。正式 Foundation 部署候选只逐个切换 Agent Core、Knowledge Connector、H-Lite，强制关闭整库同步，部署前验证完整 SHA、六项内部 Hash、Release Manifest 和获批双仓 Commit，失败恢复旧配置/镜像并保留 additive 012。维护窗口计划固定总窗口 8～20 分钟、可感知间歇中断 15～120 秒、回滚 2～6 分钟，并要求发布、012、服务重建、真实 H Worker 读回、Owner Acceptance、真实回滚分别授权。Worker 读回必须由 H-Lite 正式 Adapter 的脱敏响应元数据和同 request 的 Postgres usage ledger 双源编译；Owner Acceptance 必须绑定前四份工程证据 Hash，二者均不能用配置标签或模板替代。Runtime Workflow `31508346323` / Artifact `9108034290` 仍是此前 `77/77` 历史证据；新代码还需双仓推送后重建包含 012、Goal 7 编译器、部署脚本及 H-Lite 源码归档的 Artifact。正式生产门禁继续不变。
10. 🟡 `P1-SI-G`：已只读核对真实 4644 条矩阵并筛选 P003 36 条候选，六类各 6 条；真实飞书审核工作台、CSV 回填、强类型 JSON、final 校验、只读锚点防篡改和提案候选 compile 均已完成工程验证。P003 已拆为产品与用户、AI 研发、品牌、To C 线下渠道四个记录级职能角色，各 1 名实名成员，旧宽泛角色成员为 0；`categoryKey` SingleSelect 转换后 36 条逐字段零漂移，正式导入器已兼容单元素数组。脱敏责任与进度检查器已接入：个人 DRI 30/36、必要角色位 90/150、全角色覆盖 12/36；实时审核进度仍为 36 pending、语义重写/支持证据/反证均为 0。当前仍缺供应链的采购/制造/质量/财务、渠道财务、AI 技术知识产权，以及隐私合规的法务/AI Safety/质量/采购；线上销售姓名仍未唯一确认；最终决定仍为 0/36，36 条全部保持 `pending / inactive`。成员本人逐一登录的记录级权限体验验收尚未完成。
11. ⏳ `P1-SI-H`：当前没有可继承的生产部署授权。来源实名合规审核、P003 实名联合 DRI 审核、四角色 UAT、Goal 7 文件化 Owner Acceptance 和正式 Postgres Runtime 证据均是独立硬门禁；全部通过并从最终已推送 Commit 重建不可变生产发布包后，仍需重新获得当次部署、迁移和运行授权，才可在公司 QNAP 连续运行 7 天 Shadow。每日必须形成 `postgres_committed` 证据，只写 Raw/Observation/Signal/Evidence/Impact/Report 草稿，不向全员 Bot 发布、不创建正式 P2、不写回 ERP/社媒。
12. 🟢 `internal_engineering_shadow` 工程地基与首次运行：最终 Commit `0342fcd39` / Artifact `9108034290` 已更新到公司 QNAP；旧 `a7aeae25e` 备份完整。Foundation 网络接线修复后，真实 Collector 对 3 来源各采集 20 条、总计 60 条、Hash-only、正文 0、重复 0，Evidence accepted；Foundation 13/13、异常 0、restart 0、临时容器/网络/端口归零，五类业务副作用为 0。内部 Evidence 不计入生产七日 Shadow。
13. ⛔ 自动创建正式 P2、向员工下发任务或写回 ERP/社媒继续关闭；只允许生成 Impact Assessment、报告和 Decision Proposal。
14. P1-SI-A～G 工程证据见对应 `docs/p1-si-*-2026-08-10.md`；内部模式见 `docs/p1-si-internal-engineering-shadow-2026-08-11.md`；人工审核闭环见 `docs/p1-si-human-review-workflow-acceptance-2026-08-10.md`；真实飞书工作台验收见 `docs/p1-si-feishu-review-workbench-acceptance-2026-08-10.md`；当前实名分配与机器校验见 `docs/p1-si-reviewer-assignment-readiness-2026-08-11.md`；来源审核建议见 `docs/p1-si-source-review-recommendations-2026-08-11.md`；P003 审核建议见 `docs/p1-si-p003-review-recommendations-2026-08-11.md`；总体方案见 `docs/pestim-strategic-intelligence-architecture-2026-08-10.md`。
15. 四职能角色真实权限体验按 `docs/p1-si-reviewer-role-access-uat-2026-08-11.md` 保留为 `deferred_before_production`；当前不要求成员操作。正式上线前采用风险分级审核，每位负责人只处理自己的筛选视图和少量高价值关系。
16. `2026-08-11` 最新状态：Strategic Intelligence 本地工程 `114/114`；Artifact `9108034290` 已更新为公司 QNAP 当前内部 Runtime，并完成 1 次 accepted 内部运行，但不包含本轮 Goal 7 双仓部署候选、UAT v2 编译器、Worker 双源读回和受控 Owner Acceptance。最近一次实机复核为 active Schema `3.3.0 / in_sync`、Foundation `13/13 running / unhealthy=0 / restart=0`、运行后战略情报容器/网络/端口为 0、数据库 Schema 仍 absent；3 来源共 60 条、Hash-only、正文 0，生产 Readiness 继续 `0/7 pass / WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH`。
17. 🟡 剩余门禁按最小批次执行：首次内部 Collector 已通过；来源建议 `3 approve_for_shadow + 5 keep_paused`；P003 六类各 1 条完整深审，但不强求六类都批准，当前建议汇总为 `4 approve_for_activation_proposal + 11 reject + 21 keep_inactive`；四角色 UAT 并行，随后完成 Goal 7。所有建议仍需实名人审，当前门禁保持来源 `0/8`、P003 `0/36`。详见 `docs/p1-si-remaining-gates-execution-pack-2026-08-11.md`。

## P0-KB-ACL：正式导入前硬阻断

1. ✅ `P0-KB-ACL-1`：文档 ACL 读取失败无条件跳过；即使空间 ACL 已知，也不读取正文、生成 Chunk 或索引。
2. ✅ `P0-KB-ACL-2`：只有文档直接 ACL 明确包含对应 `wikispaceid`，才展开知识空间成员；没有该标识时只保留文档直接 ACL。
3. ✅ 回归测试覆盖正文读取次数为 0、Chunk/ACL 为 0、空间权限不扩散、空 ACL 拒绝、空间 ACL 错误拒绝和错误码脱敏；Connector 14/14、Agent Core 14/14。
4. ✅ `2026-08-08.3` 已部署公司 QNAP；只读 Canary 覆盖直接授权、空间继承、无空间继承、ACL 失败、正文可读但 ACL 失败和真实员工撤权。
5. ✅ 有权员工 Evidence 命中、无权与撤权员工 Evidence 为 0；跨部门、原始 Token 和直接链接猜测均为 0，撤权收敛实测 37.757 秒。
6. ✅ 回滚 `2026-08-08.2 → 2026-08-08.3`、备份校验、临时文档删除、Canary 资源清理和最终 `ACL/Chunk=0` 通过。
7. ⏳ P1 补齐空间成员 `department/openchat` 映射，并定义 Retrieval 对 `chat/group` 授权主体的会话证据与撤权语义；完成前产品研究部整库导入继续禁止。

## ✅ P0-S：V3 大骨架先行

1. ✅ 固定 13 个命名空间、统一对象/关系基类、双时间、来源、版本和 Provenance 字段。
2. ✅ 建立 Event Envelope、correlation/causation、幂等、Purpose 和 Classification 契约。
3. ✅ 建立 7 个逻辑 Schema、3 张 Registry/对账表、Provenance、Domain Event 和 7 个稳定语义 View。
4. ✅ 建立 Git Definition、Compiler、兼容性分级、Registry、显式 Proposal/批准和 reconciliation。
5. ✅ 固定 Data/Logic/Action 三类工具契约，Data 只能走 Permissioned Retrieval，Action 只能走 Mandatory Action Gateway。
6. ✅ PostgreSQL 17 隔离验收、迁移重复执行、RLS、最小权限、历史版本再激活和双审计通过。
7. ✅ QNAP 生产 active 版本唯一：Schema `3.0.0`、71 个元素、Hash `0e1690bbced6`；重启与重复部署后数量不变。
8. ✅ H 控制面 `v1.49.1` 公网看板显示 7/7 组件就绪，真实 Chrome 控制台、页面异常、失败请求和横向溢出均为 0。

## ✅ P0-EPI：认识论最小闭环

1. ✅ WorkCase、WorkStage、Assumption、Unknown、EpistemicAssessment 已进入 Schema `3.1.0`，active 元素 90 个，Hash `117074b5e6b0`。
2. ✅ Intake、Scope、Authority、Context、Evidence、Synthesis、Response 已 active；Decision、Plan、Execution、Verification、Learning 保持 `contract_only`。
3. ✅ Permissioned Evidence Package v2 已带来源、有效期、反证、未知、置信依据、权限快照和 Ontology 版本。
4. ✅ 结构化回答 Validator 能拒绝越权证据、隐藏思维链、过期/冲突证据上的确定性结论。
5. ✅ ERP/社媒 fixture 的正证、反证、过期、无 ACL 和不存在 Principal 已在公司 QNAP 生产链验证。
6. ✅ 无 ACL 或不存在 Principal 时 Evidence 为 0，策略层失败关闭，不调用 H 引擎，不泄露标题、URL、人员或正文。
7. ✅ shadow→active、完整 Foundation 自检、旧版回滚、新版恢复、重启回放和敏感日志扫描通过。
8. ✅ H 控制面 `v1.52.0` 已完成 Goal 4 验收，当时 Goal 5 阶段保持灰色；Goal 5 完成后已升级到 `v1.53.0` 并标绿 P0-DEC。
9. 验收报告见 `docs/company-brain-work-protocol-acceptance-2026-08-09.md`。

## ✅ P0-DEC：决策与实践闭环

1. ✅ DecisionCase、DecisionAlternative、Scenario、ExpectedOutcome、ObservedOutcome、Verification 和 Learning 已进入 Schema `3.2.0`。
2. ✅ Task 编译强制引用已批准 Decision；未批准 Decision 的编译请求失败关闭。
3. ✅ Action Gateway 已区分执行读回、业务结果和经营目标结果，非法层级组合被拒绝。
4. ✅ 一名真实 DRI、一个受控 P2、一个 Task、一个 Action、一个 Verification、一个 Learning Proposal 已形成完整 Lineage。
5. ✅ 技术执行、业务结果、经营目标三层结果均为 `true`；Learning 保持 `proposed`，不自动修改系统。
6. ✅ 失败演练 `a–d` 保留审计：4 个 WorkCase `blocked`、2 条 Lineage `retired`、待执行失败 Lineage 为 0。
7. ✅ Schema `3.1.0` 受控回滚、`3.2.0` 恢复、重启回放、完整自检和敏感日志扫描通过。
8. ✅ H 控制面 `v1.53.0` 显示 9/9 组件、P0-DEC 绿色、Practice active 和 Goal Verified 1。
9. 验收报告见 `docs/decision-practice-loop-acceptance-2026-08-09.md`。

## Goal 6 当前状态：P1-DOMAIN + Operating Model

1. ✅ Company Brain Operating Model v1 已固化经营主干、12 类角色、生命周期和人工门禁。
2. ✅ 爱视可 ERP M3 已验收对象已通过只读 Connector 映射为 Operations/Device Read Model。
3. ✅ 既有社媒系统的归一化结果已映射为 Market Read Model；MediaCrawler 继续关闭。
4. ✅ Product、Device、Operations、Market 最小对象与关系已进入 Schema `3.3.0`，没有建设大而全企业本体。
5. ✅ 幂等、重放、Live Cursor 保护、Active/Deleted/Expired/Revoked、Dead Letter、错误恢复和无权角色负测通过。
6. ✅ 跨域只读演示链已形成 11 节点/9 关系，Decision/Task 保持提案态，ActionIntent 和 Delivery Outbox 均为 0。
7. ✅ 二维、2.5D、未来真 3D 共用的 Architecture DTO 已完成自动测试；真 3D 保持 `contract_only`。
8. ✅ H 控制面 `v1.55.1` 已发布，源码锚点 `02e3ab4`，证据提交 `6260061`；自动备份、管理员认证、`NRestarts=0` 和公网健康通过。
9. ✅ Domain Connector `2026-08-09.3 → .2 → .3` 真实回滚恢复完成；数据指纹、ERP 95、Market 369、ActionIntent 0 和 Outbox 0 保持不变。
10. ✅ 恢复后真实 Chrome 浏览器交互 `59/59` 通过。

## 需要用户确认或提供

1. 准备公司专用 CPA Key/账号与同厂冗余，替换当前个人 CPA 依赖。
2. P1 主体映射完成后，单独确认产品研究部知识库正式导入窗口和资源范围。
3. Goal 6-A 已完整收口；暂不需要选择 10 名真实员工。

## P0-A 至 P0-F 状态

1. ✅ P0-A：H 引擎演示 Runtime、Mac Mini Xray、超时与并发准入。
2. ✅ P0-B：QNAP H-Lite shadow、签名 Adapter、SQLite 持久事件。
3. ✅ P0-C：权限检索、普通员工/DRI/未知用户负测、个人数据可见接口。
4. ✅ P0-D：十人任务编译、批准、投递、ACK、成果和验收闭环。
5. ✅ P0-E：Action Intent、dry-run、人审、执行、读回、审计与回滚。
6. ✅ P0-F：5/10/20 并发、Outbox 重投、容器重启恢复、PITR 和离机加密备份。

## 下一阶段

1. `P0-PROD-1 公司 Bot`：✅ App 凭据、QNAP H-Lite active、租户 Token、WebSocket 长连接和首名真实员工链路已完成；按用户决定，10 名真实员工 Canary 继续延后到 Goal 6 大框架稳定后执行，不在当前阶段扩大真实用户范围。
2. `P0-PROD-1.5 通讯录身份同步`：✅ 数据范围接口、部门分页、员工主动定位和最小字段同步已完成；4 个授权范围展开为 83 个可见部门和 414 名可见人员，二次同步新增 0、更新 414，敏感属性行数为 0。
3. `P0-PROD-2 H 引擎`：✅ 生产调用已上线。QNAP Agent Core 通过 HMAC 调用 dev198 Worker，Worker 通过个人 CPA API Key 调用 `grok-4.5`，真实推理和权限证据入 Prompt 已通过；下一门禁是公司专用 CPA Key/账号与同厂冗余。
4. `P0-PROD-3 公司知识 Connector`：✅ `2026-08-08.3` 已生产部署，Connector/Agent Core 14/14、真实 ACL Canary、撤权、越权负测、备份与回滚通过；正式整库导入仍保持灰色，等待 P1 `department/openchat` 映射和单独批准，详见 `docs/knowledge-acl-canary-2026-08-08.md`。
5. `P0-PROD-4 架构试点 P2`：✅ 一名真实 DRI 的受控 P2 已完成 Decision、Task、Action、Verification、Learning 闭环；真实业务部门 P2 留到 Goal 6 领域接入后再选取。
6. `P0-PROD-5 容量观测`：连续采集 24 小时并发、队列等待、H 引擎限流、Outbox backlog、错误率、P95 延迟和 QNAP 资源数据，再决定 20/50 人放量。
7. `P0-PROD-6 公网管理看板`：✅ `v1.55.1` 已上线 Goal 6、安全修复、能力治理灰色白盒和连线路由修复；真实 Chrome `59/59`，认证、回环状态通道、控制台、失败请求、节点几何和横向溢出均正常。

## P0-G：ERP 与社媒只读证据接管

1. ✅ 爱视可 ERP M3 已验收对象已通过只读 Connector 映射为 Operations/Device Read Model。
2. ✅ ERPNext/Frappe 继续作为事务真源；Ontology 只保存受治理只读投影、Provenance 和同步审计。
3. ✅ 现有社媒系统归一化结果已映射为 Market Read Model；来源事实、推导、预测和人工判断显式区分。
4. ✅ 只允许结构化 Signal 进入领域层，敏感字段扫描为 0。
5. ✅ MediaCrawler 继续暂停，未恢复登录、采集或风控绕过。
6. ✅ Product、Device、Operations、Market 最小骨架已建立；设备自动控制和业务写回继续关闭。

## P1-B：扩容与高可用

1. 10 人真实 Canary 通过后扩至 20 人；只有 24 小时指标达标才扩至 50 人。
2. 为 H-Lite 主订阅实例补齐 lease/fencing、待命副本和故障接管演练，不影响员工私人 Bot。
3. 为 H 引擎 Worker 建立短任务/长任务分池、部门配额、优先级和背压策略。
4. 150 人阶段扩展 Mini/Studio 无状态 Worker Cell；300 人阶段按 public/product/erp/management 安全域分 Cell。
5. 每次扩容复测跨员工、跨部门、跨安全域越权，确认 Postgres 仍是唯一任务真源。

## P1-A：员工私人 Agent 与公司 Agent 协作

1. 建立 Agent-to-Agent Gateway，允许员工私人 Agent 在用户明确授权后调用 Company Agent Core。
2. 使用短期用户委托 Token，绑定 `person_id`、权限范围、用途、有效期和请求配额。
3. 私人 Agent 只能获得权限过滤后的 Evidence Package，不能直接访问 Ontology 数据库。
4. 默认不上传员工私人 Bot 历史会话；每次提交公司数据前明确提示并取得员工确认。
5. 完成私人 Agent 越权、Token 转用、跨员工冒用、重放和撤权测试。

## 明确不做

- 不迁移或切换现有员工私人 Bot。
- 不让公司 Bot 读取员工私人 Bot 会话全文。
- 不恢复 MediaCrawler 风控任务。
- 不开发爱视可 ERP M4。
- 在真实 Connector、业务审批策略、读回校验和回滚演练完成前，不启用 ERP、Git、报表或社媒系统写回。
