# 公司 AI Ontology 技术架构开发进展

更新时间：2026-08-08（Asia/Shanghai）

- 绿色：已完成代码、测试或生产 shadow 验证。
- 灰色：未完成，或仍在上线门禁之后。
- 架构统一使用“H 引擎”描述 AI 执行层；底层模型实现和版本只属于部署细节。
- 现有 H 平台员工私人 Bot 完全保持不变；另行新建一个公司级飞书 App/Bot 作为 Ontology 全员入口。

```mermaid
flowchart TB
  PRIVATE["现有员工私人 Bot<br/>原 App / 事件订阅 / 私人记忆不变"]:::done
  H_EXISTING["现有 H 平台<br/>继续服务员工私人 Bot"]:::done
  FEISHU["公司级飞书 App/Bot<br/>全员统一公司入口 / 凭据已接入"]:::done
  H_PROFILE["company-qnap-lite Profile<br/>Active 仅打开飞书订阅"]:::done
  H_PROCESS["QNAP 公司 Bot H-Lite Active<br/>真实 WebSocket 长连接已在线"]:::done
  REAL_E2E["首名真实员工消息验收<br/>私聊 / 群聊 / 回复 / 审计 / 去重"]:::done
  DIRECTORY["飞书通讯录只读 Connector<br/>范围 / 部门 / 人员 / 最小字段同步"]:::done
  ADAPTER["H-Lite → Agent Core Adapter<br/>HMAC / Request ID / Scope / 幂等键"]:::done

  CORE["Company Agent Core<br/>/healthz /readyz /v1/turns"]:::done
  H_ENGINE["公司 H 引擎远程 Runtime<br/>真实推理 / HMAC / 限流 / 标准结果"]:::done
  H_CREDENTIAL["公司 H 引擎独立 CPA 凭据<br/>Grok Build → grok-4.5"]:::done
  CONTEXT["Context Compiler<br/>证据上下文与会话编排"]:::done
  RETRIEVAL["Permissioned Retrieval Gateway<br/>先鉴权后检索"]:::done
  KNOWLEDGE["飞书知识 Connector<br/>Docx / Sheet / Minutes / ACL / RLS"]:::done
  KNOWLEDGE_ACCESS["整库 ACL 安全门禁<br/>两个 P0 修复 / Canary / 撤权复测"]:::todo
  TASK["Task Proposal Compiler<br/>P2 → 个人任务草案 → DRI 批准"]:::done
  CONTRACTS["Ontology Contracts Package<br/>Definition / Event / Tool Contracts"]:::done
  REGISTRY["Ontology Compiler & Registry<br/>版本 / 兼容性 / Proposal / 激活"]:::done
  RECONCILE["Git ↔ Runtime Reconciliation<br/>Hash / Drift / 历史版本再激活"]:::done

  PG["Postgres 17 + pgvector<br/>Ontology / RLS / 幂等 / 审计"]:::done
  QDRANT["Qdrant<br/>可重建向量召回层"]:::done
  REDIS["Redis<br/>队列 / 缓存 / 限流基础"]:::done
  OBS["Prometheus + Node Exporter<br/>健康与资源监控"]:::done
  BACKUP["Base Backup + WAL + PITR<br/>真实恢复演练"]:::done

  ACTION["Mandatory Action Gateway<br/>Dry-run / 人审 / 执行 / 读回 / 回滚"]:::done
  ERP["爱视可 ERP 接管<br/>M3 只读证据 → 后续受控写回"]:::todo
  SOCIAL["社媒监控接管<br/>归一化 Signal / 不可信输入隔离"]:::todo
  CANARY["演示负载与恢复验收<br/>5/10/20 并发 / ACK / 重启恢复"]:::done
  OFFSITE["Mac Mini 离机加密备份<br/>解密与可恢复性校验"]:::done
  CAPACITY["24 小时容量数据<br/>Admission Control 参数"]:::todo

  PRIVATE --> H_EXISTING
  H_EXISTING -. "代码与契约复用，不迁移私人 Bot" .-> H_PROFILE
  FEISHU --> H_PROCESS
  FEISHU --> DIRECTORY --> PG
  H_PROCESS --> REAL_E2E
  H_PROFILE --> H_PROCESS
  H_PROCESS --> ADAPTER --> CORE
  CORE --> H_ENGINE
  H_ENGINE --> H_CREDENTIAL
  CORE --> CONTEXT --> RETRIEVAL
  FEISHU --> KNOWLEDGE --> RETRIEVAL
  KNOWLEDGE --> KNOWLEDGE_ACCESS
  CORE --> TASK
  CONTRACTS --> REGISTRY --> RECONCILE
  REGISTRY --> PG
  CORE -. "只读契约与版本" .-> REGISTRY
  CORE --> PG
  RETRIEVAL --> PG
  RETRIEVAL --> QDRANT
  CORE --> REDIS
  TASK --> PG
  TASK --> H_PROCESS
  CORE -. "Action Intent" .-> ACTION
  ACTION -. "受控写回" .-> ERP
  SOCIAL -. "只读 Signal" .-> RETRIEVAL
  ERP -. "只读履约证据" .-> RETRIEVAL
  PG --> BACKUP
  PG --> OBS
  QDRANT --> OBS
  REDIS --> OBS
  CORE --> OBS
  H_PROCESS --> CANARY
  BACKUP --> OFFSITE
  OBS --> CAPACITY

  classDef done fill:#16a34a,color:#ffffff,stroke:#166534,stroke-width:2px;
  classDef todo fill:#d1d5db,color:#374151,stroke:#9ca3af,stroke-width:2px;
```

