---
name: company-ai-ontology
description: 公司 AI Ontology 基座与 GEO Engine 架构实施入口。用于经营目标/P2 任务拆解、全员飞书 Bot、H 平台复用、爱视可 ERP 接管、社交媒体监控接管、QNAP NAS 部署、geo.kidshub.cn、GEO 前后端、Nginx API 白名单、权限化检索、Action Gateway、人审与审计闭环。触发词："AI Ontology"、"公司 AI 基座"、"经营任务中枢"、"全员 Bot"、"H 平台打通"、"爱视可 ERP 接管"、"社媒监控接管"、"GEO Engine"、"geo.kidshub.cn"、"GEO 白名单"。
metadata:
  layer: 项目层
  authorization: B区（设计与文档可自主；生产部署、ERP/飞书写回、社媒采集恢复需用户明确授权）
  output_levels: L2
---

# 公司 AI Ontology 基座 Skill

## 适用场景

- 设计或迭代公司级 AI 基座、Ontology、经营任务中枢。
- 把公司经营目标、OKR、P2 重点任务拆成个人任务并通过全员飞书 Bot 下发。
- 将 H 平台作为 Bot / Runner / Delivery Layer 复用到公司 AI 基座。
- 接管爱视可 ERP 作为内部履约事实真源。
- 接管社交媒体监控系统作为外部市场信号真源。
- 规划 QNAP NAS 局域网部署、权限化检索、Action Gateway、审计和管理驾驶舱。
- 部署和维护 GEO Engine、`geo.kidshub.cn`、受限反向 SSH、Nginx 精确 API 白名单及前后端生产验收。

## 核心结论

公司 AI 基座不是“一个问答 Agent”，而是 Ontology 驱动的经营操作系统：

```text
市场为什么要做 -> 公司决定做什么 -> 员工具体做什么 -> ERP 证明做到哪里 -> 市场再验证效果如何
```

V3 目标架构在 V2.2 生产基线上新增“三个闭环、两个世界、一个编译器”：

- 认识闭环：Observation → Evidence → Claim → Hypothesis → Decision。
- 实践闭环：Decision → Action → Outcome → Verification。
- 演化闭环：Learning → Ontology Change Proposal → Review → Deploy → Reconciliation。
- 运营世界与产品/物理世界使用双层本体连接，不把 ERP 设备记录当成完整物理状态。
- Ontology Compiler & Registry 统一类型、引用、行为、约束、版本和 Git/运行时对账。
- 建设原则是“骨架完整、血肉渐进”：先固定元模型、命名空间、事件和安全契约，不一次性穷举全部业务对象。

架构分工：

- QNAP H-Lite：从现有 H 平台同源移植的精简生产 profile，承载飞书 WebSocket 订阅、Bot Bridge、授权、Outbox、ACK/读回、提醒和 Runner Adapter。
- Company Agent Core：与 H-Lite 同机部署在 QNAP，通过 H 引擎承载 Agent 身份、路由、上下文编译、任务提案、会话编排和主 Runtime Pool，是 Ontology 的核心 AI。
- H 平台上游：继续服务现有员工私人 Bot，并提供统一代码、契约、管理能力和 Mini/Studio 扩展 Worker；私人 Bot 不迁移、不切换飞书事件订阅连接。
- AI Ontology：目标、P2、任务、决策、产品、ERP、市场信号、成果、证据和权限语义。
- H 引擎：Company Agent Core 的统一 AI 执行抽象；主实例和首批 Runtime Pool 部署在 QNAP，底层模型实现和版本作为可替换部署细节，不进入业务架构描述。
- Postgres：Ontology 对象、关系、任务、权限、审计与证据的唯一结构化真源。
- Qdrant：可重建的向量召回派生层，不承担事实真源或权限判断。
- Cognee：移出 P0 在线关键路径；后续只能作为离线实验候选，不能承担权限体系。
- Action Gateway：所有业务写回的强制安全边界。
- QNAP：P0 起即作为公司局域网内的主硬件底座，承载公司级 Bot 的 H-Lite、Company Agent Core、主 H 引擎 Runtime Pool、Ontology 控制面与数据面。

## 五层 Ontology

| 域 | 对象 | 用途 |
|---|---|---|
| Company Ontology | 目标、P2、任务、决策、人、部门、交付、卡点 | 公司级任务操作系统 |
| Product Ontology | 产品线、SKU、BOM、版本、功能、卖点、成本 | 产品决策与 ERP 对齐 |
| Operations Ontology | SN、质检、库存、订单、渠道、物流、激活、设备追溯 | 接管爱视可 ERP |
| Market Ontology | 内容、评论、达人、品牌、关键词、痛点、趋势、竞品 | 接管社交媒体监控 |
| Customer / Scenario Ontology | 用户画像、使用场景、护眼/儿童需求、反馈、转化线索 | 连接市场与产品 |

## H 平台复用边界

可以复用：

- 飞书 WebSocket 订阅、Bot Bridge。
- 精确 scope 授权卡片、device-flow、自动续跑。
- H 引擎调用链作为 Mini/Studio 扩展 Worker Cell，不承担 Company Agent 主实例。
- `short/full` taskMode。
- 多用户 profile、隔离 HOME / lark-cli HOME。
- Delivery Outbox、Feishu ACK、完成卡片。
- Task Session Log、并发调度、任务恢复。

QNAP H-Lite 移植原则：

- 使用同一 H 平台代码库和 `behaviorContractVersion`，新增 `company-qnap-lite` 部署 profile；禁止复制后形成长期 fork。
- 只启用飞书订阅、Bridge、授权、Company Front-door profile、Delivery Outbox、ACK/读回、Task Session Log、提醒、恢复和 Agent Core Adapter。
- 不启用通用多租户控制台、公司业务状态存储、全量工具凭据和直接业务写回。
- 新建一个独立的公司级飞书 App/Bot，由 QNAP H-Lite 接收其事件；现有 H 平台员工私人 Bot 的 App、事件订阅、记忆和会话全部保持不变。
- 公司级 Bot 是一个面向全员并发服务的唯一逻辑入口；为避免同一条飞书事件被重复处理，同一时刻只允许一个 H-Lite 主订阅实例接收事件，其余实例通过 lease/fencing 保持待命。该机制不切换员工私人 Bot，也不限制公司 Agent 同时服务多人。

不能裸复用：

- Runner 不能直接查全量 Ontology、ERP、社媒或飞书文档。
- Runner 不能直接写 ERP、飞书、Git、报表。
- 从 P0 起，Ontology/Postgres 就是业务任务唯一真源；SQLite/JSONL 只保存 H 平台 append-only 运行事件。
- 全员 Agent 不能成为超级管理员 Agent。

必须新增：

- `Company Agent Core`：部署在 QNAP，是全员 Agent 的唯一逻辑主实例，统一调用 H 引擎、Ontology、Policy 和 Action Gateway。
- `H-Lite Agent Core Adapter`：通过 QNAP loopback/内部网络把飞书请求交给 Company Agent Core，并把结果交回 Outbox。
- `Ontology Service`：公司经营语义对象与关系。
- `Permissioned Retrieval Gateway`：先算权限，再检索，再组证据包。
- `Task Proposal Compiler`：只生成任务图、个人任务草案和验收标准，等待 DRI 修改批准。
- `Mandatory Action Gateway`：Action Intent、dry-run、人审、执行、读回校验、审计、回滚。

## 飞书身份与通讯录同步

- 飞书的 API Scope、通讯录数据范围、应用可用范围是三个独立门禁，必须分别用真实 API 和真实用户验证；不能用后台已勾选或单一错误码推断全部生效。
- 通讯录 Connector 必须从授权入口递归展开子部门，再拉取人员；授权入口数量不等于最终可见部门数量。
- 同步入口只接受专用服务身份与 HMAC 签名，普通员工身份必须返回 403；员工 Bot 不得借此获得公司通讯录批量导出能力。
- Ontology Principal 只保存任务派发需要的最小字段：姓名、飞书身份、部门和启用状态；默认不保存邮箱、手机号、私聊正文或私人属性。
- Principal Upsert 必须幂等；重复同步不得重复创建人员。暂时只更新本轮可见人员，不因“本轮未出现”自动禁用历史人员，避免通讯录范围临时收缩造成误停用。
- 每次生产同步至少验收：授权入口数、递归部门数、人员数、新增/更新数、敏感字段命中数、普通员工 403 负测和重复同步幂等。

QNAP 运行命令：

```bash
node ops/sync-company-directory.mjs
```

命令只从 QNAP 本地 secret 指针读取凭据；输出和日志不得打印 App Secret、访问令牌、完整身份 ID 或私人字段。

## 飞书知识 Connector 与 ACL 红线

