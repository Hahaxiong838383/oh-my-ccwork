# Goal 7 Foundation 独立授权卡

日期：2026-08-12（Asia/Shanghai）

状态：`INVALIDATED_WAIT_NEW_ARTIFACT / NOT_AUTHORIZED`

> **本卡当前整体作废，不得引用其中 A～E 文案授权任何生产动作。** Artifact `9151468565` 的 `image.env` 未进入其 8 项 `SHA256SUMS`，不满足 Manifest `1.6.0` 的 9 项完整性契约。必须等待新 Artifact 生成、复验和重新签卡；A～E 仍互不继承。

## 1. 固定发布身份

- 公司 QNAP：`PRNas / TS-X65 / 192.168.61.18`；
- Foundation Root：`/share/CACHEDEV1_DATA/ai-ontology/foundation`；
- Runtime Workflow：`待生成`；
- Runtime Artifact：`待生成`；
- Runtime Manifest：`1.6.0`；
- Ontology Commit：`待新 Workflow 绑定`；
- H-Lite Commit：`fab8be3f1467289400d0d63ffe378b63ad1a6957`；
- Agent Core：`2026-08-12.3`；
- Knowledge Connector：`2026-08-11.1`；
- H-Lite：`2026-08-12.1`；
- Collector Image：`待新 Workflow 绑定`；
- Candidate Ontology：Schema `3.7.0` / Hash `c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860`；
- 发布开关：`publish=false`；
- 当前生产 active Schema：`3.3.0`，本次不得切换 active Schema；
- 012 模式：`pre_existing_reconciliation_only`；
- SQL replay：`false`。

新 Artifact 必须具备 9 项 `SHA256SUMS`、严格根目录白名单、`image.env` 交叉绑定、Release Validator 与 Goal 7 Runtime Validator。新 Workflow、Artifact、Commit、镜像或 Hash 任一项未写入本卡前，本卡保持失效。

## 2. 最新只读基线

`2026-08-12T17:25:03Z` 公网 Mini 跳板只读复核：

- Foundation `13/13 running`；
- unhealthy `0`；
- restart total `0`；
- LAN-only Foundation 健康端点返回 `ok`；
- `strategic_intelligence` 容器、网络均为 `0`；
- Artifact `9151468565` 未上传公司 QNAP。

该基线不替代 A 阶段内对容量、Compose、服务、端口、镜像、业务副作用和完整 Hash 的再次核验。

## 3. 影响与时间

- 总维护窗口预计：`8～20 分钟`；
- 员工可感知间歇中断累计：`15～120 秒`；
- 飞书长连接会短暂重连，新消息由恢复型 H-Lite 先持久化；
- 公司 Bot 推理与知识检索会短暂暂停；
- 自动失败恢复预计：`2～6 分钟`；
- 不重启 Postgres、Redis、Qdrant、Ontology Registry、Action Gateway、Domain Connector、Gateway；
- 不运行 Collector，不启动七日 Shadow，不产生正式 P2、员工投递或业务写回。

## 4. 五项独立授权

以下五项互不继承。当前仅保留流程模板，不是可使用的授权文案；新 Artifact 复验并重签前，全部继续关闭。

### A. Foundation 发布准备与 Artifact 入场

动作：把未来重签的新 Artifact 上传到公司 QNAP 隔离 `incoming/*.uploading` 目录，验证完整 Hash并原子晋级，备份现有 Compose、环境配置和三个旧镜像，构建三个候选镜像；不执行 SQL、不切换服务、不运行模型。

> 旧文案已作废；等待新 Artifact 复验后重新生成。

### B. 既有迁移 012 只读证据对账

动作：验证历史 Source Archive、SQL Hash、现有四表、4/4 强制 RLS、Tenant Policy、真实 `ontology_app` 权限、无 DELETE 和无敏感正文列，生成新的对账 Evidence；必须输出 `database_sql_executed=0`，不得再次执行 `012-goal7-authority-runtime.sql`。

精确授权回复：

> 授权在公司 QNAP 对既有 Goal 7 迁移 012 执行只读证据对账，允许写入脱敏 reconciliation Evidence，必须证明 database_sql_executed=0；不授权数据库 SQL、服务重建、Worker 读回、Collector、Shadow 或数据库逆向回滚。

### C. 三组件服务重建

动作：按恢复型 H-Lite → Agent Core → Knowledge Connector → H-Lite 恢复接单的顺序，重建 `h-lite`、`agent-core`、`knowledge-connector`；使用 drain/resume、健康检查和自动失败恢复，不重启其他 Foundation 服务。

> 旧文案已作废；等待新 Artifact 复验后重新生成。

### D. 真实 H Worker 双源读回与 Authority Canary

动作：发布健康后以同一项明确授权执行一次固定合成请求和 Authority Canary。所有写入前必须通过 `GOAL7_WORKER_READBACK_APPROVED=YES` 与公司 QNAP 五元组预检；读取同一 request 的 Worker 响应和 usage ledger，验证 provider/model/token usage，并验证私聊、群聊、多人艾特、Purpose、撤权和正文前 ACL。不得读取或输出真实员工正文。

精确授权回复：

> 旧文案已作废；等待新 Artifact 复验后重新生成。

### E. 真实回滚恢复演练

动作：在三组件发布及验收后，按“当前候选版本快照 → 切换发布前旧镜像并验证 → 再恢复到获批候选版本并验证”的顺序执行，生成 `rollback-drill-evidence.json`；012 additive migration 保留，不执行 DROP。该动作会产生第二次短暂中断。

> 旧文案已作废；等待新 Artifact 复验后重新生成。

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

当前不得申请 A～E。先生成并复验 Manifest `1.6.0`、9 项 Hash 的新 Artifact，再重签本卡；正式七日 `PUBLISH=false` Shadow 不属于本授权卡，仍需来源/P003/四角色 UAT、Goal 7 Owner Acceptance 和新的独立授权。
