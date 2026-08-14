# Company AI Ontology

公司级 AI Ontology 基座实施项目。P0-A 至 P0-F、V3 P0-S Foundation Pack、Goal 4 P0-EPI、Goal 5 P0-DEC 和 Goal 6 P1-DOMAIN 只读领域骨架已在公司 QNAP 部署并完成当前层级生产验收；现有 H 平台员工私人 Bot 保持不变，真实 ERP/社媒写回继续关闭。

## 资产身份门禁

- 本项目中的 `QNAP` 只指公司局域网生产 NAS：SSH 别名 `prnas` / `prnas-pub`、型号 `TS-X65`、当前地址 `192.168.61.18`。
- 家庭 QNAP 不属于本项目，不得复用本项目的部署目录、Compose、端口、卷、凭据、备份、恢复或运维结论。
- 任何 QNAP 读取、部署、重启、备份或恢复操作前，必须重新核对“用途=公司、主机别名、型号、当前地址、项目根目录”五元组；任一项不一致立即停止，禁止根据“QNAP”三个字猜目标。
- 地址、版本、容量和服务状态都是时间快照，执行生产操作前仍需读取共享记忆并做在线核验。

## 当前状态

- 生产架构基线：V2.2，QNAP 承载 H-Lite、Company Agent Core、Ontology 控制面和数据面。
- 目标架构：V3 认知—实践骨架，采用“三个闭环、两个世界、一个编译器”和“骨架完整、血肉渐进”；P0-S 稳定骨架已生产上线，认识论、决策与领域血肉仍按阶段增量建设。
- `2026-08-14` GEO Engine `0.3.2` 新版 Control Room 已上线 `https://geo.kidshub.cn/`，前后端锁定上游 Commit `23fe8bb130e29dea31bf0f98b99bb975dd525d15`。新文章生成由代码默认值和生产 EnvironmentFile 双重锁定为 `deepseek-v4-flash` + `reasoning_effort=max`；真实生产 Key 最小调用已验证模型存在、最高推理生效。当前 7 篇历史文章仍如实记录为 `deepseek-chat`，其中 2 篇草稿、5 篇已审核待发布、0 篇仅导出、0 篇公开发布，因此现在不能宣称发布有效果。Dashboard 已区分草稿、审核、导出、公开 URL 和发布后品牌整体可见性变化；桌面/移动真实浏览器、控制台、数据一致性和 systemd 运行均已通过，详细证据和回滚见 `docs/geo-public-dashboard-deployment-2026-08-14.md`。
- 当前里程碑：`Goal 6-A / P1-DOMAIN` 已完成工程验收和川哥人工体验验收。公司 QNAP 为 Schema `3.3.0`、Registry `in_sync`、Company Brain Operating Model v1 `active`；Domain Connector `2026-08-10.1`、Agent Core `2026-08-10.2`，ERP 95 / Operations 38 / Device 57 / Market 369，数据指纹 `ae0a73d126cb9d2dc1417e0eae7c0e94`。ActionIntent 3、Delivery Outbox 12 均为既有已验证/已回滚/已确认记录，无 pending/leased 写回。H 控制面 `v1.58.2`、50 个运行文件 `in_sync`、真实 Chrome `99/99`。Company Capability Governance v1 继续保持 `contract_only`。PESTIM B～G 工程候选、Linux/amd64 镜像、SQL Runtime、飞书 CSV 人工审核闭环和七日 Shadow 机器验收链已完成工程验证；旧 90 天 Artifact 仅保留为历史 Runtime 证据，Manifest `1.2.0` 的 P003 最终审核、成员真实权限体验和 Goal 7 强门禁发布包尚未重建。`2026-08-11` 已再次在线复核公司 QNAP 五元组、active Schema `3.3.0`、Foundation 13 个容器健康且 `restart_count=0`，战略情报目录和数据库 Schema 仍不存在。飞书来源 8/8 已预填结构化实名审核 Principal，P003 30/36 已预填结构化 DRI 和参与者；线下渠道责任人已进入 To C 线下渠道职能角色和渠道类待审核分配。P003 已拆为产品与用户、AI 研发、品牌、To C 线下渠道四个记录级职能角色，旧宽泛角色成员为 0；`categoryKey` SingleSelect 转换后 36 条逐字段零漂移，正式导入器已兼容单元素数组并失败关闭异常形态。脱敏检查器确认来源分配 8/8 完整，P003 个人 DRI 30/36、必要角色位 90/150、全角色覆盖 12/36；最终决定仍为来源 0/8、P003 0/36，全部关系继续 `pending / inactive`。成员真实权限体验和 Goal 7 文件化 Owner Acceptance 均不存在，因此部署入口继续 fail-closed。
- `2026-08-11` 已确认采用双模式：当前使用 `internal_engineering_shadow` 做 1～3 天、3 个公开来源和 6 条 P003 样例的内部验证；许可/合规、正式 P003 审核、成员 UAT、Goal 7 和七日 `production_shadow` 标记为 `deferred_before_production`。内部证据不能满足生产门禁；当前代码已通过 Contracts `61/61`、Collector `9/9`、Strategic Intelligence `98/98`。本机 Smoke 与公司 QNAP首次真实运行均对 arXiv、Federal Register 和 GitHub 白名单仓库各采集 20 条、共 60 条，Snapshot 只保留 Hash；首次内部运行机器 Evidence 强制验证来源覆盖、单来源 20 条上限、正文 0、Foundation 指纹、临时资源归零和五类业务副作用归零，且固定 `countsTowardProductionShadow=false`。四角色 UAT 最终验收已改为由四份不同成员 Session 和安全负责人接受记录编译，不能手填通过布尔值。内部部署包保留完整项目依赖树，容器使用 QNAP 非 root 部署账号 UID/GID；Goal 7 与最终 Goal 完成证据均由原始运行、权限、部署和 Owner Acceptance 证据自动编译，不能手填布尔值或 Hash。正式 Foundation 部署候选只允许逐个切换 Agent Core、Knowledge Connector、H-Lite，并要求发布、012 迁移、服务重建和真实回滚演练分别授权；包 Hash、内部 Evidence Hash、Release Manifest 或双 Commit 漂移均在任何迁移和服务切换前失败关闭。
- `2026-08-11` 最新增量：Commit `a7aeae25e`、Runtime Workflow `31473316988` 和 Artifact `9094240704` 已形成同源不可变发布证据，内部工程 Runtime 已在公司 QNAP 准备完成。部署仅加载镜像、复制完整项目包、写入 0600 配置并执行 Compose config；Foundation 13 服务指纹不变、restart 0，战略情报容器、网络、端口、迁移和首次采集均为 0。首次真实采集、生产迁移、Foundation 重启和真实回滚仍未授权。
- `2026-08-11` 正式生产地基增量：Commit `80f3fc6dd` 移除部署、迁移、Dispatcher、Domain 持久化、撤权审计和副作用审计对 QNAP 宿主 `node` 的依赖，统一使用固定镜像、无网络的 Node Runtime，并把审批原件唯一限制在战略情报 `approvals/<release-id>/`。Runtime Workflow `31476183330` 与 Artifact `9095350329` 已验证该 Commit；该 Artifact 仍未包含最终人审批准，不具生产部署资格。
- `2026-08-11` 首次运行 Evidence 增量：Commit `c0d9ce92f` 新增 `internal-engineering-run-evidence` Schema、运行态采集、证据编译/验证和失败留证，并修正 Foundation 指纹口径：只统计 13 个长期运行服务，正常完成并退出的 `foundation-init` 不计为故障；战略情报残留容器仍按全量检查。内部更新备份必须包含 package/config/env、可读 tar 和 SHA-256；回滚在移动当前 Runtime 前失败关闭缺失或损坏归档。Strategic Intelligence 回归为 `76/76`。Runtime Workflow `31480010967` 与 Artifact `9096846710` 已绑定完整 Commit `c0d9ce92fb94d09b2c46ae1e019c166da8b32468`，Collector Image ID 为 `sha256:9f7d03ba5eca8e1ca1654e17272099cc0bfdebdd07bc303ed04faec7d8b1776a`；010/011、19/19 强制 RLS、Domain 二次幂等、ACL fail-closed、baseline restore、Artifact 全量 Hash、源码包统计口径和备份/回滚门禁均通过。该阶段 QNAP 仍保持旧 Commit `a7aeae25e`；该 Artifact 后续因实机格式兼容问题被拒绝。
- `2026-08-11` QNAP 真实暂存预演发现 Artifact `9096846710` 的状态采集脚本依赖 Docker Go Template 把 `\t` 解释为真实制表符，但 QNAP 实际返回字面量，导致 13 个健康 Foundation 服务被误报为异常、restart 为 `null`。部署在旧 Runtime 替换前失败关闭，Artifact `9096846710` 已拒绝。Commit `70bd73544` 改用稳定分隔符并补充回归，Strategic Intelligence 保持 `76/76`；Runtime Workflow `31506896848`、Artifact `9107441466`、Collector Image `sha256:500d2201a2ebc0c68af5ce941f7410057233c94fe6886dfd33cdd4a0c76100dc` 全量验证通过，真实 QNAP 暂存采集为 `13/13 running / unhealthy=0 / restart=0`。公司 QNAP 仍保持旧 Runtime `a7aeae25e`，等待针对新 Artifact 的独立更新授权。
- `2026-08-11` 后续对抗审计发现 Artifact `9107441466` 的部署脚本在 package 切换前直接覆盖 config/env，Compose 校验失败可能留下半更新。Commit `0342fcd39` 将 package/config/env 全部 staged，并在统一切换中记录 previous/installed 状态；Compose 失败不改变当前 Runtime，切换到 config 后、env 前失败会自动恢复旧三件套。Strategic Intelligence 仍为 `76/76`；Runtime Workflow `31508346323`、最终 Artifact `9108034290`、Collector Image `sha256:26db1ddd56c21cf7e50586efb5953da158b98437f36d5701c6f21e8dfb8c9ab9` 全量通过，QNAP Shell 与真实暂存验证通过。该审计时 QNAP 仍绑定 `a7aeae25e`，随后才取得最终 Artifact 独立授权。
- `2026-08-11` 内部 Runtime 更新：Artifact `9108034290` 已在独立授权下更新到公司 QNAP，当前内部 Runtime 绑定 Commit `0342fcd39`，0600 环境固化固定 Node/Collector Image。旧 `a7aeae25e` 已生成可读、含 package/config/env 且 SHA-256 通过的备份；更新前后 Foundation `13/13 running / unhealthy=0 / restart=0`、指纹一致，active Schema `3.3.0` 和 Registry `in_sync` 未变。在该更新里程碑，战略情报容器、网络、端口、数据库 Schema、Collector 状态和报告均为 0；随后首次 Collector 取得独立授权并完成。
- `2026-08-11` 首次内部 Collector：首次尝试在 Worker 启动前发现默认 Foundation 网络名写成 `company-ai-foundation_data`，而生产固定网络实际为 `company_ai_data`；该尝试来源请求和 Snapshot 均为 0，Foundation 稳定、资源清零并生成失败 Evidence。修复 0600 环境、Compose 默认值和部署脚本后，真实运行对 arXiv、Federal Register、GitHub 白名单仓库各采集 20 条，共 60 条、重复 0；3 个 Snapshot 全部 Hash-only、正文 0，Candidate Report 未发布，五类业务副作用为 0，Evidence 通过独立验证且固定不计入生产 Shadow。Strategic Intelligence 回归提升为 `77/77`。
- 本目录包含可复用的 QNAP 部署配置；生产密码只在 QNAP 本地生成并保存，不进入 Git。

