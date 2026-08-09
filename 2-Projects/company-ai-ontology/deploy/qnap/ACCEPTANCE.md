# 公司 AI Ontology P0 A-F 验收报告

验收时间：2026-08-08（Asia/Shanghai）

## 结论

P0-A 至 P0-F、独立公司 Bot、通讯录、公司 H 引擎、Knowledge Connector `2026-08-08.3`、V3 P0-S、Goal 4 P0-EPI 和 Goal 5 P0-DEC 均已部署。Agent Core 已切到真实远程 H Runtime 并返回 `productionReady=true`；Ontology Registry 已与 Git 定义保持 `in_sync`。一名真实 DRI 的受控 P2 已形成 Decision→Task→Action→Verification→Learning 完整 Lineage，三层结果均为 `true`。产品研究部整库导入仍未批准，`department/openchat` 主体映射和受控 `chat/group` 会话授权语义完成前继续禁止批量同步；10 名真实员工 Canary 继续延后。

## P0-S：V3 Foundation Pack

- Contracts Package 已固化 13 个命名空间、41 个 Object Types、17 个 Link Types、3 个 Functions、2 个 Action Types、3 个 Policies、5 个 Constraints；稳定内容哈希为 `0e1690bbced6b4b4f676b2bdf32434814123687b1df754a457453ad85ff34730`。
- Ontology Registry `2026-08-08.1` 已按 Git 提交 `72055c38c` 部署，生产 active 版本唯一，Schema `3.0.0`、元素 71 个，`/readyz` 为 `in_sync`。
- Registry 只部署镜像内 Git Definition；远程候选只能 dry-run 编译。部署必须提供 Proposal、批准人和 Git commit；migration-required 还必须显式批准迁移并提交 migration plan。
- PostgreSQL 17 已建立 `ontology_registry`、`ontology_runtime`、`epistemic`、`decision`、`security`、`work`、`action` 逻辑 Schema，并在既有事实表上补双时间、来源、安全域、Ontology 版本和 Provenance 字段，没有建立并行事实真源。
- 隔离 PG17 验收通过：迁移重复执行、7 个稳定语义 View、RLS、最小权限、历史版本再激活、双审计、Registry Docker build 和本地文件依赖均通过。
- 生产权限负测通过：Registry 无 DELETE、无 Domain Event UPDATE、无 `ontology.entities` 直接读取权；未设置 Tenant 时查询版本为 0，设置当前 Tenant 后为 1。
- 生产恢复性验收通过：重启 Registry 后 `in_sync`，`restart_count=0`；重复部署同一版本返回 `already_active`，版本/元素/Domain Event/传统 Audit 数量保持 `1/71/1/1`。
- 变更前新鲜 `pg_basebackup` 已通过 `pg_verifybackup`；配置快照位于 QNAP 生产备份目录，可独立回滚 Compose、Caddy、迁移、脚本和 `.env`。
- H 控制面已升级到 `v1.49.1`：公网管理员看板显示 7/7 运行组件就绪和 Registry 独立绿色节点；真实 Chrome 登录后控制台错误、页面异常、失败请求、HTTP 4xx/5xx 和桌面/390px 横向溢出均为 0。

## P0-PROD-2：H 引擎 Runtime

- Agent Core 已集成 H 引擎 Adapter，架构和 API 只暴露统一的 H 引擎能力，不暴露底层模型品牌。
- dev198 公司 H Worker 使用 HMAC、最大并发 2、单轮执行、禁用 Web Search/Memory/Subagent，并通过 0600 临时文件传递 Prompt。
- QNAP Agent Core `2026-08-08.4` `/readyz` 返回 `ready`、`productionReady=true`、`mode=remote`、`credentialMode=cpa-api-key`、`engineProvider=cpa-openai-compatible`、`model=grok-4.5`。
- 真实 H 推理已返回预期校验结果；Worker 与 Agent Core 均 `restart_count=0`。
- Worker 使用独立 HOME/Grok HOME；CPA Key 仅位于 dev198 的 0600 环境文件，QNAP 不持有模型凭据。
- CLI 超时、输出上限、崩溃错误和凭据门禁具备明确状态码。
- Grok Build 自定义模型使用独立别名 `cpa-grok-4-5` 映射上游 `grok-4.5`，避免与内置模型同名后误走 xAI 官方鉴权。

## P0-PROD-3：公司知识 Connector