## 本轮完成

1. H 平台新增 `company-qnap-lite` 同源 shadow profile，并已在 QNAP 健康运行。
2. 新增 H-Lite → Company Agent Core 内部签名 Adapter。
3. QNAP 部署 Company Agent Core 最小服务，不发布宿主机端口。
4. 接入现有 Postgres RLS、幂等键与 append-only 审计。
5. 完成 H-Lite → Agent Core → 远程 H Worker → Postgres/SQLite 的真实推理闭环。
6. 公司 H Worker 已切到独立 `cpa-api-key`，Grok Build 通过 CPA OpenAI 兼容入口真实调用 `grok-4.5`，不再复用员工私人 Bot OAuth。
7. 明确现有员工私人 Bot 不迁移、不切换事件订阅；公司 Bot 使用独立飞书 App。
8. 公司 App 凭据已通过非 Git 的 600 权限环境文件写入 QNAP，租户 Token 和 WebSocket 长连接验证通过。
9. H-Lite 已从 shadow 切到 active；Agent Core `2026-08-08.4` 返回 `ready`、`productionReady=true`、`mode=remote`，并透传 H Worker provider/model 元数据。
10. 首名真实员工链路已通过：SQLite 读回 `p2p:post`、`p2p:text`、`group:text`，3 次处理全部 `completed`，无 `feishu_turn_failed`，去重记录 3 条，H-Lite 健康且 `restart_count=0`。
11. 通讯录数据范围已生效并上线只读同步：4 个授权范围展开为 83 个可见部门，414 名可见人员进入 Ontology Principal；重复同步新增 0、更新 414，数据库敏感属性行数为 0。
12. 飞书知识 Connector `2026-08-08.2` 服务骨架已上线；Base64 配置、四张知识表、RLS、单个显式资源 ACL fail-closed 和同步审计通过。
13. 生产权限链路已通过合成证据正负测试：授权员工 Evidence 与 H 回复命中，无权限员工 Evidence 为 0，测试数据已删除。
14. 产品研究部知识库只读 ACL 审计完成，未触发导入；发现两个整库导入 P0，正式索引保持灰色并被硬阻断。
15. V3 P0-S Contracts Package 已完成 13 个命名空间、41 个 Object Types、17 个 Link Types、3 个 Functions、2 个 Action Types、3 个 Policies 和 5 个 Constraints。
16. 独立 Ontology Registry `2026-08-08.1` 已在 QNAP 上线；生产 active 版本唯一，Schema `3.0.0`、71 个元素、Hash `0e1690bbced6`，Git/运行时状态为 `in_sync`。
17. PostgreSQL 17 隔离验收覆盖迁移重复执行、7 个逻辑 Schema、7 个稳定 View、RLS、最小权限、双审计和历史版本再激活；生产重启与重复部署后版本/元素/审计数量保持不变。
18. 公网管理看板已升级到 H 控制面 `v1.49.1`，Ontology Registry 独立标绿；真实 Chrome 验收为 7/7 运行组件就绪、控制台错误 0、失败请求 0、桌面和 390px 横向溢出 0。

## P0 A-F 已完成

1. P0-A：H 引擎演示 Runtime、Mac Mini Xray、超时和并发准入完成。
2. P0-B：QNAP H-Lite shadow、SQLite 持久事件和 Agent Core Adapter 完成。
3. P0-C：权限检索、越权负测和员工个人数据可见接口完成。
4. P0-D：十人 P2、ACK、成果和 DRI 验收闭环完成。
5. P0-E：Mandatory Action Gateway、读回、回滚和不可绕过验证完成。
6. P0-F：5/10/20 并发、重投、容器恢复、PITR 和离机加密备份完成。

## 待用户确认的生产门禁

1. 为公司 H 引擎建立独立 CPA Key/账号与同厂冗余，替换当前个人 CPA 单账号依赖。
2. 修复知识 Connector 两个 P0：ACL 错误无条件跳过；仅在文档 ACL 明确含 `wikispaceid` 时继承空间权限。随后完成小范围 Canary 与撤权复测。
3. 扩到 10 名真实员工，完成并发会话、群内多人 @ 隔离、失败重投和回复送达验收。
4. 真实试点部门、DRI 和 P2；24 小时容量观测完成后再决定 20/50 人放量。

## 公网可视化看板

- ✅ 公网入口：`https://ai.kidshub.cn/admin/company-ontology`。
- ✅ 认证边界：复用 H 控制面管理员 Cookie；未认证访问跳转 `/admin`。
- ✅ 状态通道：Mini LaunchAgent → aliyun-hk `127.0.0.1:19180` → QNAP `192.168.61.18:19080`。
- ✅ 脱敏边界：QNAP 仅开放固定健康路径，H 控制面按字段白名单聚合，不返回凭据、内部路径、文档 URL、员工 ID 或原始错误正文。
- ✅ 真实浏览器验收：HTTP 200、标题正确、运行正常、运行组件 7/7、里程碑绿色 5 项/灰色 5 项、控制台错误 0、失败请求 0、桌面与 390px 横向溢出 0。