- “公司 App 能读取文档”不等于“当前员工有权读取文档”。公司 App 只负责建立索引，不向员工继承 App 的全局可见性。
- Connector 入库前必须保存文档、知识空间、文件夹、用户、部门、群组和密级的 ACL 映射；无法确定 ACL 的内容默认拒绝进入员工上下文。
- 检索顺序固定为：解析当前 Principal → 计算授权集合 → 在授权集合内召回 → 生成带来源和权限快照的 `Permissioned Evidence Package` → 交给 Company Agent Core。
- 向量库只保存可重建派生索引；权限判断必须回到 Postgres/Ontology 的当前 ACL，不允许仅依赖向量过滤标签。
- ACL 变更后必须支持索引失效或重建；离职、转岗、部门调整和文档移权必须在规定 SLA 内收敛。
- 跨部门、已撤权、无 ACL、链接直猜和提示词诱导越权必须作为 Canary 负测，不得只测正常检索。
- 正式整库导入前必须先做只读 ACL 分布审计；服务健康、单资源安全跳过和合成越权负测都不能替代整库继承语义验收。
- 文档 ACL 读取失败是最高优先级拒绝条件：即使已有空间 ACL、空间公开或正文接口可读，也必须在读取正文前终止并保存 `acl_status=unknown/status=skipped`。
- 只有文档直接 ACL 明确包含对应 `wikispaceid` 才能展开知识空间成员；文档位于空间、存在父节点或空间成员可枚举都不是权限继承证据。
- `department/openchat/group` 等主体必须从飞书原始字段到 ACL 入库再到 Retrieval 查询端到端保真；群聊授权需要当前会话证据和撤权语义，不能转换为个人永久权限。
- 产品研究部知识库正式导入仍处于阻断，但两个 ACL P0 已在公司 QNAP 生产闭环：Knowledge Connector `2026-08-08.3`、Connector/Agent Core 28/28、真实小范围 Canary、撤权、跨部门和链接直猜负测均通过。下一门禁是 `department/openchat` 原始主体映射与受控 `chat/group` 会话证据、用途和撤权语义，完成后仍需单独批准导入范围与窗口。

## 爱视可 ERP 接管边界

- ERPNext/Frappe 继续作为事务系统和履约事实真源。
- Ontology 做上层语义映射、跨系统推理、任务派发和证据链。
- P0 只接 M3 已验收范围：SKU、SN、质检、仓库、渠道订单、物流、激活、设备追溯。
- 涉及 ERP 主数据、订单、设备状态的写回必须走 Action Gateway 和人审。
- M4 RMA/退换/解绑只预留对象，不自动规划、开发或部署；必须等待用户显式命令。

## 社媒监控接管边界

- TikHub、JustOneAPI、MediaCrawler 继续作为 Provider。
- Ontology 只接归一化后的业务结果；HTTP 200 不是业务成功。
- 每条信号必须保留来源、平台、外部 ID、采集时间、归一化规则和去重关系。
- 社媒正文必须先进入不可信输入隔离区，只允许规则抽取后的结构化 Signal 进入推理链，不能直接触发工具。
- 信号不是结论，必须经过 Opportunity / Decision Agent 形成建议。
- MediaCrawler 若触发小红书 re-login/risk-control，不自动恢复、不绕过登录、不加并发，等待用户明确指令。

## P0 最小闭环

1. 选择一条真实公司 P2 和唯一 DRI。
2. `Task Proposal Compiler` 只生成个人任务草案和验收标准。
3. DRI 修改并批准任务草案；未经批准不得进入 `assigned`。
4. H 平台将已批准任务投递到员工飞书 Bot，并取得 Feishu ACK。
5. Bot 解释任务、提醒、协助执行并收集成果。
6. QA Agent 只做规则预检，不替代业务验收。
7. DRI 验收或退回成果。
8. Ontology/Postgres 作为任务状态唯一真源，H 平台只保留 append-only 投递与运行事件。
9. ERP 和社媒在 P0 只作为只读证据源，不触发 P2、不写回业务数据。

## 公司 QNAP 资产身份门禁

这是 P0 安全门禁，不是命名偏好：

- 本 Skill 中的 `QNAP`、`prnas`、`company-qnap-lite` 均只指公司局域网生产 NAS：`prnas` / `prnas-pub`、`TS-X65`、当前地址 `192.168.61.18`。
- 家庭 QNAP 是另一资产、另一安全域、另一数据域，不属于公司 AI Ontology 项目。禁止跨资产复用部署目录、Compose、端口、卷、凭据、备份、恢复步骤和验收结论。
- 每次 SSH、同步、部署、重启、备份或恢复前，必须核对五元组：`用途=公司`、主机别名、型号、当前地址、项目根目录 `/share/CACHEDEV1_DATA/ai-ontology/foundation`。
- 若用户只说“QNAP”且上下文不能唯一证明是公司 QNAP，先查 `0-System/memory-items.md` 和当前 SSH 配置；仍不唯一则停止并询问，不得凭历史 IP、设备型号或目录猜测。
- `TS-X65` 公司生产机不得套用历史 `TS-431P` 改机资料，也不得套用家庭 NAS 的 fnOS、Docker、存储或网络操作流程。
- 设备地址、QTS 版本、容量和运行服务是快照；写配置或执行生产操作前必须在线复核，文档只能作为基线。

## QNAP 主底座边界

- QNAP 从 P0 开始进入在线关键路径，承载公司级 Bot H-Lite、Company Agent Core、主 H 引擎 Runtime Pool、API Gateway、Identity/Policy、Ontology Service、Postgres、Qdrant、Redis、Action Gateway、Audit/Observability 和备份编排。
- H-Lite 与 Company Agent Core 通过 loopback/内部 Docker 网络连接；飞书入站不再绕行外部 H Bridge，QNAP 断网恢复后由本地 Outbox 和订阅重连继续处理。
- 面向全员的 Agent 身份、系统提示词、版本、路由、Context Compiler、Task Proposal Compiler 和会话编排只在 QNAP Company Agent Core 中维护。
- 50 人首发的短任务池与长任务池优先运行在 QNAP；当扩至 150/300 人时，再通过 H 平台把无状态 H 引擎 Worker Cell 扩展到 Mini/Studio。
- 扩展 Worker 只接收签名任务包和短期 Gateway Token，不保存公司长期记忆、不持有业务系统长期凭据，也不能成为任务真源。
- QNAP 上不运行本地大模型；推理由 H 引擎上游服务提供，NAS 只承担公司数据、控制与调度。
- P0 接受 QNAP 为单主节点，但必须同时具备：容器资源硬限制、健康探针、自动重启、Postgres PITR、WAL/快照写入 RAID1、离机加密备份、恢复演练和明确 RTO/RPO。
- QNAP 故障时禁止把缓存、H 平台 SQLite 或人工消息提升为任务真源；恢复后只能从 Postgres 备份与 append-only 事件重放恢复。
- 当前 16GB 设备首批平台容器总内存硬上限建议不超过 6GB，并至少为 QTS 和既有生产容器保留 6GB；未完成 24 小时峰值压测前不得提高上限。

## 50 到 300 人扩容

- 10 人 canary → 20 人 → 50 人正式首批，均通过 feature flag 放量。
- 50 人：QNAP 运行 H-Lite、Company Agent Core、主短任务池和主长任务池；Mini/Studio 可保留一个故障隔离 Worker Pool。
- 150 人：增加独立 Worker Cell，按任务类型分池并建立部门配额。
- 300 人：按 public/product/erp/management 安全域分 Cell；QNAP 保持单一控制/数据主底座，执行面横向扩展。
- 每阶段必须通过 Admission Control、H 引擎限流、队列等待上限、Worker 崩溃恢复、跨员工/跨部门越权负测和 Feishu ACK 重投验收。

## 员工数据章程

- 只跟踪公司任务对象、成果、证据、状态和卡点，不采集在线时长、键盘行为、私人情绪或与任务无关的私聊正文。
- 员工可查看系统保存了自己的哪些数据；管理层默认不能读取个人 Bot 私聊全文。
- 员工提交成果时必须明确提示哪些内容会进入公司 Ontology 和管理视图。

## 验收红线

- 必须证明真实业务结果，不只证明 HTTP 200、消息发送或 Runner exit 0。
- 无 Feishu ACK 不算送达。
- 无读回校验不算动作完成。
- 无权限过滤证据包不许回答公司内部信息。
- 无 Action Gateway 不许写回业务系统。
- 管理层看任务状态、成果和卡点，不默认看员工私人对话全文。
- 无 DRI 批准不许自动派发个人任务。
- 无单一任务真源不许同时上线 H/Ontology 双写。
- 无 QNAP 备份恢复演练不许扩大到 50 人正式首批。

## QNAP 滚动部署与复验