- Knowledge Connector `2026-08-08.3` 已在公司 QNAP 健康运行，`restart_count=0`。
- PostgreSQL 已具备 `knowledge.resources`、`knowledge.acl_entries`、`knowledge.chunks`、`knowledge.sync_runs`，独立登录角色、RLS 和最小授权均存在。
- 支持公开团队知识空间自动发现、显式私有资源、Docx/Sheet/Minutes、文档 ACL、空间成员、人员和部门映射。
- Compose 显式资源改用 Base64 JSON，已修复 JSON 环境变量被转义导致的容器重启问题。
- 2026-08-08 产品研究部知识库只读 ACL 审计覆盖 1,222 个节点，未触发导入；`knowledge.chunks=0`、`knowledge.acl_entries=0`。
- P0-1 已修复：文档 ACL 或空间 ACL 读取失败时，在正文读取前无条件写入 `skipped/unknown`，不生成 ACL、Chunk 或索引。
- P0-2 已修复：只有文档直接 ACL 明确包含对应 `wikispaceid` 时才展开空间成员；没有该标识时仅保留文档直接 ACL。
- Connector 14/14、Agent Core 14/14 回归通过；生产 Canary 覆盖直接人员授权、明确空间继承、无空间继承、ACL 接口失败和正文可读但 ACL 失败。
- 有权员工 Evidence 为 1；无权员工、撤权员工、跨部门员工、原始 Token 和直接链接猜测均为 0。真实员工撤权后的观测收敛时间为 `37,757ms`，该实测值不作为永久 SLA。
- 旧镜像 `2026-08-08.2` 回滚和新镜像 `2026-08-08.3` 恢复均健康、未自动同步；备份清单校验通过。
- 临时飞书文档、员工协作者、4 条 Canary Resource、本机及 QNAP 临时 Token/员工 ID 文件均已清理。最终知识表为 Resource 1、ACL Entry 0、Chunk 0；原单资源继续因 `1063004` fail-closed。
- 当前公开空间自动发现和启动同步均关闭，周期保持 900000ms；产品研究部整库导入仍未批准。详细证据见 `docs/knowledge-acl-canary-2026-08-08.md`。

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
- 补齐空间成员 `department/openchat` 主体映射，并定义 Retrieval 对 `chat/group` 授权主体的当前会话证据、用途边界和撤权语义。
- 上述 P1 完成后，由用户单独批准产品研究部整库导入的资源范围、时间窗口和回滚窗口。
- 指定真实试点部门、唯一 DRI 和一条真实 P2。
- 扩到 10 名真实员工，完成并发会话、群内多人 @ 隔离、失败重投和回复送达验收。
- 24 小时容量数据完成前，不从 10 人 Canary 放大到 50 人正式首批。
- ERP 和社媒继续只读；爱视可 ERP M4 和 MediaCrawler 风控恢复仍不在本轮范围。

## 最终完成审计

最终运行标识：`qnap-p0-s-foundation-20260808`。

- Contracts 6/6、Registry 6/6、控制面 Ontology 聚合 4/4、控制面页面/部署边界 54/54 通过；Agent Core 14/14、Knowledge Connector 14/14、H Worker 2/2、Action Gateway 1/1、H-Lite 目录/客户端/服务/Profile 11/11 的验收有效。
- QNAP 完整生产自检再次通过：全部关键容器健康，Registry/Knowledge Connector 纳入硬门禁，H-Lite 飞书 WebSocket 在线，Agent Core `productionReady=true`，关键容器 `restart_count=0`。
- QNAP 完整自检已补入 Action Gateway 健康、十人任务/成果/ACK、五类任务事件、Action Intent 终态、数据库权限边界和 H 引擎外网路径硬门禁。
- Knowledge Connector 真实 ACL Canary、员工撤权、跨部门、原始 Token、链接直猜和文档删除负测通过；测试数据清理后 Resource/ACL/Chunk 为 `1/0/0`，最近 30 分钟严重错误为 0。
- Knowledge Connector 实际回滚 `2026-08-08.2 → 2026-08-08.3` 通过，两次均健康且未自动同步；脱敏运行摘要 SHA-256 为 `de75ae82571d44c7b5a8b66424d21c2e73bb84ace376614ea9f6d8fee8335ba1`。
- 最终 Canary：5/10/20 并发全部成功且全部标记演示模式，P95 分别为 264ms、358ms、326ms。
- 十名普通员工 restricted 结果均为 0，DRI 为 1，未知用户为 0；员工个人数据接口继续明确不保存私人对话全文。
- 两个 P0-E Action Intent 均为 `rolled_back`，执行读回和回滚读回均为 `true`，不存在非终态 Action Intent。
- Agent Core 与 H-Lite 重启后仍读回 10 个 accepted tasks、10 个 artifacts 和两类 H-Lite durable event。
- H 引擎已从“仅出口可达”升级为真实远程推理成功；当前临时凭据模式明确可见，不冒充正式独立凭据完成。
- 最新离机加密包 SHA-256：`c18a5f5e8ac073c4262c4b462dc4a07a44911170764c35f2f13014c23393d35f`；Mac Mini 解密、校验和逻辑恢复再次通过。

## Goal 4：P0-EPI 与 Company Brain Work Protocol v1.0

