# Goal 7 Foundation 独立授权卡

日期：2026-08-12（Asia/Shanghai）

状态：`SUPERSEDED_WAIT_NEW_ARTIFACT / NOT_AUTHORIZED`

> Artifact `9148675772` / Manifest `1.4.0` 只保留历史工程证据。由于机器 Release Plan 已升级为五阶段授权、D 阶段新增写入前授权与公司 QNAP 五元组预检、E 阶段新增“候选版本 → 旧版本验证 → 候选版本恢复”的机器证据链，旧 Artifact 不包含完整 `1.5.0` 发布契约，禁止再申请 A 或部署。必须从本次已推送 Commit 生成、下载并完整验签新的 Manifest `1.5.0` Artifact 后，才能补齐本卡发布身份并申请授权。

## 1. 待绑定发布身份

- 公司 QNAP：`PRNas / TS-X65 / 192.168.61.18`；
- Foundation Root：`/share/CACHEDEV1_DATA/ai-ontology/foundation`；
- Runtime Workflow：`WAIT_NEW_RUNTIME_WORKFLOW`；
- Runtime Artifact：`WAIT_NEW_ARTIFACT`；
- Runtime Manifest：`1.5.0`；
- Ontology Commit：`WAIT_PUSHED_ONTOLOGY_COMMIT`；
- H-Lite Commit：`fab8be3f1467289400d0d63ffe378b63ad1a6957`；
- Agent Core：由新 Artifact 的 `runtime-component-versions.json` 读回；
- Knowledge Connector：由新 Artifact 的 `runtime-component-versions.json` 读回；
- H-Lite：由新 Artifact 的 `runtime-component-versions.json` 读回；
- Collector Image：由新 Artifact 的 Release Manifest 读回；
- Candidate Ontology：由新 Artifact 的 Release Manifest 读回；
- 发布开关：`publish=false`；
- 当前生产 active Schema：`3.3.0`，本次不得切换 active Schema；
- 012 模式：`pre_existing_reconciliation_only`；
- SQL replay：`false`。

只有在 Workflow、Artifact、双仓 Commit、组件版本、镜像和全部 SHA-256 均已填入且通过 Release Validator、Goal 7 Runtime Validator 后，本卡才可改为 `READY_FOR_SEPARATE_OWNER_AUTHORIZATION`。任一发布身份变化，本卡自动失效。

## 2. 历史只读基线

`2026-08-12 22:48 CST` 公网只读复核：

- Foundation `13/13 running`；
- unhealthy `0`；
- restart total `0`；
- 唯一宿主绑定 `192.168.61.18:19080`；
- Registry `in_sync`；
- `strategic_intelligence` Schema、表、容器、网络、发布端口均为 `0`；Goal 7 四张 Authority/Runtime 表已存在；
- 正式 P2、员工投递、ERP 写回、社媒写回、因果激活均为 `0`；
- Artifact `9148675772` 未上传公司 QNAP。

该基线是历史证据，不替代新 Artifact 入场前的在线五元组、容量、Compose、服务、端口、镜像和业务副作用复核。

## 3. 影响与时间

- 总维护窗口预计：`8～20 分钟`；
- 员工可感知间歇中断累计：`15～120 秒`；
- 飞书长连接会短暂重连，新消息由恢复型 H-Lite 先持久化；
- 公司 Bot 推理与知识检索会短暂暂停；
- 自动失败恢复预计：`2～6 分钟`；
- 不重启 Postgres、Redis、Qdrant、Ontology Registry、Action Gateway、Domain Connector、Gateway；
- 不运行 Collector，不启动七日 Shadow，不产生正式 P2、员工投递或业务写回。

## 4. 五项独立授权

以下五项互不继承。当前发布身份未补齐，以下文字仅是待签发模板，不可直接作为有效授权。

### A. Foundation 发布准备与 Artifact 入场

