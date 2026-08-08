# 公司 AI Ontology P0 A-F 验收报告

验收时间：2026-08-08（Asia/Shanghai）

## 结论

P0-A 至 P0-F、独立公司 Bot、通讯录、公司 H 引擎和知识 Connector 均已部署。Agent Core 已切到真实远程 H Runtime 并返回 `productionReady=true`；H Worker 已使用独立 CPA API Key，通过 Grok Build 调用 `grok-4.5`。试点飞书文档因公司 App 缺少分享权限被 fail-closed 跳过，未读取正文。真实 P2/DRI 尚未接入。

## P0-PROD-2：H 引擎 Runtime

- Agent Core 已集成 H 引擎 Adapter，架构和 API 只暴露统一的 H 引擎能力，不暴露底层模型品牌。
- dev198 公司 H Worker 使用 HMAC、最大并发 2、单轮执行、禁用 Web Search/Memory/Subagent，并通过 0600 临时文件传递 Prompt。
- QNAP Agent Core `2026-08-08.4` `/readyz` 返回 `ready`、`productionReady=true`、`mode=remote`、`credentialMode=cpa-api-key`、`engineProvider=cpa-openai-compatible`、`model=grok-4.5`。
- 真实 H 推理已返回预期校验结果；Worker 与 Agent Core 均 `restart_count=0`。
- Worker 使用独立 HOME/Grok HOME；CPA Key 仅位于 dev198 的 0600 环境文件，QNAP 不持有模型凭据。
- CLI 超时、输出上限、崩溃错误和凭据门禁具备明确状态码。
- Grok Build 自定义模型使用独立别名 `cpa-grok-4-5` 映射上游 `grok-4.5`，避免与内置模型同名后误走 xAI 官方鉴权。

## P0-PROD-3：公司知识 Connector

- Knowledge Connector `2026-08-08.2` 已在 QNAP 健康运行，`restart_count=0`。
- PostgreSQL 已具备 `knowledge.resources`、`knowledge.acl_entries`、`knowledge.chunks`、`knowledge.sync_runs`，独立登录角色、RLS 和最小授权均存在。
- 支持公开团队知识空间自动发现、显式私有资源、Docx/Sheet/Minutes、文档 ACL、空间成员、人员和部门映射。
- Compose 显式资源改用 Base64 JSON，已修复 JSON 环境变量被转义导致的容器重启问题。
- 当前试点资源同步结果为 `resourcesSeen=1`、`indexed=0`、`skipped=1`、`failed=0`、`chunks=0`；原因是文档分享权限接口返回 `1063004`。
- 系统在 ACL 不明时未读取正文、未生成 chunk，并保持资源 `acl_status=unknown`、`status=skipped`。
- 使用临时合成知识证据完成生产链路验收：授权员工 Evidence 命中且 H 回复命中；另一名员工 Evidence 为 0、无泄露；测试数据已删除。

## P0-B：公司 Bot H-Lite

- `company-qnap-lite` 已在 QNAP 健康运行，当前为 `active`、`subscriptionEnabled=true`，真实飞书 WebSocket 长连接在线。
- H-Lite、员工私人 H 平台和私人 Bot 的 App、订阅、会话、记忆完全独立。
- H-Lite SQLite 保存 append-only 运行事件，不保存公司任务真源。
- 独立公司飞书 App/Bot 已使用 QNAP 本地 600 权限环境文件接入；真实验收读回 `p2p:post`、`p2p:text`、`group:text` 三类消息。
- 真实处理结果：3 条 `feishu_turn_received`、3 条 `feishu_turn_completed`、0 条 `feishu_turn_failed`，去重记录 3 条；H-Lite 健康且 `restart_count=0`。
- Agent Core 当前为 `ready`、`productionReady=true`、`mode=remote`；后续继续完成 10 人 Canary 与真实 P2/DRI 闭环。

## P0-PROD-1.5：通讯录身份同步

- 飞书通讯录数据范围接口返回 `code=0`，当前授权范围为 4 个部门入口；展开后可见 83 个部门。
- 部门员工列表和员工 `open_id` 直读均返回 `code=0`，已具备主动定位员工的基础能力。
- 新增只读目录枚举器、HMAC 服务身份 `company-directory-sync` 和 Agent Core Principal Upsert；普通员工身份调用同步接口返回 403。
- 首次同步发现并写入 414 名可见人员；第二次同步新增 0、更新 414，证明 Upsert 幂等。
- PostgreSQL 读回 414 个 `source=feishu-directory` Principal、2 条同步审计；邮箱、手机号和私人文本属性命中 0 行。
- 当前 Agent Core `2026-08-08.4`、H-Lite `2026-08-08.2` 均健康，飞书 WebSocket 保持连接，两个容器 `restart_count=0`。

## P0-C：权限化检索

