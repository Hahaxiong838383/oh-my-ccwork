# 公司 AI Ontology 后续 TODO

更新时间：2026-08-08（Asia/Shanghai）

## 当前结论

P0-A 至 P0-F、公司 Bot、通讯录、CPA H 引擎、知识 Connector 和认证后公网运行看板均已上线。V2.2 继续作为生产基线，V3 按“骨架完整、血肉渐进”增量建设。当前主要门禁是 V3 P0-S 骨架、公司专用 CPA 凭据、试点飞书文档分享权限、10 人真实 Canary 和真实 P2。

## P0-S：V3 大骨架先行

1. 固定 `system.ontology`、`core.identity`、`core.policy`、`core.epistemic`、`core.decision`、`core.work`、`core.action` 和各领域命名空间。
2. 建立统一对象基类、关系基类、双时间字段、来源和 Ontology 版本字段。
3. 建立统一 Event Envelope、跨域 correlation/causation、幂等和分类字段。
4. 建立 `ontology_registry`、`ontology_runtime`、`epistemic`、`decision`、`work`、`security`、`action`、`audit` 逻辑 Schema。
5. 建立 Ontology Definition DSL、Compiler、Registry、兼容性分级和 Git/运行时 reconciliation skeleton。
6. 固定 Data/Logic/Action 三类 Agent 工具契约，继续保持 Permissioned Retrieval 和 Mandatory Action Gateway 不可绕过。
7. 只写骨架、约束和少量样例，不批量导入公司全部数据，不提前穷举全部对象。

## P0-EPI：认识论最小闭环

1. 增加 Source、Observation、Evidence、Claim、Hypothesis、Assumption、Unknown、Contradiction、ValidityWindow 和 Provenance。
2. Permissioned Evidence Package 增加事实类型、来源、有效期、反证、未知项、置信度和 Ontology 版本。
3. Company Agent 回答明确区分源事实、推导事实、模型预测、人工判断、假设和未知。
4. 用一条 ERP 事实和一条社媒 Signal 完成正证、反证和假设验证。

## P0-DEC：决策与实践闭环

1. 增加 DecisionCase、DecisionAlternative、Scenario、ExpectedOutcome、ObservedOutcome、Verification 和 Learning。
2. Task Proposal 必须引用已批准 Decision；每条真实 P2 形成完整 Decision Lineage。
3. Action Gateway 在执行、读回和回滚之后增加业务结果与目标结果验证。
4. 用一个真实试点部门、一名 DRI 和一条真实 P2 完成端到端验收。

## 需要用户确认或提供

1. 准备公司专用 CPA Key/账号与同厂冗余，替换当前个人 CPA 依赖。
2. 将公司 App 加为试点文档协作者并授予分享权限读取；当前错误码为 `1063004`。
3. 指定一个真实试点部门、唯一 DRI 和一条真实 P2。

## P0-A 至 P0-F 状态

1. ✅ P0-A：H 引擎演示 Runtime、Mac Mini Xray、超时与并发准入。
2. ✅ P0-B：QNAP H-Lite shadow、签名 Adapter、SQLite 持久事件。
3. ✅ P0-C：权限检索、普通员工/DRI/未知用户负测、个人数据可见接口。
4. ✅ P0-D：十人任务编译、批准、投递、ACK、成果和验收闭环。
5. ✅ P0-E：Action Intent、dry-run、人审、执行、读回、审计与回滚。
6. ✅ P0-F：5/10/20 并发、Outbox 重投、容器重启恢复、PITR 和离机加密备份。

## 下一阶段

1. `P0-PROD-1 公司 Bot`：✅ App 凭据、QNAP H-Lite active、租户 Token、WebSocket 长连接和首名真实员工链路已完成；已读回 `p2p:post`、`p2p:text`、`group:text`，3 次处理全部完成、0 次失败、去重记录 3 条、容器无重启。下一步扩到 10 名真实员工，验证并发会话、群内多人 @ 隔离、回复送达与失败重投。
2. `P0-PROD-1.5 通讯录身份同步`：✅ 数据范围接口、部门分页、员工主动定位和最小字段同步已完成；4 个授权范围展开为 83 个可见部门和 414 名可见人员，二次同步新增 0、更新 414，敏感属性行数为 0。
3. `P0-PROD-2 H 引擎`：✅ 生产调用已上线。QNAP Agent Core 通过 HMAC 调用 dev198 Worker，Worker 通过个人 CPA API Key 调用 `grok-4.5`，真实推理和权限证据入 Prompt 已通过；下一门禁是公司专用 CPA Key/账号与同厂冗余。
4. `P0-PROD-3 公司知识 Connector`：🟡 代码、迁移、容器和 ACL fail-closed 已上线。支持 Docx/Sheet/Minutes、公开团队空间发现、人员/部门/空间 ACL 和中文自然问句召回；当前试点文档因 App 缺少分享权限被安全跳过，正文与标题未向无权限员工泄露。
5. `P0-PROD-4 真实 P2`：指定试点部门、唯一 DRI 和一条真实 P2，完成草案、批准、下发、执行协助、成果提交、退回/验收和状态读回闭环。
6. `P0-PROD-5 容量观测`：连续采集 24 小时并发、队列等待、H 引擎限流、Outbox backlog、错误率、P95 延迟和 QNAP 资源数据，再决定 20/50 人放量。
7. `P0-PROD-6 公网管理看板`：✅ `https://ai.kidshub.cn/admin/company-ontology` 已复用 H 控制面管理员认证；Mini 仅向 aliyun-hk 回环地址维护 QNAP 状态通道，页面展示绿色已完成与灰色待完成节点，不暴露 QNAP、凭据、文档正文或员工个人数据。

## P0-G：ERP 与社媒只读证据接管

1. 为爱视可 ERP M3 已验收对象建立只读 Connector：SKU、SN、质检、仓库、渠道订单、物流、激活和设备追溯。
2. 将 ERP 事实映射为 Ontology Entity、Relation 和 Evidence，不改变 ERPNext/Frappe 事务真源地位。
3. 接入 TikHub、JustOneAPI 和现有社媒系统的归一化业务结果，不把 HTTP 200 当作业务成功。
4. 社媒正文先进入不可信输入隔离区，只允许结构化 Signal 进入 Permissioned Retrieval。
5. 保持 MediaCrawler 风控任务暂停，未经明确指令不恢复、不绕过登录、不增加并发。
6. 先建立 Product/SKU/BOM/Firmware/SN/DeviceState 骨架；当前只读接入，不开放设备自动控制。

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
