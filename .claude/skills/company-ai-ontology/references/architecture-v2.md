# 公司 AI Ontology 基座 V2.2 决策基线

## 架构术语规则

- 所有业务方案、架构图、接口说明和管理汇报统一使用 `H 引擎` 描述 AI 执行层。
- 底层模型实现和版本只属于 H 引擎 Adapter 的部署细节，不进入业务架构命名。
- “事件订阅主实例”仅表示同一公司飞书 App 的事件由一个 H-Lite 实例接收，避免重复回复；公司级 Bot 仍是一个面向全员并发服务的逻辑 Agent，不涉及员工私人 Bot 切换。

## 已拍板的十项决策

1. P0 采用 `P2 -> DRI 批准 -> 个人任务 -> Bot 陪跑 -> 成果 -> DRI 验收`。
2. 首发按 50 人设计，以 10/20/50 三批 feature flag 放量，后续扩至 150/300 人。
3. P0 只选一个试点部门、一名 DRI 和一条真实 P2。
4. AI 只生成任务草案，DRI 批准后才允许派发。
5. Ontology/Postgres 是任务状态唯一真源，H 平台只保存 append-only 事件。
6. Cognee 移出 P0，Qdrant 只做可重建派生索引。
7. QNAP 从 P0 起直接进入在线关键路径，承载 H-Lite、Company Agent Core、主 H 引擎 Runtime Pool、控制面与数据面。
8. ERP 和社媒在 P0 只作为只读证据源。
9. P0 前完成最小不可绕过 Mandatory Action Gateway。
10. 上线前发布员工数据章程和个人数据可见性页面。

## Company Agent Core 部署定位

- 面向全员的 Agent 是一个唯一逻辑服务 `Company Agent Core`，主实例部署在 QNAP。
- Company Agent Core 通过 `H 引擎` 承载 Agent Router、Context Compiler、Task Proposal Compiler、Session Orchestrator、Prompt/Policy Version Registry 和主 Runtime Pool。
- `H 引擎` 是稳定的公司级 AI 执行抽象；底层模型实现和版本属于可替换的部署细节，不进入业务架构图或业务接口。
- 发送给 H 引擎的内容必须经过权限过滤和最小化组包。
- QNAP H-Lite 只负责新建公司级飞书 Bot 的独立订阅、Bridge、授权、Outbox、ACK/读回和 Agent Core Adapter，不承担 Agent 身份或公司业务真源。
- 现有 H 平台及员工私人 Bot 保持原 App、原事件订阅、原私人记忆和原运行位置，不迁移、不切换，也不默认向公司 Ontology 暴露私人会话。
- Company Agent Core 的长期状态全部写入 Ontology/Postgres；H 引擎本地 HOME 和会话缓存均按安全域隔离且可重建。

## QNAP 主底座设计

- 飞书接入：H-Lite WebSocket Subscription、Bot Bridge、授权、Outbox、ACK/读回、Task Session Log、提醒和恢复。
- 核心 AI：Company Agent Core、Agent Router、Context Compiler、Task Proposal Compiler、Session Orchestrator、主 H 引擎 Runtime Pool。
- 主控制面：API Gateway、Identity、Policy、Ontology、Action Gateway。
- 主数据面：Postgres、Qdrant、Redis、Object Storage、Audit、Observability。
- 扩展执行面：Mini/Studio 只在扩容时承载无状态 H 引擎 Worker Cell。
- 数据保护：Postgres PITR、WAL/快照落 RAID1、每日离机加密备份、季度恢复演练。
- P0 单主策略：接受 QNAP 是主节点，但不接受无备份、无恢复、无资源限制、无故障演练的裸单点。
- 禁止事项：QNAP 不运行本地大模型；Redis/Qdrant/H SQLite 不得成为任务事实真源；Runner 不持有长期业务系统凭据。

## P0 真实验收

- 一条真实 P2、唯一 DRI、5 到 10 个已批准个人任务。
- 飞书真实送达 ACK，至少 3 名员工提交真实成果。
- QA 规则预检发现一条故意缺证据的成果。
- DRI 完成真实通过/退回。
- 同一事件重复投递不产生重复任务。
- Company Agent Core、H 引擎 Worker 和 H-Lite 均无法绕过 Action Gateway 直写 ERP、飞书、Git 或报表。
- 跨员工、跨部门越权访问精确失败。
- QNAP 重启后任务、成果、审计与队列可恢复；备份恢复演练满足约定 RTO/RPO。

## 容量与资源原则

- QNAP 负责 H-Lite、Company Agent Core、公司控制/数据底座和首批 Runtime Pool，但不能把 300 人的模型执行并发全部压在 NAS。
- 50 人首发：QNAP 内 H-Lite、短任务池与长任务池分离，平台容器总内存硬上限建议不超过 6GB。
- 150 人：增加 Worker Cell，独立部门配额和 Admission Control。
- 300 人：按 public/product/erp/management 安全域分 Cell，执行面横向扩展。
- 所有容量数字在 24 小时峰值、5/10/20 并发阶梯压测后校准。
