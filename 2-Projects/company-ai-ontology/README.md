# Company AI Ontology

公司级 AI Ontology 基座实施项目。P0-A 至 P0-F 的演示实现、QNAP 部署和自检均已完成；现有 H 平台员工私人 Bot 保持不变，真实 ERP/社媒写回继续关闭。

## 当前状态

- 架构基线：V2.2，QNAP 承载 H-Lite、Company Agent Core、Ontology 控制面和数据面。
- 当前里程碑：`P0-PROD-1 Company Bot + Directory Connected`。公司飞书 App/Bot 已接入 QNAP H-Lite，真实消息链路和通讯录只读同步均已通过；Agent Core 仍为演示 Runtime。
- 本目录包含可复用的 QNAP 部署配置；生产密码只在 QNAP 本地生成并保存，不进入 Git。

## 部署边界

- 热数据：`/share/CACHEDEV1_DATA/ai-ontology`。
- WAL、基础备份和快照：`/share/CACHEDEV2_DATA/ai-ontology-backup`。
- 唯一对局域网开放的基础端口：`192.168.61.18:19080`，仅提供健康检查。
- Postgres、Qdrant、Redis、Prometheus 不发布宿主机端口。
- 平台容器总内存硬上限控制在约 3.6GB，为 H-Lite、Agent Core、Action Gateway、QTS 和既有容器预留资源。

## 目录

- `deploy/qnap/docker-compose.yml`：QNAP Foundation 栈。
- `deploy/qnap/initdb/`：Ontology 最小真源、RLS、审计、幂等和 Outbox 初始化。
- `deploy/qnap/config/`：Caddy、Prometheus 配置。
- `deploy/qnap/scripts/`：远端初始化、验证、备份与恢复演练脚本。
- `deploy/qnap/images.lock`：生产镜像内容摘要。
- `deploy/qnap/ACCEPTANCE.md`：本次生产验收证据和剩余门禁。
- `docs/lessons-learned-2026-08-08.md`：公司 Bot、通讯录同步、权限和 QNAP 部署的经验教训。
- `services/agent-core/`：Company Agent Core 内部 API、Postgres 幂等审计和 H 引擎独立 Runtime 门禁。

## 上线门禁

- 不迁移、不切换任何员工私人 Bot 的飞书 App 或事件订阅。
- 公司级飞书 App/Bot 已接入，H-Lite 当前为 `active` 且真实飞书长连接健康；已验收 `p2p:post`、`p2p:text`、`group:text` 三类真实消息，3 次处理全部完成、0 次失败，SQLite 去重记录为 3 条，容器 `restart_count=0`。
- 飞书通讯录数据范围已生效：4 个授权范围、83 个可见部门、414 名可见人员已只读同步到 Ontology Principal；重复同步结果为新增 0、更新 414，未写入邮箱、手机号或聊天内容。
- Agent Core 当前允许 `H_ENGINE_MODE=demo` 验证链路，但响应必须标记 `simulation=true`、`productionReady=false`；未配置企业凭据前不得宣称生产就绪。
- 本阶段不开放数据库端口到员工网段。
- 24 小时容量数据、真实公司 Bot 和真实 P2 未完成前，不进入 50 人正式首批。

## 下一阶段

1. 用户提供 H 引擎企业凭据，启用生产模式并完成真实推理验收。
2. 扩到 10 名真实员工，验证并发会话、群内多人 @ 隔离、失败重投和回复送达。
3. 用户指定试点部门、唯一 DRI 和一条真实 P2；运行 24 小时容量观测后再决定 20/50 人放量。
4. 接入飞书公司知识库只读 Connector，并把文档权限转换为 Permissioned Evidence Package。