动作：把新 Artifact 上传到公司 QNAP 受控 staging 目录，验证完整 Hash，备份现有 Compose、环境配置和三个旧镜像，构建三个候选镜像；不执行 SQL、不切换服务、不运行模型。

待新 Artifact 验签后生成的精确授权回复：

> 授权 Artifact `<NEW_ARTIFACT_ID>` 进入公司 QNAP Goal 7 发布 staging，允许执行 Hash 校验、配置与旧镜像备份、三个候选镜像构建；不授权数据库 SQL、服务重建、Worker 读回、Collector、Shadow 或真实回滚演练。

### B. 既有迁移 012 只读证据对账

动作：验证历史 Source Archive、SQL Hash、现有四表、4/4 强制 RLS、Tenant Policy、真实 `ontology_app` 权限、无 DELETE 和无敏感正文列，生成新的对账 Evidence；必须输出 `database_sql_executed=0`，不得再次执行 `012-goal7-authority-runtime.sql`。

精确授权回复：

> 授权在公司 QNAP 对既有 Goal 7 迁移 012 执行只读证据对账，允许写入脱敏 reconciliation Evidence，必须证明 database_sql_executed=0；不授权数据库 SQL、服务重建、Worker 读回、Collector、Shadow 或数据库逆向回滚。

### C. 三组件服务重建

动作：按恢复型 H-Lite → Agent Core → Knowledge Connector → H-Lite 恢复接单的顺序，重建 `h-lite`、`agent-core`、`knowledge-connector`；使用 drain/resume、健康检查和自动失败恢复，不重启其他 Foundation 服务。

待新 Artifact 验签后生成的精确授权回复：

> 授权部署 Artifact `<NEW_ARTIFACT_ID>` 对应的 Agent Core、Knowledge Connector、H-Lite，仅重建这三个服务；允许发布失败时自动恢复旧服务，不授权真实回滚演练、Worker 读回、Collector 或 Shadow。

### D. 真实 H Worker 双源读回与 Authority Canary

动作：发布健康后以同一项明确授权执行一次固定合成请求和 Authority Canary。所有写入前必须通过 `GOAL7_WORKER_READBACK_APPROVED=YES` 与公司 QNAP 五元组预检；读取同一 request 的 Worker 响应和 usage ledger，验证 provider/model/token usage，并验证私聊、群聊、多人艾特、Purpose、撤权和正文前 ACL。不得读取或输出真实员工正文。

精确授权回复：

> 授权执行一次 Goal 7 真实 H Worker 双源读回和合成 Authority Canary，仅使用固定测试请求，不读取真实员工正文，不运行 Collector，不创建 P2，不投递员工任务，不写回业务系统。

### E. 真实回滚恢复演练

动作：在三组件发布及验收后，按“当前候选版本快照 → 切换发布前旧镜像并验证 → 再恢复到获批候选版本并验证”的顺序执行，生成 `rollback-drill-evidence.json`；012 additive migration 保留，不执行 DROP。该动作会产生第二次短暂中断。

待新 Artifact 验签后生成的精确授权回复：

> 授权执行 Goal 7 三组件真实回滚恢复演练：旧版本验证后恢复到 Artifact `<NEW_ARTIFACT_ID>` 候选版本；保留既有迁移 012，不执行数据库 DROP，不运行 Collector 或 Shadow。

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
- 权限撤销或正文前 ACL 未失败关闭；
- 旧版本未验证或候选版本未成功恢复；
- 回滚证据无法从六份原始文件重新编译。

## 6. 当前建议

当前不要授权 A。先提交并推送本次 Release Plan `1.5.0` 与回滚证据链，等待 Runtime Workflow 生成新 Artifact；下载后验证全部 Hash、Release Validator 和 Goal 7 Runtime Validator，再补齐本卡并只申请 `A`。A 留证后，B、C、D、E 继续逐项拍板。正式七日 `PUBLISH=false` Shadow 不属于本授权卡，仍需来源/P003/四角色 UAT、Goal 7 Owner Acceptance 和新的独立授权。