1. 部署前保存当前 compose、环境指针、镜像摘要和数据库备份，禁止把 secret 打进传输包或 Git。
2. 先升级 Company Agent Core；健康探针、版本、数据库连接和定向测试通过后，再升级 H-Lite。
3. H-Lite 升级后必须重新验证飞书 WebSocket 在线、私聊/群聊入站、Outbox 回复、去重、版本和 `restart_count=0`。
4. 通讯录相关改动必须重跑同步正例、重复同步幂等、普通员工 403 和敏感字段扫描。
5. 新版本的验收证据必须发生在新容器启动时间之后；旧版本曾经通过不能替代当前版本复验。
6. 回滚时先恢复兼容版本的 H-Lite，再恢复 Agent Core；业务真源只从 Postgres 备份和 append-only 事件恢复。

## P0-S Foundation Pack 经验（2026-08-08）

- “骨架完整”应固定命名空间、元模型、双时间、Provenance、Event Envelope、工具契约、兼容性和安全路径；不等于提前穷举全部企业对象和字段。
- Definition、Compiler、Registry 必须分层：Git Definition 是设计真源，Compiler 做静态校验和稳定哈希，Registry 管 Proposal、批准、激活、历史再激活和 Git/运行时对账。
- Postgres 继续作为唯一事实与权限真源。V3 使用逻辑 Schema、View、版本列和 Provenance 扩展现有事实表，不为“新架构”复制一套平行业务真源。
- 破坏性变更必须被 Compiler 标记并携带 migration plan；运行时部署必须有 Proposal、批准者、来源提交和 Domain Event，禁止 Agent 自行改 Schema 后直接生效。
- 验收必须覆盖重复迁移、重复部署、并发部署收敛、重启恢复、历史版本再激活、漂移检测和最小数据库权限；单次部署成功不能证明 Registry 可治理。
- 公网控制面只展示认证后的脱敏派生状态，不能把 QNAP 健康响应原样透传，也不能因可视化需求改变 QNAP 的局域网边界。
- 本地测试、生产容器健康、真实业务闭环和用户验收是四层不同证据；不得用其中一层替代其他层。

## P0-PROD-2/3 生产经验（2026-08-08）

### 公司 H 引擎凭据

- 当前生产模式为 `credentialMode=cpa-api-key`：独立公司 H Worker 使用 Grok Build 自定义模型，通过 CPA OpenAI 兼容入口调用实时确认的 Grok 模型。
- 使用独立 `H_ENGINE_WORKER_HOME`、`GROK_HOME` 和 Workspace；CPA Key 仅落在 dev198 的 0600 环境文件，QNAP 不持有模型凭据。
- 自定义模型必须使用独立本地别名，例如 `cpa-grok-4-5`，再映射上游 `grok-4.5`；与内置模型同名会误走 xAI 官方鉴权。
- 模型版本必须先读 CPA `GET /v1/models`，再与 xAI/Grok Build 官方文档交叉验证，不沿用旧快照。
- Worker 必须保留 HMAC、墙钟偏差、请求/输出大小、并发和超时门禁；Prompt 使用 0600 临时文件，进程参数不得包含公司正文。

### 飞书知识 Connector

- App Scope、App 对文档的分享权限、当前员工的读取权限是三道独立门。`1063004` 等分享权限错误必须 fail-closed，ACL 未知时禁止读取正文。
- 显式资源 JSON 不直接经过 Compose YAML 字符串插值；使用 Base64 或只读配置文件，启动时严格解码并校验数组结构。
- Knowledge Connector 只负责发现、ACL 快照、正文分块和同步审计；最终回答仍由 Agent Core 按当前 Principal/部门 ACL 查询 Evidence Package。
- ACL 正确不等于召回正确。中文自然问句不能只依赖整句 `ILIKE` 或 Postgres `simple` 分词，应使用有上限的关键词/短语召回，并限制数量防止过宽匹配。
- 生产验收必须同时包含：有权 Principal Evidence 命中且 H 回复命中、无权 Principal Evidence 为零且标题/摘要/正文不泄露、临时合成数据清理、撤权后重新同步并复测。
- 同步状态只输出资源数、索引数、跳过原因和 chunk 数，不输出文档 Token、人员 ID 或正文。
- 2026-08-08 整库只读审计新增强制门禁：ACL 读取错误必须无条件跳过；空间权限只在文档 ACL 明确含 `wikispaceid` 时继承。原 8/8 测试只代表旧覆盖范围，不得描述为整库 ACL 安全通过。
- `2026-08-08.3` 已部署公司 QNAP：移除 `inheritedAcl` 无条件注入，并在文档 ACL 或空间 ACL 错误时于正文读取前写入 skipped；同步审计只保存白名单错误码。Connector 14/14、Agent Core 14/14。
- 生产 Canary 已覆盖直接授权、空间继承、无继承、ACL 失败、正文可读但 ACL 失败、真实员工撤权、跨部门和链接直猜；撤权后 Evidence 在 37.757 秒内归零，临时数据已清理。
- 发布必须使用版本化源码目录、旧镜像回滚标签、Knowledge Schema 快照和校验清单；只保留 `latest` 镜像不算可恢复部署。
- 后续 P1：补齐 `spaceAclEntry()` 对 `department/openchat` 原始类型映射，并扩展 Retrieval 对受控 `chat/group` Principal 的支持；未定义会话证据前不得启用群组授权。

### 公网管理看板

- 应提供公网可访问的可视化页面，但“公网可达”必须等于“认证后可见”，不等于直接暴露 QNAP。优先复用现有 H 控制面的 HTTPS、管理员 Cookie、发布和运维体系。
- 推荐链路固定为：浏览器 → `ai.kidshub.cn/admin/company-ontology` → H 管理员认证 → aliyun-hk 回环端口 → Mini 持久反向 SSH → QNAP LAN 健康网关。阿里云只监听 `127.0.0.1`，QNAP 不开公网端口。
- QNAP 网关只允许固定的 Foundation、H-Lite、Agent Core、Knowledge Connector、Action Gateway 健康路径；Postgres、Qdrant、Redis、Prometheus 和业务 API 不进入隧道。
- H 控制面必须服务端白名单重建状态 DTO，禁止把上游响应原样透传；状态 URL 只接受 loopback host，设置超时、响应体上限、禁止重定向并移除 Key、Token、路径、人员 ID、文档 URL、错误正文等字段。
- 绿色表示“已通过当前生产验收”，灰色表示“仍有业务门禁”。服务容器健康可以标绿，但知识权限正负验收、真实 Canary、真实 P2、ERP/社媒接管在业务闭环前必须保持灰色。
- 公网验收至少包含：未认证跳转登录、认证后页面 200、状态 API 200、H 引擎模型与版本真值、敏感字段扫描、真实浏览器无控制台错误、无横向溢出、绿色/灰色数量和隧道重启后恢复。

### GEO 公网受控操作台（2026-08-14）

