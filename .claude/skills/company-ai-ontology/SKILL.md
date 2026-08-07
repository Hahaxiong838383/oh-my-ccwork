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

- H 平台：飞书 Bot 接入、授权卡片、Runner、Outbox、任务日志、并发调度、完成回执。
- AI Ontology：目标、P2、任务、决策、产品、ERP、市场信号、成果、证据和权限语义。
- Grok Build：AI 执行核心。
- Cognee + Qdrant + Postgres：公司级共享记忆、知识图谱、向量召回和结构化真源。
- Action Gateway：所有业务写回的强制安全边界。

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

- 飞书 Bot Bridge。
- 精确 scope 授权卡片、device-flow、自动续跑。
- Runner / Grok 调用链。
- `short/full` taskMode。
- 多用户 profile、隔离 HOME / lark-cli HOME。
- Delivery Outbox、Feishu ACK、完成卡片。
- Task Session Log、并发调度、任务恢复。

不能裸复用：

- Runner 不能直接查全量 Ontology、ERP、社媒或飞书文档。
- Runner 不能直接写 ERP、飞书、Git、报表。
- SQLite/JSONL 不能作为公司级长期唯一真源；P0 可过渡，P1 迁 Postgres + `tenant_id` + RLS。
- 全员 Agent 不能成为超级管理员 Agent。

必须新增：

- `Ontology Service`：公司经营语义对象与关系。
- `Permissioned Retrieval Gateway`：先算权限，再检索，再组证据包。
- `Task Compiler`：经营目标/P2 拆成任务图和个人任务。
- `Mandatory Action Gateway`：Action Intent、dry-run、人审、执行、读回校验、审计、回滚。

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
- 信号不是结论，必须经过 Opportunity / Decision Agent 形成建议。
- MediaCrawler 若触发小红书 re-login/risk-control，不自动恢复、不绕过登录、不加并发，等待用户明确指令。

## P0 最小闭环

1. 从社媒痛点生成 `Opportunity`。
2. 生成 `Decision Proposal`。
3. DRI 审批后生成公司 P2。
4. `Task Compiler` 拆成个人任务。
5. H 平台投递到员工飞书 Bot。
6. 员工提交成果链接、文档或表格。
7. QA Agent 按验收标准预检。
8. DRI 验收。
9. Ontology 回写目标、任务、成果、卡点、ERP/市场关联。

## 验收红线

- 必须证明真实业务结果，不只证明 HTTP 200、消息发送或 Runner exit 0。
- 无 Feishu ACK 不算送达。
- 无读回校验不算动作完成。
- 无权限过滤证据包不许回答公司内部信息。
- 无 Action Gateway 不许写回业务系统。
- 管理层看任务状态、成果和卡点，不默认看员工私人对话全文。

## 既有飞书文档

当前方案沉淀文档：

- `公司 AI Ontology 基座架构方案 V1.0`
- `https://futurus.feishu.cn/docx/Xd3qdCtmXogh0rxmEhDc8pL1nub`

