# 公司 AI Ontology P0-F Canary 报告

验收时间：2026-08-07（Asia/Shanghai）
运行标识：`qnap-p0-f-20260807`

## 结论

十人演示 Canary 通过。5/10/20 并发、权限负测、员工数据可见性、Outbox 重投、Agent Core/H-Lite 重启恢复、Postgres/SQLite 持久化和离机加密备份均取得真实读回证据。

## 并发结果

| 并发 | 成功 | HTTP | P50 | P95 | 最大 |
|---:|---:|---|---:|---:|---:|
| 5 | 5 | 200 | 319ms | 369ms | 369ms |
| 10 | 10 | 200 | 474ms | 543ms | 543ms |
| 20 | 20 | 200 | 244ms | 338ms | 355ms |

Agent Core 默认准入参数：并发 4、等待队列 32、排队超时 5 秒。所有回答均明确为 H 引擎演示模式。

## 安全与权限

- 十名普通员工读取 restricted 数据：全部 0 条。
- DRI 读取 restricted 数据：1 条。
- 未知用户：0 条。
- Agent Core 更新 Intent：数据库拒绝。
- Agent Core 更新演示业务目标：数据库拒绝。
- Action Gateway 更新 Workflow Task：数据库拒绝。

## 任务与动作恢复

- 任务：10 个 accepted。
- 成果：10 个 artifacts。
- Outbox 重投：最终 acked，attempt count 为 2。
- Action Gateway：执行读回通过，回滚读回通过，最终状态 rolled_back。
- 容器重启后：Agent Core `demo_ready`，10 个任务和两类 H-Lite P0 durable event 可读。

## 员工数据可见性

演示员工 01 可读取自己的身份、1 个 accepted 任务和 1 个成果；接口明确返回：

- `privateConversationStoredInOntology=false`
- `managerCanReadPrivateConversation=false`

## 资源

| 容器 | 内存 |
|---|---:|
| Agent Core | 14.61MiB / 512MiB |
| Action Gateway | 15.89MiB / 256MiB |
| H-Lite | 11.61MiB / 256MiB |
| Postgres | 34.84MiB / 1.5GiB |

## 离机备份

- QNAP 生成 PostgreSQL 逻辑转储并使用 AES-256 加密。
- 数据密钥使用 Mac Mini 3072-bit RSA 公钥加密，私钥不进入 QNAP。
- 加密包已传输至 Mac Mini 独立目录并完成解密、SHA-256、gzip 和关键 Schema 校验。
- 包 SHA-256：`8d9f3b336b486154707c1c30d25a2c44cb0c4ca6b5d670a8d3db1bda6a183464`。
- 转储 SHA-256：`e2a8aed528410b4768024ea0209088560f35ff317b875d261dcee2b8c8e43cdb`。

## 放量边界

本报告只批准演示数据 10 人 Canary。公司飞书 App、H 引擎企业凭据、真实 P2/DRI 和 24 小时容量数据完成前，不进入 50 人正式首批。

## 最终完成复跑

运行标识：`qnap-p0-f-completion-20260807`

| 并发 | 成功 | 演示标记 | HTTP | P50 | P95 | 最大 |
|---:|---:|---:|---|---:|---:|---:|
| 5 | 5 | 5 | 200 | 213ms | 264ms | 264ms |
| 10 | 10 | 10 | 200 | 229ms | 358ms | 358ms |
| 20 | 20 | 20 | 200 | 225ms | 326ms | 350ms |

- 权限负测、DRI 正向读取、未知用户、员工个人数据章程接口全部再次通过。
- Outbox 新增演示重投再次从 pending/attempt 1 恢复为 acked/attempt 2。
- Agent Core 与 H-Lite 真实重启后，10 个 accepted tasks、10 个 artifacts、`p0_demo_cycle_completed` 和 `p0_action_cycle_completed` 均可读。
- 两个 Action Intent 均为 `rolled_back`，执行读回、回滚读回和数据库不可绕过边界再次通过。
- QNAP 经 Mac Mini Xray 访问 H 引擎上游服务返回 HTTP 401，外网路径通过。
- 最新 Mac Mini 离机加密备份校验和逻辑恢复通过，包 SHA-256 为 `c18a5f5e8ac073c4262c4b462dc4a07a44911170764c35f2f13014c23393d35f`。