- GEO Engine 独立运行观察面为 `https://geo.kidshub.cn/`，当前链路固定为：浏览器 → aliyun-hk Nginx 独立认证 → `127.0.0.1:13808` → `geo-tunnel` 受限反向 SSH → company-vm `127.0.0.1:8080/dashboard`。
- GEO Dashboard 不是事实真源或 Ontology/ERP Action Gateway。它展示认证后的运行派生状态，并提供受控 GEO 内容与检测操作；接口可达不等于内容已经获得业务发布授权。
- GEO 原始服务把 Dashboard、读 API 与高风险写接口放在同一端口。当前策略为公开 GET `/health` 和受控 `/published/<file>` 内容层，Dashboard/API 统一经过 Basic Auth 后由 `location /` fallback 代理到回环上游；后端新增顶层接口会自动对已认证用户可达。已知 POST 继续保留 exact location 实施方法、请求体和超时；其中六个工作流接口 `/articles/update`、`/publish`、`/gen`、`/kb/create`、`/kb/add`、`/visibility/multi` 使用 `geo_dashboard 120r/m burst=30`，慢操作 `/visibility`、`/audit`、`/fix` 使用 `geo_operations 6r/m burst=2`。
- 动态路径 `/(articles|kb)/<numeric-id>` 使用锚定数字 regex；随后使用 `^/(articles|kb)/` guard 拒绝非数字和多余路径段。exact location 优先于 regex，因此 `/articles/update`、`/kb/create`、`/kb/add` 不受 guard 影响。
- 隧道必须同时满足独立用户/独立密钥、`restrict + port-forwarding + permitlisten="127.0.0.1:13808"`、阿里云仅回环监听、安全组不开放端口和公网探针不可达。任何单一证据不能替代其余四项。
- 独立访问凭据不得复用 H 管理员、Ontology 密码、模型 Key 或隧道私钥；远端只存 Hash，秘密不得进入 Git、Skill、记忆、日志或协作消息。
- 上线验收至少包含：DNS、独立 TLS SAN、未认证 fallback `401`、认证新增接口 `200/400`、exact 错误方法 `405`、认证未知路径后端 JSON `404`、动态命名空间畸形路径 Nginx `404`、前端动态数据与 API 一致、七个 Tab 可达、真实浏览器桌面/移动布局、控制台、Nginx error log、GEO 与隧道服务状态和 Certbot renew dry-run。
- GEO 主进程使用系统级 `/etc/systemd/system/geo-engine.service`，固定监听 `127.0.0.1:8080`；代码必须来自固定 Git Commit 的不可变 Release，依赖使用独立 venv，模型 Key 只从 `0600` EnvironmentFile 注入，旧 user service 保持 disabled/inactive。
- `geo-dashboard-tunnel.service` 必须 `Requires/After=geo-engine.service`，但不能只依赖 systemd 的启动顺序；`ExecStartPre` 需有限重试 `/health`，防止后端尚未监听时隧道抢跑。
- 私有仓机器身份不可通过复制个人 Token 或私钥解决。若 GitHub 组织禁用 Deploy Key，使用已授权工作站 `fetch`、完整历史 Git Bundle、固定 Commit 与 SHA-256 校验部署；Release 工作树必须 clean，禁止 editable install 污染提交目录。
- GEO `0.4.2` 生产锚点为 Commit `ec249ed0c7d7a45b8b8b8ea7e3b9fabf42036bf1`；新文章生成必须由代码默认值和生产 EnvironmentFile 双重锁定为 `deepseek-v4-flash` + `reasoning_effort=max`。验收不能只看配置字符串，必须用最小真实调用确认返回模型与 reasoning usage。
- GEO 内容状态必须区分 `draft`、`reviewed`、`exported`、`published`。审核通过不等于已发布，静态 HTML/Markdown 导出不等于公网可访问；只有发布目录真实受公网路由提供、canonical/OG/JSON-LD/数据库交付 URL 一致并逐条返回 `200`，才能写为 `published`。
- 发布效果只在存在公开 URL 且完成发布后同口径可见性检测后判断；至少比较可见性分数、品牌提及、品牌域名引用与竞品信号。单篇文章不能直接归因品牌整体变化，没有发布后观测时必须明确显示“不能判断”。
- Dashboard 必须是 API 动态加载而不是服务端嵌入快照；Tab active 同时核对导航类名与当前页面。长耗时 `/visibility`、`/audit` 使用 `ThreadingHTTPServer` 保持健康接口可用，并按操作类型使用单并发信号量防止重复提交。
- Dashboard 从静态快照切为 `fetch` 同源 API 时，Nginx CSP 必须把 `connect-src` 从 `'none'` 改为 `'self'`；否则 API 本身 `200` 但浏览器仍会被 CSP 阻断。上线验收必须检查响应头、控制台和真实数据渲染，不能只用 `curl` 判断前端已打通。
- 网站审计公开后必须防 SSRF：仅允许公网 HTTP(S)，拒绝用户名密码 URL、非全局 IP、内网/本机/链路本地地址，逐跳校验重定向并限制响应体。Nginx 同时实施认证、方法白名单、请求体上限、操作限流和长请求超时。
- Nginx location 匹配是确定性的：exact location 永远优先于 `location /`，不存在“随机命中”。如果 exact 与 fallback 使用不同限流区，同一路径会始终使用 exact 的限流。六个工作流 POST 曾共用 `geo_operations 6r/m burst=2`，造成跨接口令牌竞争和间歇 `503`；修复为 `geo_dashboard 120r/m burst=30` 后，连续三轮 18 次无副作用探针全部后端 `400`、`503=0`。慢操作 `/visibility`、`/audit`、`/fix` 才保留低速桶。
- 全量 fallback 上线后，必须补测所有已有前缀解析路由。GEO 后端的 `path.startswith('/articles/')` 曾导致 `/articles/foo` 抛 `ValueError` 返回 `502`，并把 `/articles/5/delete` 错当文章 5 返回 `200`；因此 fallback 必须与数字详情 regex、命名空间 guard 和 exact 写接口组合使用。Nginx HTML `404` 表示 guard 拒绝，后端 JSON `404` 表示 fallback 已到达应用但端点不存在。
- fallback 只解决“新增接口不用再改 Nginx”，不能替代应用层鉴权、参数校验和审计。Basic Auth 现在覆盖整个 GEO API，凭据风险高于只读看板阶段；多人使用前必须升级统一身份或细粒度权限。
- 生产 `/publish` 由 `GEO_PUBLISH_DIR` 与 `GEO_SITE_URL` 固定输出目录和公开根 URL，EnvironmentFile 优先于请求体；`/fix` 仍允许调用方指定输出目录。GEO Basic Auth 是高权限运维凭据，不得给普通访客使用。公网放行只解决网络可达，业务发布仍需保留人审、公开 URL 和发布后同口径效果证据。
- 资料包版本使用知识库与切片元数据 Hash 生成确定性 `kbp-<hash>`；实验记录只保存脱敏请求、资料包版本、引擎版本、耗时和结果摘要，不保存 API Key 或完整模型回答。SQLite `datetime('now')` 是 UTC，前端必须显式按 `Asia/Shanghai` 显示。
- 真实网站审计或可见性验收会修改实验数与可见性记录数；运行后必须重新读取 `/stats`、`/meta`、`/experiments` 和 SQLite `integrity_check`，再更新文档。禁止沿用操作前的旧计数形成“功能成功但记录过期”的假绿。
- 当前生产数据为 7 篇历史文章：2 篇草稿、0 篇仅导出、5 篇公开发布；5 个交付 URL 均位于 `geo.kidshub.cn/published/` 并返回 `200`。12 条可见性记录、5 条实验记录，资料包 `kbp-6adb88da8625`；最新 `0/100` 是公开链路完成前基线，需等待抓取窗口后同口径复测。
- 当前生产 Release `HEAD=ec249ed`、版本 `0.4.2`、工作树 clean，Nginx Hash `c60604c37aa4836f611936f4491119baa789d6a02d93a1e22ce71f4b9641268e`。远端并发推进或生产热补丁时先逐文件比 Hash；push 被拒绝禁止强推，必须 fetch/rebase，再以最终 Commit 重建 clean Release。
- `/published/<file>` 仅允许 GET/HEAD、根层安全扩展和无目录遍历；`/robots.txt`、`/llms.txt`、`/schema.jsonld`、`/sitemap.xml` 映射到同一发布目录。机器结构首页必须服务端转义并静态生成，禁止把文章标题或摘要直接拼入 `innerHTML`；公开目录只保留有数据库交付账本和索引证据的文章。
- 后续 Release 切换复用 `deploy/company-vm/cutover-geo-engine-release.sh <new-sha> <old-sha> <expected-version> [model] [reasoning]`；脚本原子切换 Release/venv、轮询健康、校验版本/模型/推理等级，失败自动回滚。当前数据库备份为 `/home/futurus/.geo-engine/backups/api-console-v040-20260814-121834` 与 `/home/futurus/.geo-engine/backups/timezone-v041-20260814-122512`。
- 完整证据与回滚见项目文档 `docs/geo-public-dashboard-deployment-2026-08-14.md`。

### 架构白盒画板与 3D 演进

- 默认交互必须“卡片优先”：鼠标左键只选择节点或操作按钮，不承担画布拖动；Mac 触摸板双指平移、鼠标右键按住拖动画布，捏合或 `Ctrl/Command + wheel` 缩放。
- 节点必须使用真实按钮和独立点击热区；连线层固定在节点下方并设置 `pointer-events:none`，使用背景 Halo 和专用走线走廊，禁止连线、标题或透明平面抢占卡片点击。
- 点击节点后焦点位于扣除详情抽屉后的有效画布中心；手动平移只解除位置锁定，保留节点选中和详情上下文。适配全局必须同时清理浏览器隐式滚动偏移。
- 当前标准模式是“二维总体架构 + 阶梯式 2.5D 纵深诊断”。二维负责快速阅读全局关系；2.5D 负责显示 WorkCase 的 Z 层级、当前阶段和卡点，所有卡片必须保持可点击，不以强透视牺牲可读性。
- 真 3D 可作为第三个显式模式，但不得替代二维默认首页。只有当可见节点/边规模、跨域层级或时间演化无法通过过滤、聚焦和走线走廊清晰表达时，才进入 3D 实施。
- 真 3D 推荐采用“3D 拓扑场景 + 始终面向屏幕的 2D Billboard 卡片 + 独立详情抽屉”。文本和点击命中保持二维稳定，Z 轴只表达层级、时间、责任域或执行深度，不把业务语义绑定到自由旋转后的偶然空间位置。
- 3D 控制优先使用明确按钮：Z0-Z4 层级切换、只看当前层、展开/压缩层距、跟随当前 WorkCase、俯视/正视/侧视、重置相机；自由 Orbit 旋转是辅助能力，不是主导航方式。
- 3D 必须复用同一 Ontology Registry、节点 ID、状态 DTO、权限与焦点模型，不能建立第二套架构数据源。验收至少覆盖卡片点击命中、相机重置、层级切换、键盘回退、低性能设备降级到 2.5D、稳定帧率和无权限数据不进入场景。

### Company Capability Governance