## 部署边界

- 热数据：`/share/CACHEDEV1_DATA/ai-ontology`。
- WAL、基础备份和快照：`/share/CACHEDEV2_DATA/ai-ontology-backup`。
- 唯一对局域网开放的基础端口：`192.168.61.18:19080`，仅提供健康检查。
- Postgres、Qdrant、Redis、Prometheus 不发布宿主机端口。
- 平台容器总内存硬上限控制在约 3.9GB，为 QTS 和既有容器预留资源。

## 目录

- `deploy/qnap/docker-compose.yml`：QNAP Foundation 栈。
- `deploy/qnap/initdb/`：Ontology 最小真源、RLS、审计、幂等和 Outbox 初始化。
- `deploy/qnap/config/`：Caddy、Prometheus 配置。
- `deploy/qnap/scripts/`：远端初始化、验证、备份与恢复演练脚本。
- `deploy/qnap/images.lock`：生产镜像内容摘要。
- `deploy/qnap/strategic-intelligence/`：P1-SI-F 资源受限 Shadow Compose、调度、部署门禁、备份、Freeze、回滚、七日连续性/版本一致性校验和 Owner Acceptance 证据链。
- `deploy/mini/`：Mini → aliyun-hk 的回环反向 SSH 状态通道。
- `deploy/qnap/ACCEPTANCE.md`：本次生产验收证据和剩余门禁。
- `docs/feishu-knowledge-acl-audit-2026-08-08.md`：产品研究部知识库只读 ACL 审计、两个正式导入 P0 和 Canary 门禁。
- `docs/knowledge-acl-canary-2026-08-08.md`：Knowledge Connector `2026-08-08.3` 生产部署、真实撤权、越权负测、回滚和清理证据。
- `docs/lessons-learned-2026-08-08.md`：公司 Bot、通讯录同步、权限和 QNAP 部署的经验教训。
- `docs/h-engine-credential-cutover.md`：从临时 H 平台 OAuth 切换到公司独立凭据的正式流程。
- `docs/architecture-v3-cognitive-practice-skeleton.md`：认识论、实践论、双层本体、Ontology Compiler 和大骨架优先实施方案。
- `docs/company-brain-work-logic-modeling-plan-2026-08-09.md`：公司大脑工作阶段、状态机、显式对象、Evidence Package v2、可视化和 Goal 4 实施计划。
- `docs/company-brain-work-protocol-acceptance-2026-08-09.md`：Goal 4 生产发布、正负 fixture、回滚恢复、重启回放和 H 控制面验收证据。
- `docs/decision-practice-loop-acceptance-2026-08-09.md`：Goal 5 决策、P2、任务、行动、三层结果、Learning、失败尝试退役和 H 控制面验收证据。
- `docs/goal6-operating-domain-acceptance-2026-08-09.md`：Goal 6 Operating Model、P1-DOMAIN、只读演示链、负向验证和生产验收。
- `docs/goal6-completion-audit-2026-08-09.md`：按 Goal 原始要求逐项核对“已证明/部分证明/待证明”，防止把代码、测试或容器健康误报为完整完成。
- `docs/geo-public-dashboard-deployment-2026-08-14.md`：`geo.kidshub.cn` 独立认证、只读路由、受限反向 SSH、TLS、续期、重启恢复、风险和回滚证据。
- `docs/task6-r-release-provenance-guard-2026-08-10.md`：H 控制面 Source Commit、目标文件哈希、运行时对账和发布回滚门禁。
- `docs/p1-si-f-qnap-shadow-readiness-acceptance-2026-08-10.md`：战略情报 Shadow 部署准备、资源限制、授权门禁、Linux/amd64 镜像与 PostgreSQL Runtime 证据。
- `docs/p1-si-f-deployment-readiness-inspector-acceptance-2026-08-11.md`：统一只读七项部署门禁检查器、32/32 工程验证、当前阻断原因与生产零副作用证据。
- `docs/p1-si-bh-completion-audit-2026-08-11.md`：P1-SI-B～H 逐项完成证据、负向测试覆盖和仍未关闭的人审/部署门禁。
- `docs/p1-si-internal-engineering-shadow-2026-08-11.md`：内部工程验证与正式生产 Shadow 双模式、审核降负担、后补门禁和独立 readiness。
- `docs/p1-si-internal-engineering-deployment-handoff-2026-08-11.md`：内部模式部署影响、预计时长、回滚边界和独立授权交接单。
- `docs/p1-si-reviewer-role-access-uat-2026-08-11.md`：四名职能角色真实登录权限验收步骤、五份原始 Evidence、编译验收和 Manifest 1.2 门禁。
- `docs/p1-si-reviewer-assignment-readiness-2026-08-11.md`：飞书实名审核分配、结构化 Principal 修复、真实 CSV 往返和当前人工门禁。
- `docs/p1-si-g-p003-review-candidate-acceptance-2026-08-10.md`：真实 4644 条矩阵到 P003 36 条审核候选的来源、Hash、负向门禁和 DRI 待办。
- `docs/p1-si-human-review-workflow-acceptance-2026-08-10.md`：来源合规与 P003 DRI 的飞书 CSV 回填、强类型 JSON、final 校验、编译和实名数据边界。
- `docs/p1-si-feishu-review-workbench-acceptance-2026-08-10.md`：P1-SI-B/G 真实飞书人工审核工作台、筛选视图和 CSV 往返验收。
- `docs/p1-si-dri-selection-handoff-2026-08-10.md`：实名 DRI 候选的隐私隔离交接、待拍板角色和 P003 部署门禁补强。
- `docs/goal7-p1-prod-readiness-plan-2026-08-10.md`：Goal 7 部门 / 群聊 Principal、用途与撤权语义，以及 H 引擎冗余、熔断、预算和真实模型读回实施计划。
- `docs/pestim-strategic-intelligence-architecture-2026-08-10.md`：PESTIM 持续情报、多周期经营报告、Horizon/个人站雷达复用边界和公司 QNAP Shadow 方案。
- `docs/p1-si-a-pestim-ontology-definition-acceptance-2026-08-10.md`：PESTIM 候选 Schema `3.4.0`、纯增量兼容性、禁止自动 P2/写回和生产不变验收证据。
- `docs/p1-si-b-source-registry-acceptance-2026-08-10.md`：Source Registry `3.5.0` 候选、首批来源目录、fail-closed 判定和本地工程验收证据。
- `docs/p1-si-c-company-radar-package-acceptance-2026-08-10.md`：公司独立 Collector、JSON Schema、oneshot/last-good、固定镜像配方和无个人运行时依赖验收。
- `docs/p1-si-d-strategic-intelligence-data-foundation-acceptance-2026-08-10.md`：Postgres 唯一真源、Raw/Observation/Signal 双时间、Replay、ACL fail-closed 和候选迁移验收。
- `docs/p1-si-e-multi-period-reporting-acceptance-2026-08-10.md`：多周期窗口、非递归输入、ReportRun 谱系、Alert 和飞书/H 只读投影验收。
- `packages/ontology-contracts/`：Git 管理的 V3 Definition、Compiler、兼容性、Event Envelope、Data/Logic/Action、Operating Model 和 Capability Governance 契约。
- `services/ontology-registry/`：独立 Registry、部署审批、版本激活、历史版本再激活和 Git/运行时对账服务。
- `services/agent-core/`：Company Agent Core 内部 API、Postgres 幂等审计和 H 引擎独立 Runtime 门禁。
- `services/knowledge-connector/`：飞书知识发现、ACL 映射、正文分块和同步审计。
- `services/domain-connector/`：ERP M3 与社媒归一化结果的只读同步、双时间、幂等、重放、Dead Letter 和脱敏状态服务。

