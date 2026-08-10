# 公司 AI Ontology 后续 TODO

更新时间：2026-08-10（Asia/Shanghai）

## 当前结论

P0-A 至 P0-F、公司 Bot、通讯录、CPA H 引擎、知识 Connector `2026-08-08.3`、V3 P0-S、Goal 4 P0-EPI、Goal 5 P0-DEC 和 Goal 6-A P1-DOMAIN 均已上线并完成当前授权范围验收。Domain Connector 已完成 `.3 → .2 → .3` 真实回滚恢复；Company Capability Governance v1 保持 `contract_only`。H 控制面 `v1.55.1` 恢复后真实 Chrome `59/59` 通过。10 名真实员工 Canary 继续延后。

## 2026-08-09 Goal 顺序重排

1. `Goal 4`：✅ P0-EPI + 公司大脑工作逻辑显式建模，Intake 至可解释回答已生产 active。
2. `Goal 5`：✅ P0-DEC + Decision/P2/Task/Action/Verification/Learning 实践闭环已生产 active。
3. `Goal 6`：✅ QNAP P1-DOMAIN、Operating Model、3D-ready 协议、H `v1.55.1` 白盒和 Domain Connector 回滚恢复均已完成；Capability Governance v1 按范围保持 `contract_only`。
4. `Goal 3`：10 名真实员工 Canary，继续延后但仍是 20/50 人放量前硬门禁。
5. 公司专用 CPA 凭据和 P1 `department/openchat` 映射可并行推进，不改变业务验收顺序。

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