- Skill 是会改变 Agent 行为的可执行能力，不得仅按提示词文档管理。能力治理最小对象固定为 `CapabilityDefinition`、`CapabilityRelease`、`CapabilityBinding`、`CapabilityOverride` 和 `CapabilityExecutionSnapshot`。
- Skill 正文继续以 Git 和 H 平台 L0 Store 为真源；Ontology Registry 只保存版本、Hash、来源、绑定、审批、兼容性和执行快照元数据，不把 Skill 正文复制进业务本体。
- 公司核心能力禁止员工个人层同名遮蔽；部门扩展必须使用独立命名空间。合法员工私人能力继续留在员工私人 Bot，不覆盖公司中枢的 Authority、Retrieval、Task Compiler 或 Action Gateway。
- Fork 必须包含共享正文、匹配 source SHA 并经过明确审批；空壳 Fork、来源漂移和未批准覆盖全部 fail-closed。真实用户修改过的合法 Fork 不得自动删除。
- 发布通道必须拆分：Skill 内容走热发布且不重启，H 控制面代码走独立重启窗口，Mini/H Runtime 走独立影子割接窗口；禁止为了 SHA 对齐把三类发布捆绑。
- 重要 WorkCase 必须记录 `behaviorContractVersion`、Capability Bundle Hash、Ontology Schema、模型和 Evidence Package 版本，保证决策可以按当时真实行为配置回放。
- Capability Governance v1 当前为 `contract_only`，白盒必须保持灰色；只有 Registry 元数据、运行时解析、遮蔽审计、执行快照和真实 Canary 全部闭环后才能标绿。

### 公司大脑工作逻辑显式建模