- 已实现飞书身份映射、Principal/Grant、分类等级过滤和 Evidence Package。
- 十名普通演示员工读取 restricted 经营预算均为 0 条。
- 演示 DRI 可读取 1 条 restricted 证据；未知用户读取 0 条。
- `POST /v1/privacy/my-data` 允许员工查看自己的身份、任务数量和成果数量，同时明确私人对话不进入 Ontology。

## P0-D：P2 任务闭环

- 十名演示员工完成 `draft → approved → assigned → in_progress → submitted → accepted`。
- PostgreSQL 读回：10 个 accepted tasks、10 个 acked deliveries、10 个 artifacts。
- Task Events 读回：approve、assign、start、submit、accept 各 10 条。
- H-Lite SQLite 读回 `p0_demo_cycle_completed`，任务数、验收数、ACK 数均为 10。

## P0-E：Mandatory Action Gateway

- 独立 `action_gateway` 数据库角色和容器已上线。
- 演示动作完成 `proposed → dry_run_ready → approved → executing → verified → rolled_back`。
- 读回和回滚校验均为 `true`，演示目标最终恢复为 `todo`。
- 权限负测：Agent Core 无权更新 Action Intent、无权更新演示业务对象；Action Gateway 无权更新 Workflow Task。

## P0-F：十人 Canary

- 5/10/20 并发全部成功，HTTP 状态均为 200；P95 分别为 369ms、543ms、338ms。
- Agent Core 已启用 H 引擎并发准入：默认并发 4、队列 32、排队超时 5 秒。
- Outbox 重投演练：演示消息从 pending/attempt 1 经重投后变为 acked/attempt 2。
- Agent Core 与 H-Lite 容器重启后，10 个 accepted tasks、10 个 artifacts、Action Audit 和 SQLite P0 事件均恢复可读。
- 空载验收内存：Agent Core 约 14.61MiB、Action Gateway 约 15.89MiB、H-Lite 约 11.61MiB、Postgres 约 34.84MiB。
- 已发布员工数据章程：`docs/employee-data-charter.md`。

## 备份与恢复

- RAID1 `pg_basebackup` 已通过 `pg_verifybackup`。
- PITR 已真实回放 WAL，并在隔离 PostgreSQL 中读回恢复标记。
- 离机备份已使用 Mini 3072-bit RSA 公钥和 AES-256 加密，从 QNAP 传输到 Mac Mini。
- Mac Mini 解密、SHA-256、gzip 和关键 Schema 校验均通过；离机包 SHA-256 为 `8d9f3b336b486154707c1c30d25a2c44cb0c4ca6b5d670a8d3db1bda6a183464`。

## 仍需用户确认的生产门禁

- 建立公司专用 CPA Key/账号和同厂冗余，消除当前个人 CPA 单账号依赖。
- 将公司 App 加为试点飞书文档协作者并授予分享权限读取，完成真实文档索引和撤权复测。
- 指定真实试点部门、唯一 DRI 和一条真实 P2。
- 扩到 10 名真实员工，完成并发会话、群内多人 @ 隔离、失败重投和回复送达验收。
- 使用真实文档再做一次有权员工/无权员工正负测试；合成证据的跨员工越权负测已通过。
- 24 小时容量数据完成前，不从 10 人 Canary 放大到 50 人正式首批。
- ERP 和社媒继续只读；爱视可 ERP M4 和 MediaCrawler 风控恢复仍不在本轮范围。

## 最终完成审计

最终运行标识：`qnap-p0-f-completion-20260807`。

- Agent Core 当前定向测试 14/14、Knowledge Connector 8/8、H Worker 2/2、Action Gateway 1/1、H-Lite 目录/客户端/服务/Profile 定向测试 11/11 全部通过；本轮 JavaScript 语法检查通过。
- QNAP 完整自检已补入 Action Gateway 健康、十人任务/成果/ACK、五类任务事件、Action Intent 终态、数据库权限边界和 H 引擎外网路径硬门禁。
- 最终 Canary：5/10/20 并发全部成功且全部标记演示模式，P95 分别为 264ms、358ms、326ms。
- 十名普通员工 restricted 结果均为 0，DRI 为 1，未知用户为 0；员工个人数据接口继续明确不保存私人对话全文。
- 两个 P0-E Action Intent 均为 `rolled_back`，执行读回和回滚读回均为 `true`，不存在非终态 Action Intent。
- Agent Core 与 H-Lite 重启后仍读回 10 个 accepted tasks、10 个 artifacts 和两类 H-Lite durable event。
- H 引擎已从“仅出口可达”升级为真实远程推理成功；当前临时凭据模式明确可见，不冒充正式独立凭据完成。
- 最新离机加密包 SHA-256：`c18a5f5e8ac073c4262c4b462dc4a07a44911170764c35f2f13014c23393d35f`；Mac Mini 解密、校验和逻辑恢复再次通过。