- 公司 QNAP 已切换到 Schema `3.1.0`、Agent Core `2026-08-09.1`、Work Protocol `1.0.0 / active`，Ontology Registry 唯一 active 版本共 90 个元素。
- 本轮只激活 Intake、Scope、Authority、Context、Evidence、Synthesis、Response；Decision、Plan、Execution、Verification、Learning 仅有兼容契约并保持灰色。
- fresh、冲突、过期、Principal 无 ACL、Principal 不存在五类生产 fixture 通过；Evidence 0 在策略层失败关闭且不调用 H 引擎，无权限响应未泄露 fixture 标题、URL、人员或正文。
- Migration 007、Tenant RLS、稳定 View、最小权限、Permissioned Evidence Package v2、Response Validator、WorkCase 状态机、重启回放和真实回滚恢复均通过。
- H 控制面 `v1.52.0` 已显示 WorkCase、Evidence Map、Answer Basis 和未激活灰色阶段；真实公网浏览器 8/8 组件就绪、控制台错误 0、无横向溢出。
- 完整验收证据见 `docs/company-brain-work-protocol-acceptance-2026-08-09.md`。本轮未导入产品研究部整库、未启用真实 ERP/社媒写回、未执行 10 名真实员工 Canary。

## Goal 5：P0-DEC 与 Decision Practice Protocol v1.1

- 公司 QNAP 已切换到 Schema `3.2.0`、Agent Core / Action Gateway `2026-08-09.2`、Work / Practice Protocol `1.1.0 / active`，Ontology Registry 唯一 active 版本共 111 个元素。
- 一名真实 DRI 的受控 P2 已形成 Decision、Task、Action、Verification、Learning 完整 Lineage；计数为 `1/1/1/1`，技术执行、业务结果、经营目标三层结果均为 `true`。
- Learning 只处于 `proposed`，没有自动修改 Ontology、Prompt、流程或外部业务系统。
- 失败演练 `a–d` 保留审计：4 个 WorkCase 为 `blocked`，2 条已形成 Decision 的 Lineage 为 `retired`，失败尝试待执行状态为 0。
- Agent Core `34/34`、Action Gateway `2/2`、完整 `verify.sh`、Schema `3.1.0` 回滚/`3.2.0` 恢复、重启回放和敏感日志扫描通过。
- Runtime 构建上下文已从临时 `goal5-hotfix-*` 切换到版本化 release `19793e100`；Registry Definition Source Commit 保持 `e6a98c6dc`，没有把运行时热修复伪装成 Definition 变更。
- H 控制面 `v1.53.0` 已显示 9/9 组件、P0-DEC 绿色、Practice active、Goal Verified 1；真实浏览器控制台错误、页面错误、失败请求和横向溢出均为 0。
- 完整验收证据见 `docs/decision-practice-loop-acceptance-2026-08-09.md`。本轮未执行 10 名真实员工 Canary、未导入产品研究部整库、未启用真实 ERP/社媒写回。

## Goal 6：P1-DOMAIN 与 Company Brain Operating Model v1

- 公司 QNAP 五元组已重新在线核对；13 个容器健康，唯一宿主机发布端口仍为公司 LAN 健康入口。
- Schema 已升级为 `3.3.0`，Registry `in_sync`，内容哈希 `41689393289d9514d1ed9cd22455a164f1bc59286f0db16deb9235e703e6ae77`，Definition Source Commit 为 `86108cc700df4e1f1d6802765cadb47e0bb65bcb`。
- Company Brain Operating Model v1 已覆盖 Goal Owner、P2 Owner、DRI、Domain Owner、Data Steward、Evidence Owner、Decision/Action/Verification/Ontology Change Approver、Company Agent 和 Employee Agent，并固化读取、提案、批准、执行、验证和人工介入边界。
- Product、Device、Operations、Market 最小领域对象和跨域关系已进入受治理 Definition，没有建立第二套事实真源。
- Domain Connector `2026-08-09.3` 已只读接入 ERP M3 和社媒归一化结果；ERP Operations 38 条、Device 57 条、Market 369 条，敏感字段命中 0。
- ERP 和 Market Replay 均保持幂等；Live Cursor 不被失败或历史 Replay 覆盖。Active、Deleted、Expired、Revoked、Dead Letter、模拟上游失败和恢复同步负测通过。
- 未设置 Tenant 的应用角色读取 0，设置当前 Tenant 后可读取受治理 View；Action Gateway 读取领域表被拒绝。
- 跨域只读演示链形成 11 节点/9 关系，Decision/Task 仅为提案，Verification 为 pending、Learning 为 proposed，ActionIntent 和 Delivery Outbox 均为 0。
- 完整 `verify.sh` 于 2026-08-09 再次只读通过，没有新增公网端口、员工投递、ERP/社媒写回、ERP M4 或 MediaCrawler 操作。
- H 控制面生产当前保持 `v1.53.0`。`v1.54.0` 白盒和 3D-ready DTO 已完成代码与测试，但重新部署、管理员密码切换、真实浏览器验收和 Domain Connector 回滚恢复演练仍需当前明确生产授权。
- 完整当前状态见 `docs/goal6-operating-domain-acceptance-2026-08-09.md`。