- 一次公司大脑处理过程必须建模为 `WorkCase`，阶段建模为 `WorkStage`；不能只保存最终回答或 H 引擎运行日志。
- 工作阶段固定为 Intake、Scope、Authority、Context、Evidence、Synthesis、Response、Decision、Plan、Execution、Verification、Learning。Goal 4 与 Goal 5 已在生产激活全阶段；每个阶段仍必须受身份、证据、批准、Action Gateway 和 Verification 门禁约束。
- P0-EPI 在既有 13 个命名空间内增量增加 WorkCase、WorkStage、Assumption、Unknown 和 EpistemicAssessment，不新增第二套 Ontology 或事实真源。
- Permissioned Evidence Package v2 必须带事实类型、Provenance、有效期、权限快照、反证、未知、置信依据和 Ontology 版本；无权限资源不得泄露标题、URL、人员或正文。
- Company Agent 必须区分源事实、推导事实、预测、人工判断、假设、未知和冲突；证据不足时允许拒绝形成确定性结论。
- 显式推理只保存证据引用、规则结果、主张、假设、未知、冲突和判断摘要，禁止保存模型隐藏思维链。
- `WorkCase=completed` 不等于 Task、Action 或 Goal 成功；三层结果仍由 Verification 独立记录。
- 10 名真实员工 Canary 延后到 Goal 6 P1-DOMAIN 与 Operating Model 大框架稳定之后，但仍是 20/50 人放量前强制门禁；不得因为单 DRI Lineage 成功就提前放量。
- 生产 `Evidence=0` 必须在策略层 fail-closed：Principal 不存在返回 `permission_denied`，Principal 存在但没有可用 Evidence 返回 `insufficient_evidence`；两类路径都不得调用 H 引擎。
- Migration/View 验收不能只使用数据库 owner；必须以真实应用角色读取稳定 View 和状态接口，避免遗漏 `GRANT SELECT` 造成生产 `42501`。
- 在公司 QNAP 远端执行含 `docker compose exec -T` 的脚本时，禁止通过 SSH stdin/heredoc 直接喂脚本；必须先把脚本传到远端版本化目录，再从文件执行，防止容器命令抢占 stdin 造成半执行或假绿。
- Goal 6 当前生产锚点为 Schema `3.3.0`、Agent Core `2026-08-10.2`、Domain Connector `2026-08-10.1`、Work / Practice Protocol `1.1.0 / active`、Registry `in_sync`；ERP 95、Operations 38、Device 57、Market 369。版本与运行状态属于快照，后续操作前仍需在线复核。
- Decision Lineage 必须区分技术执行、业务结果、经营目标三层成功；`execution_success=true` 不能推出 `goal_success=true`。Learning 默认只能写为 `proposed`。
- 失败 Canary 必须保留审计并显式退役：WorkCase `blocked`、Decision `superseded`、Practice Status `retired`；禁止删除历史，也禁止退役 `goal_verified` Lineage。
- Ontology Definition Source Commit 与 Runtime Release Commit 分开记录。Definition 未变化时不得用运行时热修复提交覆盖 Registry Source Commit。
- Goal 6-A 已完成工程与人工体验验收：QNAP 领域数据面、Operating Model、P1-DOMAIN 和 3D-ready 协议均有生产证据，Capability Governance v1 保持 `contract_only`。H 控制面 `v1.58.2`、Agent Core `2026-08-10.2`、Domain Connector `2026-08-10.1` 已上线；H 发布溯源跟踪 50 个运行文件并为 `in_sync`，真实 Chrome 白盒 `99/99` 通过。川哥于 `2026-08-10` 明确确认 Goal 6-A 验收 ok；Task 6-R 工程闭环单独记录，不从自动化推导新的 owner acceptance。
- 生产切换后的健康断言必须轮询到核心服务 ready，不能在容器刚启动时做一次即时断言；否则会把实际成功的切换误判为失败并触发不必要的恢复。自动恢复仍必须保留，且每次回滚都同时证明旧版可运行、新版可恢复、业务数据不变。
- 任何 H 控制面、QNAP 或其他生产服务的重启都必须获得川哥在当前变更窗口的明确授权；Goal 文件、历史部署授权和“继续 Goal”都不能替代即时批准。申请前必须完成只读基线、目标测试、备份/回滚设计、影响与预计中断说明。
- 修改 `/srv/h-control/.env` 后必须显式恢复 `h-control:h-control / 0600`，并以服务用户验证可读；临时文件原子替换会改变属主，是本次 502 的直接根因之一。
- 管理员密码、Cookie 和登录表单内容不得进入 Playwright 参数、快照或工具输出。密码切换必须从 Git 外来源读取、只报告候选数量和长度，并在新密码登录通过后才更新 Keychain 指针。
- Domain Connector 状态只允许返回 `sourceSystem`、`cursorPresent` 和 `lastSuccessAt`；验证脚本不得打印完整同步 payload 或真实 Cursor。
- 公司 AI Ontology 的 Goal 完成状态必须拆成“工程验收完成”和“川哥人工体验验收通过”两个字段；自动测试、真实 Chrome、生产健康和回滚恢复可以关闭工程门禁，但不得自动推导川哥已经完成产品体验验收。
- 每个可视化或员工入口 Goal 在最终汇报前必须交付可直接操作的体验验收包：真实 URL、登录入口、点击/触控步骤、页面预期真值、安全 Bot 测试 Prompt、通过/失败判据、仍关闭的能力和异常反馈入口。不能等用户追问“怎么体验”才补验收说明。
- 人工体验验收至少覆盖三个表面：架构白盒验证“系统如何运转”，运行看板验证“当前真实状态”，全员飞书 Bot 验证“员工如何使用”；三者通过仍不能替代真实业务结果和 DRI 验收。
- 提供验收入口前必须在线复核版本、登录跳转和关键状态；历史截图、旧 URL、测试报告或记忆只能作为线索，不能冒充当前可体验状态。
- H 版本号不能单独证明生产源码与 Git 一致。本轮 `/healthz` 报告 `v1.56.1`，但 Dashboard/Whitebox 仍是较旧文件；后续必须从已推送 Source Commit 构建，并在重启后对账 Source Commit、目标文件哈希、API DTO 和真实 DOM。发现同版本源码漂移时升补丁版本，不以同一版本静默覆盖。
- Task 6-R 已完成：既有同版本运行文件一致但 Manifest 缺失时走零重启补签；新版本从已推送 Source Commit 构建完整运行时清单、暂存测试、备份、单次重启和浏览器读回。Runtime Source Commit 与发布工具 Tool Commit 必须分离记录；发布前重新 fetch 与读取生产真值，旧准备结论不得继承。
- Agent Core 热修后的重新验收必须使用全新 `run_id`、`requestId` 和 `idempotencyKey`；复用旧键只会重放旧失败。策略治理意图不得直接穿透数据库 `work_mode` 约束，应映射到稳定枚举并保留原治理意图供审计。
- 推荐后续顺序：✅ Task 6-R Release Provenance Guard → **Goal 7 P1-PROD-READINESS（下一工程 Goal）** → Goal 3 十人真实 Canary → Goal 8 24 小时容量与 20/50 人扩容。整库导入、Capability Governance 激活、A2A、真 3D 和业务写回继续独立审批。
- PEST + Industry + Market 是持续运行的公司外部战略情报层，不是一次性知识文档。标准链路为 `Raw Item → Observation → Signal → Trend/Claim → Impact Assessment → Report/Decision Proposal`，再由 DRI 或已批准政策决定是否进入 P2；重大事件可即时创建 Alert/WorkCase，但不得绕过 Decision 和 Action Gateway。
- PESTIM 在因果上采用 `PEST 宏观 → Industry 行业 → Market 市场力量 → GoalFacet` 的多跳图，同时保留政策、融资、人才和技术对公司目标的直接路径。飞书 43 × 108 的 4644 条矩阵全部作为 `generated_draft / unverified / inactive` Impact Hypothesis 导入，不得当作 Fact/Claim 或自动任务规则。
- 日、周、月、季、半年、年度报告必须基于同一批结构化 Evidence/Impact Assessment 在不同窗口重新计算，禁止递归总结下级报告正文；每次 ReportRun 记录 evidence cutoff、source snapshot、Ontology/causal graph 版本、input hash、model、prompt、成本和状态。
- 个人站“前沿资讯雷达”是多个生产者加 Next.js 展示层的聚合，不是可原样迁移的单体项目。公司 QNAP 只复用 Horizon/Theory Radar 的采集、去重、评分、富化、oneshot、影子运行和 last-good 门禁；必须使用公司独立实例、目录、账号、Key 和报告契约，禁止调用个人站 Webhook 或读取个人数据。
- 公司 QNAP 建议采用轻量常驻 Intelligence Orchestrator + 受资源约束的临时 Collector Worker；任何 Shadow/正式部署都需要重新核对公司 QNAP 五元组、做 7 天资源/来源/成本验收并取得当次部署授权。第一条试点改为 P003 读写台及 AI 产品，仅激活经产品、AI、研发、销售、采购和财务 DRI 审查的 20–50 条高价值传导关系。
- PESTIM Strategic Intelligence 详细方案见 `2-Projects/company-ai-ontology/docs/pestim-strategic-intelligence-architecture-2026-08-10.md`。
- P1-SI-A 已完成 contract-only 候选 Schema `3.4.0`：新增 `domain.intelligence`、ExternalFactor、GoalFacet、ImpactHypothesis、ImpactAssessment、StrategicIntelligenceReport 和 ReportRun，离线编译兼容且没有新增 Action Type；生产 active Schema 仍为 `3.3.0`。任何激活必须经过 Goal 7、Source Registry、P003 读写台及 AI 产品 DRI 评审、QNAP Shadow、Ontology Change Proposal 和 Registry reconciliation 门禁。
- P1-SI-B 以 P1-SI-A `3.4.0` 为不可变基线叠加 Source Registry 候选 `3.5.0`，不得改写 P1-SI-A Hash。来源准入必须默认 deny；未登记、暂停、撤销、许可未批/过期、合规未批、个人账号、登录态、反自动化绕过和未授权全文保存全部 fail-closed。工程候选可以先完成，但没有实名公司合规 DRI 审批时，来源必须保持 `paused`，不能把“官方公开 API”自动等价为公司已获许可。
- 公司版雷达的实施位置固定为：P1-SI-C 形成可部署镜像与 Collector；P1-SI-F 完成资源、回滚和 7 天 Shadow 验收准备；P1-SI-H 在 Goal 7 完成且取得当次授权后，才部署到公司 QNAP 并以 `PUBLISH=false` 运行 7 天。P1-SI-G 负责 P003 读写台及 AI 产品传导关系审核，不等于雷达生产部署。
- P1-SI-C Collector 必须在全部网络请求前完成 Source Registry 判定；任一配置来源被拒绝时整次 oneshot 在网络前失败。个人站仅提供设计模式和锁定证据，公司包不得读取个人目录、报告、凭据或 Webhook；构建配方完成不等于镜像已构建，镜像实构、digest 和资源数据必须在 P1-SI-F 单独验收。
- P1-SI-D 数据底座固定 Postgres 为唯一结构化真源，Qdrant 只能是可删除、可重建派生层。Raw Snapshot 保留内容 Hash、dedup/idempotency、双时间、Source Decision 和 Collector 版本；Replay 只能生成新派生记录，不能修改 Raw identity。候选 SQL 必须留在 `candidate-migrations/`，完成隔离 Postgres/回滚验收前不得放进自动生产迁移目录。
- P1-SI-E 报告窗口统一使用 `Asia/Shanghai` 的上一个完整自然周期；周/月/季等报告必须从 Evidence/Signal/Assessment/经营指标重新计算，禁止把日报或周报正文作为上级报告输入。飞书文档、卡片和 H 控制面只是 ACL 过滤后的派生投影，ReportRun 必须保存 source snapshot、input hash、Ontology/causal graph、真实 model ID、Prompt、token、成本、耗时、状态和重试。模型失败不能只落一段错误文字：`failed` 必须保存稳定 `errorCode`、开始/结束时间、耗时和重试谱系，缺任一终态证据失败关闭；`succeeded` 不得夹带错误码，Postgres 和机器验证器必须执行同一状态约束。
- Source Registry 的“允许采集”和“允许保存内容”是两道独立门：`reference_only / metadata_only / summary_metadata` 的 Raw Snapshot 只能保存 Hash、长度、来源和时间，不能保存完整响应体；`metadata_only / reference_only` 的 normalized item 不能保留摘要。只有明确批准的 `full_text` 或合法 `structured_data` 才能保存对应 payload，Collector 必须直接执行 Policy Decision 返回的 retention。
- P1-SI-F 已形成公司 QNAP Shadow 工程候选：轻量 Orchestrator、受限 oneshot Collector、无宿主端口、无 Docker Socket、只读根文件系统、显式部署/数据库/回滚授权门禁，以及七个真实自然日证据包。统一 readiness 必须验证部署授权、Goal 7、不可变发布包、来源审批、P003 最终审核、四名职能角色真实登录权限体验和 Goal 7 Owner Acceptance 七项门禁；API 配置正确不能替代成员体验。回滚授权不得从部署授权继承；自动化测试必须真实执行未授权回滚并证明其在 QNAP 预检、备份读取和容器操作之前拒绝。手动 CI Run `31421625978` / Commit `2974c19ea` 继续证明 Linux/amd64 镜像、010/011、19/19 强制 RLS、baseline restore 和 Artifact 便携校验，但因其早于后三项人审门禁，现只算 `historical_runtime_evidence=true / deploymentEligible=false`。Release Manifest 已升级为 `1.2.0 / P1-SI-F-shadow-candidate-gated`，并要求 `reviewerRoleAccessGateRequired=true`；旧 `1.1.0` 及更早包必须失败关闭，最终不可变发布包需在实名审核、成员权限体验和 Goal 7 完成后从已推送 Commit 重建。
- P1-SI 七日 Shadow 不得靠“七个文件存在”验收：单日 `sourceAttemptCount=0`、缺失资源/安全/撤权/业务副作用审计、非成功状态或 `simulated/publish` 不为 false 都必须失败；七日编译器还要证明上海自然日恰好连续 7 天、每日 Evidence/Evaluation Hash 绑定、Source Commit/Collector 镜像/Policy 不漂移，以及 P2/员工投递/ERP/社媒写回/因果激活/新端口/restart count 全为 0。编译结果只能先得到 `engineeringVerified=true / ownerAccepted=false`；川哥在第七日完成后以独立显式确认记录 Owner Acceptance，最终验证器必须重新读取全部日证据，任一日被修改即使既有验收失效。
- P1-SI-B/G 的真实飞书审核工作台为 `https://futurus.feishu.cn/base/OqLZbB3Tza2d1ysQUFlcuZkQnZx`：来源表 21 字段/8 条，P003 表 30 字段/36 条，六类各 6 条。`2026-08-11` 已配置高级权限和最小角色，来源 8/8 已预填结构化审核 Principal，P003 30/36 已预填结构化个人 DRI 与参与者；线下渠道责任人进入 To C 线下渠道职能角色。P003 权限必须拆成产品与用户、AI 研发、品牌、To C 线下渠道四个记录级职能角色，旧宽泛联合角色成员保持 0；过滤字段 `categoryKey` 使用 SingleSelect，飞书读取返回的单元素数组必须由正式导入器归一化为字符串，空数组、多选数组和非法值失败关闭。API 配置验证不能冒充成员本人逐一登录体验验收。脱敏 `inspect-assignments` 只检查责任覆盖；`inspect-progress` 只输出决定、必填项、类别进度和最终校验错误数量，禁止输出姓名、Principal、证据链接、审核正文、受控路径或具体错误。来源 8/8 分配完整；P003 个人 DRI 30/36、必要角色位 90/150、全角色覆盖 12/36；实时人工进度仍为来源 8 pending、P003 36 pending，P003 语义重写/支持证据/反证均为 0。真实 CSV 导入与普通 validate 通过，但最终决定仍为 0/8 和 0/36，全部关系继续 `pending / inactive`。实名字段必须是 JSON Principal 对象或对象数组，姓名字符串不能通过机器契约；预填分配不得描述成合规批准或因果审核完成。
- P1-SI-G 已从真实 4644 条矩阵中筛选 36 条 P003 候选，六类各 6 条；源矩阵覆盖完整但语义模板化，所有候选固定为 `generated_generic_requires_rewrite / generated_draft / unverified / inactive / pending_dri_review`。每条关系必须由实名 DRI 重写传导逻辑并补齐支持证据、挑战证据、适用条件、方向、强度、滞后、验证指标和失效条件，不能只用角色名或模型生成文本通过审核。
- P1-SI 来源与 P003 人工审核统一使用“Git 脱敏模板 → 飞书填写 → CSV 导出 → `import-csv` 强类型 JSON → `validate --final` → compile”闭环。数组和对象必须保存为 JSON 单元格；只读候选字段、Hash、来源入口、建议角色和指标发生漂移时 fail-closed。实名审核结果默认进入 `~/work-private/company-ai-ontology/reviews/` 或批准的公司受控目录，不进 Git、共享记忆、截图或公开日志。来源 compile 只生成 `shadow_reviewed` 且禁止发布；P003 compile 只生成激活提案资格且关系继续 `inactive`。
- P1-SI-H 才是公司 QNAP 雷达实际部署阶段；必须同时满足 Goal 7、来源合规批准、P003 真实 DRI 审核、镜像与 SQL Runtime 验证、已推送不可变发布包、公司 QNAP 五元组在线核对和当次部署授权。部署、服务重启和真实回滚演练分别授权；七个真实自然日 `PUBLISH=false` Shadow 完成前不得关闭 P1-SI Goal。
- P1-SI-H 的 `deploy-shadow.sh` 必须同时校验 `SI_APPROVED_SOURCE_REGISTRY_FILE`、`SI_APPROVED_COLLECTOR_CONFIG_FILE` 和 `SI_APPROVED_P003_REVIEW_FILE`。P003 工作簿必须 `requireFinal=true`、36 条全部最终决定、所有关系保持 `inactive`；任何 pending、候选 Hash 漂移、缺实名参与者或提前激活都在数据库迁移和服务启动前 fail-closed。实名候选清单只能留在 `~/work-private/company-ai-ontology/reviews/`，Git、共享记忆和公开报告只记录脱敏数量与门禁状态。
- `GOAL7_STATUS=complete` 不能单独作为 P1-SI-H 证据。部署与独立数据库迁移都必须要求 `SI_GOAL7_ACCEPTANCE_FILE`，并验证 `engineeringVerified=true / ownerAccepted=true`、Authority 与 Runtime 关键证据完整、Route B 关闭、整库导入/真实员工 Canary/私人 Bot 迁移/ERP 与社媒写回继续关闭；模板默认不可通过。
- P1-SI-H 部署前统一执行 `npm run readiness`。检查器必须同时验证当次部署授权、Goal 7 状态、不可变发布包、已审批 Source Registry/Collector Config、P003 最终审核和 Goal 7 Owner Acceptance；缺失输入与无效输入分别返回稳定原因码并以退出码 `2` 失败关闭。输出只允许脱敏门禁状态，不得包含路径、审批正文、实名人员或 Secret；`deploy-shadow.sh` 必须强制调用同一检查器，避免“人工看板显示阻断但执行入口仍可绕过”的双真源。
- P1-SI Goal 最终关闭前先执行 `npm run goal:validate-runtime-snapshot` 分别验证部署前和七日 Owner Acceptance 后的公司 QNAP 运行快照，再用 `npm run goal:compile-completion-evidence` 从两份快照、不可变发布包、五类审批原件和七日原始证据自动编译最终完成证据，禁止人工填写摘要 Hash。最后执行 `npm run goal:completion`，重新要求 Release、Deployment、七日 Summary 的 Source Commit、Collector Image、Policy Version/Hash、active Ontology Hash 与审批 Evidence Hash 一致；只有 `goalCompletionEligible=true / requiredGate=GOAL_COMPLETE` 才具备机器关闭条件。
- P1-SI 可在正式门禁完成前使用独立 `internal_engineering_shadow` 做 1～3 天管理员排错，但只能选择 2～3 个无需登录、凭据或反自动化绕过的公开来源，保存级别限于 `reference_only/metadata_only`、最多 3 天，并只保留六类各 1 条 inactive P003 样例。内部证据必须记录 `productionApprovalSatisfied=false / countsTowardProductionShadow=false`，不能替代来源审批、P003 最终审核、成员 UAT、Goal 7 或七日正式 Shadow；部署、单次运行和真实回滚分别授权。
- 内部来源必须在 Plan 中提供确定 `endpointRef`。端点只能匹配 Registry 已登记的官方 origin/path；GitHub 模板必须展开为 `repositoryAllowlist` 内的具体仓库且 `per_page<=20`，禁止把 `{owner}/{repo}` 等模板直接交给 Worker。
- QNAP 内部部署包不能只复制 `deploy/qnap/strategic-intelligence`。任何部署后仍导入 Ontology Contracts 或 Collector 代码的 Validator 都要求保留完整 `company-ai-ontology` 项目树，并用真实部署目录布局执行回归测试；部署入口还必须在临时 QNAP 目录中配合真实源码包、虚拟镜像包和假 Docker 跑完整脚本，证明只发生镜像加载/检查和 Compose config，容器启动、数据库迁移、Dispatcher 安装及既有服务重启均为 0。
- QNAP bind mount 写权限不能假设镜像固定 UID `10001/10003` 与宿主目录所有者一致。Compose 必须使用在线验证过的非 root 部署账号 UID/GID；部署入口必须在镜像加载、备份、迁移和目录替换之前拒绝 `uid=0`，避免失败关闭后仍留下副作用。
- 内部 Runtime 更新不能把“备份目录或指针存在”当作可回滚证据。替换前必须生成非空 `previous-runtime.tar.gz`，验证 tar 可读、包含 `package/`、`config/`、`.env.internal`，并生成/复核同目录 SHA-256；回滚脚本必须在创建 retired 目录或移动当前 Runtime 之前验证这些证据。首次安装留下的空备份指针必须拒绝回滚，不能把当前包移走后恢复为空。
- `internal_engineering_shadow` 的发布包、QNAP Runtime 更新和首次 Collector 运行是三个独立状态。Artifact `9096846710` 与 `9107441466` 已分别因 QNAP 格式兼容和非原子切换风险失效；Artifact `9108034290` 已更新为公司 QNAP 当前内部 Runtime，旧 `a7aeae25e` 已形成完整校验备份。首次 Collector 已在后续独立授权下完成，当前工程回归为 `77/77`；任何第 2～3 天内部运行、生产迁移、生产部署、重启或回滚仍需新的独立授权。
- 首次内部 Collector 已完成：第一次尝试在 Worker 启动前因外部网络名误写为 `company-ai-foundation_data` 失败，来源请求和 Snapshot 为 0；Foundation 实际固定网络是 `company_ai_data`。修复 QNAP 0600 环境及源码默认值后，真实运行 3 来源各 20 条、总计 60 条、Hash-only、正文 0、重复 0，Foundation 稳定、临时资源和五类业务副作用归零，Evidence accepted 且不计入生产 Shadow。Strategic Intelligence 回归现为 `77/77`；未来发布必须从包含网络修复的已推送 Commit 重建 Artifact。
- 内部 Runtime 更新只接受当次明确授权，且默认只能替换战略情报 package/config/env、验证非空备份归档与 SHA-256、执行 Compose config 和复核 Foundation 指纹；不得继承为首次采集、生产迁移、Foundation 重启或真实回滚授权。首次运行必须另行授权，并为成功和失败路径都生成 0600 的机器 Evidence，固定 `countsTowardProductionShadow=false`。
- P1-SI 完成状态必须由门禁检查器派生。当前来源最终决定 `0/8`、P003 最终决定 `0/36`、四角色 UAT 与 Goal 7 Owner Acceptance 缺失，Deployment Readiness 为 `0/7`、Goal Completion 为 `0/8`。这些计数是 `2026-08-11` 快照，执行前必须实时回拉；当前四态为 `engineering_verified / human_review_pending / runtime_updated / production_blocked`，Runtime 已更新不能覆盖 `owner_accepted=false` 或生产门禁。
- Goal 7 P1-AUTHORITY/P1-RUNTIME 已形成未部署工程候选：飞书 `type/member_type` 归一化为 user/department/chat Principal；实际发送者是唯一请求主体，多人艾特不扩权，私聊不继承群权限，chat ACL 必须同时具备 60 秒内 active 成员 Evidence；用途只收窄。会话审计只保存 chat Hash、规则、结果和有效期，不保存正文。
- Goal 7 Runtime 候选对 Route A 独立熔断，只重试网络/超时/限流/5xx；配置 Token/费用预算并强制 provider/model/完整 Token usage 真实读回，空 usage 或不自洽分项必须失败关闭。模型已实际消耗后才触发预算拒绝时仍必须以 `budget_blocked` 写入无正文账本，不能因拒绝回答而丢失成本；隔离 PostgreSQL 验证还必须以真实 `ontology_app` 角色执行成员、授权快照、Route 和用量表读写。Route B 无独立公司凭据时必须保持 disabled，当前个人 CPA 只记录 `temporary_personal_credential`。012 候选迁移不得进入现有生产 `migrate.sh`，必须先通过已推送 Commit 的固定 PostgreSQL 17 CI、合成飞书 Canary、真实 Worker 读回和 Owner Acceptance。
- Goal 7 Acceptance 不能再由人工填写通过布尔值。`2.0.0` 最终证据必须由同一 Source Commit 下的 Runtime Workflow、真实 Worker provider/model/usage、飞书合成权限 Canary、公司 QNAP 部署真值和独立 Owner Acceptance 五份原始 JSON 编译；Validator 必须重新读取固定文件、校验 SHA-256、Commit 一致性和 Owner Acceptance 时间。替换原始文件、提前验收或直接修改最终 JSON 均失败关闭。
- P1-SI-H 的两阶段 Runtime Snapshot 必须与 Goal 7 的 012 迁移对齐：部署前快照精确为 `['012']`，证明 Goal 7 已完成且战略情报 010/011 尚未应用；七日后快照精确为 `['010','011','012']`。继续要求部署前 `[]` 或七日后只有 010/011 会与真实完成顺序矛盾，必须失败关闭。
- P1-SI 人审要求“每条有最终决定”，不要求“每条都批准”。在不降低门禁的前提下，来源可采用 3 个已验证公开来源 `approve_for_shadow`、其余 5 个 `keep_paused`；P003 36 条仍全部完成最终审核，但只对六类各 1 条做完整 `approve_for_activation_proposal` 深审，其余 30 条使用有理由、有实名参与者的 `keep_inactive/reject`。所有关系仍保持 `inactive`，后续只能依据 Shadow Evidence 发起新提案。
- 公司 QNAP 宿主机不保证提供 `node` 命令。需要在宿主侧运行 JavaScript 编译器的隔离验收脚本必须支持显式 `NODE_BIN`；可复用已批准 H-Lite 镜像的固定 Image ID 启动临时 Node 容器，但必须 `network=none`、无端口、无 Docker Socket、只读根文件系统、受限 CPU/内存，并只挂载验证源码与一次性输出目录。缺少 Node Runtime 时必须在创建 Docker Volume 或容器前失败关闭。
- P1-SI 的正式 `deploy-shadow.sh`、迁移、Dispatcher、Domain 持久化、Source 撤权审计和业务副作用审计都属于 QNAP 宿主脚本，必须统一使用 `NODE_BIN` / `node-runtime.sh`，不得只修内部模式后仍在正式路径直调 `node`。固定 Node Image ID/Digest 必须写入 0600 的 `.env.shadow`，使 crontab Dispatcher 在首次 Node 调用前加载；最终审批原件必须先放入战略情报受控根目录的 `approvals/<release-id>/`，避免隔离 Runtime 扩大挂载范围。
- QNAP 临时 Node Runtime 使用 `docker run -i` 时会消费调用进程的标准输入。不得在仍有后续命令的 SSH heredoc 中直接连续调用；应上传一次性远端验收脚本并以 `</dev/null` 执行，或给每次 Node 调用显式断开 stdin，否则后半段验收可能被吞掉并形成假绿。
- 公司 QNAP 隔离 PostgreSQL Runtime 验证与正式不可变发布是两层证据。未提交工作树可以证明 010/011、RLS、Domain 持久化、幂等、ACL fail-closed 和 baseline restore 的工程可执行性，但必须记录 `workingTreeDirty=true / immutableReleaseVerified=false / countsTowardProductionShadow=false`；只有从最终已推送 Commit 运行 Runtime Workflow 才能生成部署候选。
- QNAP RestartCount 必须按目标 Compose 作用域核对，不能用全机容器总和替代 Foundation 结论。Foundation 指纹只统计当前运行中的 13 个长期服务；Compose 一次性 `foundation-init` 正常 `exited(0)` 不算故障，也不能把 `docker ps -aq` 的 14 个总容器误写成 14 个在线服务。战略情报项目反而必须用全量容器检查，任何退出后残留的临时 Collector 都视为资源泄漏。当前 Foundation 13 个长期服务前后均为 `restart_count=0`；隔离验证还必须比较容器/镜像/端口指纹并确认临时容器、网络、卷和目录清零。
- Docker `--format` 的转义语义必须在目标 QNAP 实机验证。QNAP Container Station 的 Go Template 会原样输出模板中的 `\t`，不能假设它变成真实制表符；运行态采集应使用不可能出现在字段中的稳定分隔符，并让测试替身记录实际 `--format` 参数。否则本地假 Docker 可能输出真实 Tab 而形成假绿，生产会把健康服务误报为异常并把 restart 解析为 `null`。
- 内部 Runtime 更新不能先覆盖 active config/env 再验证 package。package、config 和 `.env.internal` 必须分别写入 `.next`，在 Runtime Validator 与 Compose config 全部通过后才进入统一切换；切换过程要记录 previous 与已安装 marker，任何中途失败都自动移走新条目并恢复旧三件套。备份归档和自动恢复是两层保护，不能互相替代。
- P1-SI-A 已通过提交 `8444fb10f` 发布候选编译能力到公司 QNAP Registry 镜像，但没有激活 `3.4.0`。专项发布先离线编译，再仅重建 Registry，切换 2 秒、`restart_count=0`、Registry `in_sync`；回滚备份位于 `/share/CACHEDEV2_DATA/ai-ontology-backup/p1-si-a/20260810-p1-si-a-8444fb10f`。用户授权“部署 contract-only 能力”不能外推为“激活候选 Schema”或“授权真实回滚演练”。
- P1-SI-A 验收见 `2-Projects/company-ai-ontology/docs/p1-si-a-pestim-ontology-definition-acceptance-2026-08-10.md`。
- P1-SI-B 验收见 `2-Projects/company-ai-ontology/docs/p1-si-b-source-registry-acceptance-2026-08-10.md`。
- P1-SI-C 验收见 `2-Projects/company-ai-ontology/docs/p1-si-c-company-radar-package-acceptance-2026-08-10.md`。
- P1-SI-D 验收见 `2-Projects/company-ai-ontology/docs/p1-si-d-strategic-intelligence-data-foundation-acceptance-2026-08-10.md`。
- P1-SI-E 验收见 `2-Projects/company-ai-ontology/docs/p1-si-e-multi-period-reporting-acceptance-2026-08-10.md`。
- P1-SI-F 验收见 `2-Projects/company-ai-ontology/docs/p1-si-f-qnap-shadow-readiness-acceptance-2026-08-10.md`。
- P1-SI-G 验收见 `2-Projects/company-ai-ontology/docs/p1-si-g-p003-review-candidate-acceptance-2026-08-10.md`；人工审核工作包见 `2-Projects/company-ai-ontology/docs/p1-si-g-p003-dri-review-pack-2026-08-10.md`。
- 来源合规与 P003 DRI 人工审核闭环见 `2-Projects/company-ai-ontology/docs/p1-si-human-review-workflow-acceptance-2026-08-10.md`。
- 详细实施计划见 `2-Projects/company-ai-ontology/docs/company-brain-work-logic-modeling-plan-2026-08-09.md`。

