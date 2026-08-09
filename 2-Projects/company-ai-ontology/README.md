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
- 当前里程碑：公司 QNAP 已进入 `Goal 6 / P1-DOMAIN`，Schema `3.3.0`、Registry `in_sync`、Company Brain Operating Model v1 为 `active`；ERP M3 和社媒归一化结果已通过只读 Connector、稳定 View、幂等、重放、错误隔离和权限负测。H 控制面仍保持 `v1.53.0`，`v1.54.0` 白盒代码和发布门禁已准备完成，但尚未获得重新启动生产的明确授权，因此真实浏览器验收仍为灰色。
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
- `docs/goal6-operating-domain-acceptance-2026-08-09.md`：Goal 6 Operating Model、P1-DOMAIN、只读演示链、负向验证、H 控制面待授权门禁和当前完成审计。
- `packages/ontology-contracts/`：Git 管理的 V3 Definition、Compiler、兼容性、Event Envelope 和 Data/Logic/Action 契约。
- `services/ontology-registry/`：独立 Registry、部署审批、版本激活、历史版本再激活和 Git/运行时对账服务。
- `services/agent-core/`：Company Agent Core 内部 API、Postgres 幂等审计和 H 引擎独立 Runtime 门禁。
- `services/knowledge-connector/`：飞书知识发现、ACL 映射、正文分块和同步审计。
- `services/domain-connector/`：ERP M3 与社媒归一化结果的只读同步、双时间、幂等、重放、Dead Letter 和脱敏状态服务。

## 上线门禁

- 不迁移、不切换任何员工私人 Bot 的飞书 App 或事件订阅。
- 公司级飞书 App/Bot 已接入，H-Lite 当前为 `active` 且真实飞书长连接健康；已验收 `p2p:post`、`p2p:text`、`group:text` 三类真实消息，3 次处理全部完成、0 次失败，SQLite 去重记录为 3 条，容器 `restart_count=0`。
- 飞书通讯录数据范围已生效：4 个授权范围、83 个可见部门、414 名可见人员已只读同步到 Ontology Principal；重复同步结果为新增 0、更新 414，未写入邮箱、手机号或聊天内容。
- Agent Core `2026-08-09.2` 当前通过 HMAC 调用 dev198 H Worker，真实推理 `productionReady=true`；Work / Practice Protocol `1.1.0` 已处于 `active`，Intake 至 Learning 全阶段可回放。Worker 经个人 CPA API Key 调用 `grok-4.5`，后续仍需切换公司专用 CPA Key/账号与同厂冗余。
- Knowledge Connector `2026-08-08.3` 已部署到公司 QNAP；Connector 与 Agent Core 回归均为 14/14，生产只读 Canary 已覆盖直接授权、空间继承、无空间继承、ACL 失败、正文可读但 ACL 失败、员工真实撤权、跨部门和链接直猜负测。撤权后 37.757 秒内 Evidence 归零，临时文档删除后 ACL/Chunk 均归零，回滚 `2026-08-08.2 → 2026-08-08.3` 演练通过。产品研究部整库导入仍未批准，`department/openchat` P1 映射完成前继续禁止批量索引。
- Ontology Registry `2026-08-08.1` 已上线：Schema `3.2.0`、111 个 active 受治理元素、内容哈希 `ffa8943255b9`，生产 active 版本唯一且 Git/运行时一致。
- Goal 4 已完成 ERP/社媒 fixture 的正证、反证、过期、无 ACL 和不存在 Principal 五类生产验证；无证据路径在策略层失败关闭，不调用 H 引擎，不泄露标题、URL、人员或正文。
- Goal 5 已跑通一名真实 DRI、一个受控 P2、一个 Task、一个 Action、一个 Verification 和一个 Learning Proposal；技术执行、业务结果、经营目标三层结果均为 `true`。失败演练保留审计并退役，不算正式 P2。
- H 控制面 `v1.53.0` 已上线 WorkCase、Evidence Map、Answer Basis、Decision Lineage 和三层结果；真实浏览器显示 9/9 运行组件就绪、控制台错误 0、无横向溢出。
- 本阶段不开放数据库端口到员工网段。
- 10 人真实员工 Canary 和 24 小时容量数据未完成前，不进入 50 人正式首批。

## 下一阶段

1. 获得当前明确生产重启授权后，将 H 控制面从 `v1.53.0` 发布到 `v1.54.0`，同时切换管理员密码，并完成真实 Mac 浏览器二维/2.5D 交互验收。
2. 在独立变更窗口完成 Domain Connector 旧版回滚与新版恢复演练；未获明确授权前不重启 QNAP 生产容器。
3. Goal 3 的 10 名真实员工 Canary 继续延后，但仍是 20/50 人放量前的强制门禁。
4. 为 H 引擎建立公司专用 CPA Key/账号与同厂冗余，替换当前个人 CPA 依赖。
5. 补齐空间成员 `department/openchat` 映射和 Retrieval 对群组主体的授权语义；完成后再单独审批产品研究部整库导入窗口。
