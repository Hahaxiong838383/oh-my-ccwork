---
name: company-ai-ontology
description: 公司 AI Ontology 基座架构与实施入口。用于经营目标/P2 任务拆解、全员飞书 Bot、H 平台复用、爱视可 ERP 接管、社交媒体监控接管、QNAP NAS 部署、权限化检索、Action Gateway、人审与审计闭环。触发词："AI Ontology"、"公司 AI 基座"、"经营任务中枢"、"全员 Bot"、"H 平台打通"、"爱视可 ERP 接管"、"社媒监控接管"。
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

## 核心结论

公司 AI 基座不是“一个问答 Agent”，而是 Ontology 驱动的经营操作系统：

```text
市场为什么要做 -> 公司决定做什么 -> 员工具体做什么 -> ERP 证明做到哪里 -> 市场再验证效果如何
```

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

## 既有飞书文档

当前方案沉淀文档：

- `公司 AI Ontology 基座架构方案 V2.2`
- `https://futurus.feishu.cn/docx/Xd3qdCtmXogh0rxmEhDc8pL1nub`