当前实现与切换流程见：

- `2-Projects/company-ai-ontology/services/knowledge-connector/`
- `2-Projects/company-ai-ontology/docs/h-engine-credential-cutover.md`
- `2-Projects/company-ai-ontology/docs/technical-architecture-progress-2026-08-07.md`

## 架构决策基线

V2.2 的持久文本与图源见：

- `references/architecture-v2.md`
- `references/architecture-v2-overall.mmd`
- `references/architecture-v2-technical.mmd`
- `references/architecture-v2-qnap.mmd`
- `references/architecture-v2-task-flow.mmd`
- `references/architecture-v2-bot-flow.mmd`
- `references/architecture-v2-market-loop.mmd`
- `references/architecture-v2-agent-core.mmd`
- `references/architecture-v2-h-lite.mmd`

V3 的目标骨架、认知—实践闭环和技术图源见：

- `../../../2-Projects/company-ai-ontology/docs/architecture-v3-cognitive-practice-skeleton.md`
- `references/architecture-v3-overall.mmd`
- `references/architecture-v3-technical.mmd`

V2.2 仍是当前生产运行基线；V3 是增量建设目标，未经真实 P2、权限负测和 Change Proposal 验收，不得把目标架构描述为生产完成。

## 既有飞书文档

当前方案沉淀文档：

- `公司 AI Ontology 基座架构方案 V2.2`
- `https://futurus.feishu.cn/docx/Xd3qdCtmXogh0rxmEhDc8pL1nub`