## 上线门禁

- 不迁移、不切换任何员工私人 Bot 的飞书 App 或事件订阅。
- 公司级飞书 App/Bot 已接入，H-Lite 当前为 `active` 且真实飞书长连接健康；已验收 `p2p:post`、`p2p:text`、`group:text` 三类真实消息，3 次处理全部完成、0 次失败，SQLite 去重记录为 3 条，容器 `restart_count=0`。
- 飞书通讯录数据范围已生效：4 个授权范围、83 个可见部门、414 名可见人员已只读同步到 Ontology Principal；重复同步结果为新增 0、更新 414，未写入邮箱、手机号或聊天内容。
- Agent Core `2026-08-10.2` 仍是当前生产版本，通过 HMAC 调用 dev198 H Worker，真实推理 `productionReady=true`；Work / Practice Protocol `1.1.0` 已处于 `active`。Goal 7 的 Agent Core `2026-08-11.1` 本地候选新增发送者/会话/用途授权、Route A 熔断、预算和真实 usage 读回，但尚未提交、部署或迁移。Worker 仍经个人 CPA API Key 调用 `grok-4.5`，公司专用 CPA 与 Route B 仍缺失。
- Knowledge Connector `2026-08-08.3` 已部署到公司 QNAP；Connector 与 Agent Core 回归均为 14/14，生产只读 Canary 已覆盖直接授权、空间继承、无空间继承、ACL 失败、正文可读但 ACL 失败、员工真实撤权、跨部门和链接直猜负测。撤权后 37.757 秒内 Evidence 归零，临时文档删除后 ACL/Chunk 均归零，回滚 `2026-08-08.2 → 2026-08-08.3` 演练通过。产品研究部整库导入仍未批准，`department/openchat` P1 映射完成前继续禁止批量索引。
- Ontology Registry 当前 Schema `3.3.0`、状态 `in_sync`，生产 active 版本唯一且 Git/运行时一致；Definition Source Commit 与 Runtime Release Commit 继续分开记录。
- Goal 4 已完成 ERP/社媒 fixture 的正证、反证、过期、无 ACL 和不存在 Principal 五类生产验证；无证据路径在策略层失败关闭，不调用 H 引擎，不泄露标题、URL、人员或正文。
- Goal 5 已跑通一名真实 DRI、一个受控 P2、一个 Task、一个 Action、一个 Verification 和一个 Learning Proposal；技术执行、业务结果、经营目标三层结果均为 `true`。失败演练保留审计并退役，不算正式 P2。
- H 控制面 `v1.56.2` 已上线 WorkCase、Evidence Map、Answer Basis、Decision Lineage、Goal 6 领域白盒、实时运行真值和能力治理灰色节点；真实浏览器 `92/92` 检查通过，34 条连线光晕全部位于彩线下层，控制台错误、失败请求、节点重叠、错接、穿卡连线和横向溢出均为 0。川哥已于 `2026-08-10` 明确确认验收通过。
- 本阶段不开放数据库端口到员工网段。
- 10 人真实员工 Canary 和 24 小时容量数据未完成前，不进入 50 人正式首批。

