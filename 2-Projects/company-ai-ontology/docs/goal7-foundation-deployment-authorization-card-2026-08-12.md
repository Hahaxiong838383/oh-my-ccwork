# Goal 7 Foundation 独立授权卡

日期：2026-08-12（Asia/Shanghai）

状态：`READY_FOR_SEPARATE_OWNER_AUTHORIZATION / NOT_AUTHORIZED`

> `2026-08-12 23:53 CST` 最终 Manifest `1.4.0` Artifact 已生成并独立验签。旧 Artifact `9145915628` 与中间候选 `9148389214` 均禁止部署；以下授权只适用于 Artifact `9148675772`，五项授权互不继承。

## 1. 本次固定发布身份

- 公司 QNAP：`PRNas / TS-X65 / 192.168.61.18`；
- Foundation Root：`/share/CACHEDEV1_DATA/ai-ontology/foundation`；
- Runtime Workflow：`31614522984` Attempt `1`；
- Runtime Artifact：`9148675772`；
- Runtime Manifest：`1.4.0`；
- Ontology Commit：`76b5ce688b1e3cad1eb88e961bd0545c952cf5ce`；
- H-Lite Commit：`fab8be3f1467289400d0d63ffe378b63ad1a6957`；
- Agent Core：`2026-08-12.3`；
- Knowledge Connector：`2026-08-11.1`；
- H-Lite：`2026-08-12.1`；
- Collector Image：`sha256:bee3063294f22900cba5fd55e90b191f215972062cad2ad484c8cc084e773916`；
- Candidate Ontology：Schema `3.7.0` / Hash `c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860`；
- 发布开关：`publish=false`；
- 当前生产 active Schema：`3.3.0`，本次不得切换 active Schema。

- 012 模式：`pre_existing_reconciliation_only`；
- SQL replay：`false`。

任一发布身份变化，本授权卡自动失效，必须重新生成。

## 2. 当前只读基线

`2026-08-12 22:48 CST` 公网只读复核：

- Foundation `13/13 running`；
- unhealthy `0`；
- restart total `0`；
- 唯一宿主绑定 `192.168.61.18:19080`；
- Registry `in_sync`；
- `strategic_intelligence` Schema、表、容器、网络、发布端口均为 `0`；Goal 7 四张 Authority/Runtime 表已存在；
- 正式 P2、员工投递、ERP 写回、社媒写回、因果激活均为 `0`；
- 新 Artifact 尚未上传公司 QNAP。

## 3. 影响与时间

- 总维护窗口预计：`8～20 分钟`；
- 员工可感知间歇中断累计：`15～120 秒`；
- 飞书长连接会短暂重连，新消息由恢复型 H-Lite 先持久化；
- 公司 Bot 推理与知识检索会短暂暂停；
- 自动失败恢复预计：`2～6 分钟`；
- 不重启 Postgres、Redis、Qdrant、Ontology Registry、Action Gateway、Domain Connector、Gateway；
- 不运行 Collector，不启动七日 Shadow，不产生正式 P2、员工投递或业务写回。

## 4. 五项独立授权

以下五项互不继承。只授权其中一项，不代表授权其他项。

### A. Foundation 发布准备与 Artifact 入场

动作：把 Artifact `9148675772` 上传到公司 QNAP 受控 staging 目录，验证完整 Hash，备份现有 Compose、环境配置和三个旧镜像，构建三个候选镜像；不执行 SQL、不切换服务、不运行模型。

精确授权回复：

> 授权 Artifact 9148675772 进入公司 QNAP Goal 7 发布 staging，允许执行 Hash 校验、配置与旧镜像备份、三个候选镜像构建；不授权数据库 SQL、服务重建、Worker 读回、Collector、Shadow 或真实回滚演练。

### B. 既有迁移 012 只读证据对账

动作：验证历史 Source Archive、SQL Hash、现有四表、4/4 强制 RLS、Tenant Policy、真实 `ontology_app` 权限、无 DELETE 和无敏感正文列，生成新的对账 Evidence；必须输出 `database_sql_executed=0`，不得再次执行 `012-goal7-authority-runtime.sql`。

精确授权回复：

> 授权在公司 QNAP 对既有 Goal 7 迁移 012 执行只读证据对账，允许写入脱敏 reconciliation Evidence，必须证明 database_sql_executed=0；不授权数据库 SQL、服务重建、Worker 读回、Collector、Shadow 或数据库逆向回滚。

### C. 三组件服务重建

动作：按恢复型 H-Lite → Agent Core → Knowledge Connector → H-Lite 恢复接单的顺序，重建 `h-lite`、`agent-core`、`knowledge-connector`；使用 drain/resume、健康检查和自动失败恢复，不重启其他 Foundation 服务。

精确授权回复：

> 授权部署 Artifact 9148675772 对应的 Agent Core 2026-08-12.3、Knowledge Connector 2026-08-11.1、H-Lite 2026-08-12.1，仅重建这三个服务；允许发布失败时自动恢复旧服务，不授权真实回滚演练、Worker 读回、Collector 或 Shadow。

### D. 真实 H Worker 双源读回与 Authority Canary

动作：发布健康后执行一次固定合成请求，读取同一 request 的 Worker 响应和 usage ledger，验证 provider/model/token usage；执行私聊、群聊、多人艾特、Purpose、撤权和正文前 ACL Canary。不得读取或输出真实员工正文。

精确授权回复：

> 授权执行一次 Goal 7 真实 H Worker 双源读回和合成 Authority Canary，仅使用固定测试请求，不读取真实员工正文，不运行 Collector，不创建 P2，不投递员工任务，不写回业务系统。

### E. 真实回滚恢复演练

动作：在三组件发布及验收后，把三个服务恢复到发布前旧镜像并验证，再恢复到新版本；012 additive migration 保留，不执行 DROP。该动作会产生第二次短暂中断。

精确授权回复：

> 授权执行 Goal 7 三组件真实回滚恢复演练：旧版本验证后恢复到 Artifact 9148675772 新版本；保留既有迁移 012，不执行数据库 DROP，不运行 Collector 或 Shadow。

## 5. 自动停止条件

出现任一情况立即停止后续动作并进入安全恢复：

- 发布身份、Hash 或双仓 Commit 不一致；
- active Schema 发生变化或 Registry 不再 `in_sync`；
- 任一非目标 Foundation 服务被重启；
- 新增宿主端口；
- drain 超时、待送达回复无法归零；
- 三个目标服务健康检查超时；
- 出现正式 P2、员工投递、ERP/社媒写回或因果激活；
- Worker 无法真实读回 provider/model/usage；
- 权限撤销或正文前 ACL 未失败关闭。

## 6. 当前建议

建议当前只先授权 `A`。完成 Artifact 入场、Hash 校验、备份和候选镜像构建并固化 Evidence 后，再单独申请 `B`；`C`、`D`、`E` 继续按前序证据逐项拍板。正式七日 `PUBLISH=false` Shadow 不属于本授权卡，仍需来源/P003/四角色 UAT、Goal 7 Owner Acceptance 和新的独立授权。
