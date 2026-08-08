# 公司 AI Ontology P0 A-F 验收报告

验收时间：2026-08-08（Asia/Shanghai）

## 结论

P0-A 至 P0-F 的代码、QNAP 部署和演示数据闭环均已完成并通过自检；独立公司飞书 App/Bot 的真实私聊与群聊链路也已通过。H 引擎企业凭据、真实 P2/DRI 尚未接入，响应继续明确标记 `simulation=true`、`productionReady=false`，不冒充生产上线。

## P0-A：H 引擎 Runtime

- Agent Core 已集成 H 引擎 Adapter，架构和 API 只暴露统一的 H 引擎能力，不暴露底层模型品牌。
- 演示 Runtime `/readyz` 返回 `demo_ready`、`productionReady=false`。
- CLI 超时、输出上限、崩溃错误和凭据门禁具备明确状态码。
- QNAP 外网路径复验：Mac Mini Xray `192.168.61.66:10808` 正常监听；QNAP 经 SOCKS 访问模型 API 返回 HTTP 401，证明网络路径可达且仅缺企业凭据。

## P0-B：公司 Bot H-Lite

- `company-qnap-lite` 已在 QNAP 健康运行，当前为 `active`、`subscriptionEnabled=true`，真实飞书 WebSocket 长连接在线。
- H-Lite、员工私人 H 平台和私人 Bot 的 App、订阅、会话、记忆完全独立。
- H-Lite SQLite 保存 append-only 运行事件，不保存公司任务真源。
- 独立公司飞书 App/Bot 已使用 QNAP 本地 600 权限环境文件接入；真实验收读回 `p2p:post`、`p2p:text`、`group:text` 三类消息。
- 真实处理结果：3 条 `feishu_turn_received`、3 条 `feishu_turn_completed`、0 条 `feishu_turn_failed`，去重记录 3 条；H-Lite 健康且 `restart_count=0`。
- Agent Core 状态为 `demo_ready`、`productionReady=false`，真实回复继续显示“演示模式”。

## P0-PROD-1.5：通讯录身份同步

- 飞书通讯录数据范围接口返回 `code=0`，当前授权范围为 4 个部门入口；展开后可见 83 个部门。
- 部门员工列表和员工 `open_id` 直读均返回 `code=0`，已具备主动定位员工的基础能力。
- 新增只读目录枚举器、HMAC 服务身份 `company-directory-sync` 和 Agent Core Principal Upsert；普通员工身份调用同步接口返回 403。
- 首次同步发现并写入 414 名可见人员；第二次同步新增 0、更新 414，证明 Upsert 幂等。
- PostgreSQL 读回 414 个 `source=feishu-directory` Principal、2 条同步审计；邮箱、手机号和私人文本属性命中 0 行。
- 部署后 Agent Core `2026-08-08.1`、H-Lite `2026-08-08.2` 均健康，飞书 WebSocket 保持连接，两个容器 `restart_count=0`。

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

- 提供 H 引擎企业凭据，将 `productionReady` 切换为 `true`。
- 指定真实试点部门、唯一 DRI 和一条真实 P2。
- 扩到 10 名真实员工，完成并发会话、群内多人 @ 隔离、失败重投和回复送达验收。
- 完成飞书公司知识 Connector 的文档 ACL 映射和跨员工越权负测。
- 24 小时容量数据完成前，不从 10 人 Canary 放大到 50 人正式首批。
- ERP 和社媒继续只读；爱视可 ERP M4 和 MediaCrawler 风控恢复仍不在本轮范围。

## 最终完成审计

最终运行标识：`qnap-p0-f-completion-20260807`。

- Agent Core 当前测试 11/11、Action Gateway 1/1、H-Lite 目录/客户端/服务/Profile 定向测试 11/11 全部通过；本轮 JavaScript 语法检查通过。
- QNAP 完整自检已补入 Action Gateway 健康、十人任务/成果/ACK、五类任务事件、Action Intent 终态、数据库权限边界和 H 引擎外网路径硬门禁。
- 最终 Canary：5/10/20 并发全部成功且全部标记演示模式，P95 分别为 264ms、358ms、326ms。
- 十名普通员工 restricted 结果均为 0，DRI 为 1，未知用户为 0；员工个人数据接口继续明确不保存私人对话全文。
- 两个 P0-E Action Intent 均为 `rolled_back`，执行读回和回滚读回均为 `true`，不存在非终态 Action Intent。
- Agent Core 与 H-Lite 重启后仍读回 10 个 accepted tasks、10 个 artifacts 和两类 H-Lite durable event。
- H 引擎外网配置继续通过 Mac Mini Xray `192.168.61.66:10808`；QNAP 无凭据探测返回 HTTP 401，证明出口链路可达且没有伪装生产凭据。
- 最新离机加密包 SHA-256：`c18a5f5e8ac073c4262c4b462dc4a07a44911170764c35f2f13014c23393d35f`；Mac Mini 解密、校验和逻辑恢复再次通过。
