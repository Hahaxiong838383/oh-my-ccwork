# Goal 7 Foundation 独立授权卡

日期：2026-08-13（Asia/Shanghai，沿用文件名以保持既有链接）

状态：`READY_FOR_STAGE_A_OWNER_AUTHORIZATION / NOT_AUTHORIZED`

> Workflow `31654762489` Attempt `1` / Artifact `9163957919` 已通过 Manifest `1.6.0`、9 项 `SHA256SUMS`、严格根目录白名单、`image.env` 交叉绑定、Release Validator 与 Goal 7 Runtime Validator。A 阶段准备链同时通过全局锁、危险 `runId` 拒绝、回放证据保护、精确镜像清理、三个基础镜像 digest 固定、Preparation 零 SQL，以及完整新准备成功和成功回放后锁目录均消失的可执行回归。当前仅新的 A 阶段可申请但尚未授权；B～E 必须在前序 Evidence 完成后分别授权，任何授权不得继承。

## 1. 固定发布身份

- 公司 QNAP：`PRNas / TS-X65 / 192.168.61.18`；
- Foundation Root：`/share/CACHEDEV1_DATA/ai-ontology/foundation`；
- Runtime Workflow：`31654762489` Attempt `1`；
- Runtime Artifact：`9163957919`；
- Runtime Manifest：`1.6.0`；
- Ontology Commit：`8eaef798e3a9831f34bdb598c79dfd29aa735212`；
- H-Lite Commit：`baa00bf07089a3caf5fe6318aac28cb73bd5ae13`；
- Agent Core：`2026-08-12.3`；
- Knowledge Connector：`2026-08-11.1`；
- H-Lite：`2026-08-12.1`；
- Collector Image：`sha256:9a2606c1db7db2112d6527c34b59187ab6d24d597bbf886e78016a3c1aea36fc`；
- Candidate Ontology：Schema `3.7.0` / Hash `c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860`；
- 发布开关：`publish=false`；
- 当前生产 active Schema：`3.3.0`，本次不得切换 active Schema；
- 012 模式：`pre_existing_reconciliation_only`；
- SQL replay：`false`。

Artifact 保留至 `2026-11-11T00:32:31Z`；9 项 `SHA256SUMS` 及完整验证已通过。Workflow、Artifact、Commit、镜像或 Hash 任一项变化，本卡自动失效并必须重新复验。Artifact `9156356166` 及更早包已失效，禁止使用其旧授权语句。

## 2. 最新只读基线

`2026-08-13T00:40:01Z` 公网直连只读复核：

- Foundation `13/13 running`；
- unhealthy `0`；
- restart total `0`；
- `strategic_intelligence` 容器、网络均为 `0`；
- 新 Artifact `9163957919` 未上传公司 QNAP；
- 旧 Artifact `9156356166` 的 10 个 release 文件、Preparation/Baseline Evidence、备份和 3+3 个镜像标签仍保留审计，但全部 `reusable=false`；
- Artifact staging lock、Preparation lock 均为 `0`。

该基线不替代 A 阶段内对容量、Compose、服务、端口、镜像、业务副作用和完整 Hash 的再次核验。

## 3. 分阶段影响与时间

当前只申请 A 阶段，因此本次授权对应的影响是：

- A 阶段准备窗口预计：`8～20 分钟`；
- 预期员工可感知中断：`0 秒`；
- 不切换、不重建、不重启任何 Foundation 服务，现有 H-Lite、Agent Core 和 Knowledge Connector 继续运行；
- 不执行数据库 SQL，不运行模型、Worker、Collector 或七日 Shadow；
- 不产生正式 P2、员工投递、ERP/社媒写回或因果激活。

以下仅用于后续独立授权的影响告知，不属于本次 A 阶段授权：

- C 阶段三组件重建时，员工可感知间歇中断预计累计 `15～120 秒`；飞书长连接可能短暂重连，公司 Bot 推理与知识检索会短暂暂停；
- C 阶段自动失败恢复预计 `2～6 分钟`；
- E 阶段真实回滚恢复演练预计 `2～6 分钟`，并会产生第二次短暂中断；
- C、E 阶段均不重启 Postgres、Redis、Qdrant、Ontology Registry、Action Gateway、Domain Connector 或 Gateway。

## 4. 五项独立授权

以下五项互不继承。当前 A 可申请但尚未授权；B～E 继续关闭，必须等待各自前序 Evidence 后才可申请。

### A. Foundation 发布准备与 Artifact 入场

动作：把 Artifact `9163957919` 上传到公司 QNAP 隔离 `incoming/goal7-9163957919.uploading`，验证 9 项 Hash并同卷原子晋级，创建与该 Artifact 绑定的新备份、Preparation Evidence 和三个候选镜像；Preparation 基线采集明确不执行 SQL，不切换服务、不运行模型。旧 Artifact `9156356166` 的 A 阶段资产不得复用、覆盖或当作前序 Evidence。

> 授权 Artifact `9163957919` 进入公司 QNAP Goal 7 隔离 incoming staging，允许执行 9 项 Hash 校验、同卷原子晋级、新的配置与旧镜像备份、三个候选镜像构建，并生成绑定该 Artifact 的新 Preparation Evidence；旧 Artifact `9156356166` 的 A 阶段资产仅保留审计且不得复用；不授权数据库 SQL、服务重建、Worker 读回、Collector、Shadow 或真实回滚演练。

### B. 既有迁移 012 只读证据对账

动作：验证历史 Source Archive、SQL Hash、现有四表、4/4 强制 RLS、Tenant Policy、真实 `ontology_app` 权限、无 DELETE 和无敏感正文列，生成新的对账 Evidence；必须输出 `database_sql_executed=0`，不得再次执行 `012-goal7-authority-runtime.sql`。

> 当前锁定；A 阶段 Evidence 完成前不得授权。

### C. 三组件服务重建

动作：按恢复型 H-Lite → Agent Core → Knowledge Connector → H-Lite 恢复接单的顺序，重建 `h-lite`、`agent-core`、`knowledge-connector`；使用 drain/resume、健康检查和自动失败恢复，不重启其他 Foundation 服务。

> 当前锁定；A 阶段 Evidence 完成前不得授权。

### D. 真实 H Worker 双源读回与 Authority Canary

动作：发布健康后以同一项明确授权执行一次固定合成请求和 Authority Canary。所有写入前必须通过 `GOAL7_WORKER_READBACK_APPROVED=YES` 与公司 QNAP 五元组预检；读取同一 request 的 Worker 响应和 usage ledger，验证 provider/model/token usage，并验证私聊、群聊、多人艾特、Purpose、撤权和正文前 ACL。不得读取或输出真实员工正文。

精确授权回复：

> 当前锁定；B、C 阶段 Evidence 完成前不得授权。

### E. 真实回滚恢复演练

动作：在三组件发布及验收后，按“当前候选版本快照 → 切换发布前旧镜像并验证 → 再恢复到获批候选版本并验证”的顺序执行，生成 `rollback-drill-evidence.json`；012 additive migration 保留，不执行 DROP。该动作会产生第二次短暂中断。

> 当前锁定；D 阶段及候选版本验收完成前不得授权。

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

当前只申请 A，不申请 B～E。正式七日 `PUBLISH=false` Shadow 不属于本授权卡，仍需来源/P003/四角色 UAT、Goal 7 Owner Acceptance 和新的独立授权。