## 下一阶段

1. `Task 6-R / Release Provenance Guard` 已完成；未来所有 H 发布继续执行 Source Commit、完整运行时 Manifest、文件哈希和真实浏览器门禁。
2. Goal 7 `P1-PROD-READINESS`：P1-AUTHORITY/P1-RUNTIME 本地工程候选已完成，Agent Core `63/63`、Knowledge Connector `18/18`；012 候选迁移与 Linux CI 已接线，并新增真实 `ontology_app` 读写验证、完整 usage 读回、模型已消耗后预算拒绝仍落账，以及 Ontology/H-Lite 双仓 Commit 与源码归档绑定。Goal 7 验收已升级为五份原始 Evidence 绑定的 `2.0.0` 编译包，防止手填通过。下一门禁为双仓提交推送后的 PostgreSQL Runtime Evidence、真实 H Worker provider/model/usage 读回、飞书合成 Canary、QNAP 部署和 Owner Acceptance；公司专用 CPA 与 Route B 继续后补，本 Goal 不执行整库导入。
3. PESTIM `internal_engineering_shadow` Runtime 已更新到 Commit `0342fcd39` / Artifact `9108034290`，并完成 1 次真实内部 Collector：3 来源、60 条、Hash-only、正文 0、重复 0、业务副作用 0，Foundation 13/13 且 restart 0。该 Evidence 不计入正式 Shadow；下一步为 8 来源最终决定、36 条 P003 审核、四角色 UAT 和 Goal 7。第 2～3 天内部排错仍需新的运行授权。
4. Goal 3 的 10 名真实员工 Canary 在 Goal 7 后执行，仍是 20/50 人放量前的强制门禁。
5. Goal 8 建立 24 小时容量观测、H-Lite lease/fencing 和 Worker 分池，再规划 20/50 人扩容。
6. 产品研究部整库导入、Capability Governance 激活、A2A、真 3D、PESTIM 自动 P2、ERP/社媒写回、ERP M4 和 MediaCrawler 风控恢复继续拆为独立 Goal，必须重新授权。
7. GEO 公网下一步只做运行硬化：将 GEO 主进程迁入 systemd、监听收紧到 `127.0.0.1`、补真实浏览器验收；不得因此开放原始写 API或跳过 Public Claim / Action Gateway。
