# Goal 7 Foundation 独立授权卡

日期：2026-08-13（Asia/Shanghai，沿用文件名以保持既有链接）

状态：`STAGE_A_B_C_D_E_COMPLETED / OWNER_ACCEPTANCE_PENDING`

> Workflow `31663036837` Attempt `1` / Artifact `9166921089` 已通过 Manifest `1.6.0`、9 项 `SHA256SUMS` 和 A～E 全链工程验收。D 阶段真实模型读回为 `cpa-openai-compatible / grok-4.5 / route-a`，usage ledger 一致；Authority Canary `7/7`，撤权收敛 `0.015 秒`，无越权正文、无真实员工正文。E 阶段在 `34.709 秒` 内完成候选→旧版→候选真实回滚恢复，012 保留。Foundation `13/13 running / unhealthy=0 / restart=0`，业务副作用为 `0`。当前只剩川哥独立 Owner Acceptance。

## 1. 固定发布身份

- 公司 QNAP：`PRNas / TS-X65 / 192.168.61.18`；
- Foundation Root：`/share/CACHEDEV1_DATA/ai-ontology/foundation`；
- Runtime Workflow：`31663036837` Attempt `1`；
- Runtime Artifact：`9166921089`；
- Runtime Manifest：`1.6.0`；
- Ontology Commit：`4a158d1d17141da905e9206dd54013cdac987039`；
- H-Lite Commit：`baa00bf07089a3caf5fe6318aac28cb73bd5ae13`；
- Agent Core：`2026-08-12.3`；
- Knowledge Connector：`2026-08-11.1`；
- H-Lite：`2026-08-12.1`；
- Collector Image：`sha256:469d518c803baf41fa054fea39dec165726435bd4c84d0de6e8b0de8408b2940`；
- Candidate Ontology：Schema `3.7.0` / Hash `c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860`；
- 发布开关：`publish=false`；
- 当前生产 active Schema：`3.3.0`，本次不得切换 active Schema；
- 012 模式：`pre_existing_reconciliation_only`；
- SQL replay：`false`。

Artifact 保留至 `2026-11-11T03:09:14Z`；9 项 `SHA256SUMS` 及完整验证已通过。Workflow、Artifact、Commit、镜像或 Hash 任一项变化，本卡自动失效并必须重新复验。Artifact `9166253151` 的 A～D 历史 Evidence 仍有效，但首次 E 失败后其候选已自动恢复，且回滚控制代码发生变化，因此不得继续用于 Owner Acceptance；更早包同样只保留历史审计。

## 2. A 阶段前只读基线

`2026-08-13T01:27Z` 公网直连只读复核：

- Foundation `13/13 running`；
- unhealthy `0`；
- restart total `0`；
- `strategic_intelligence` 容器、网络均为 `0`；
- 当时新 Artifact `9164960593` 尚未上传公司 QNAP；
- 旧 Artifact `9156356166` 的 10 个 release 文件、Preparation/Baseline Evidence、备份和 3+3 个镜像标签仍保留审计，但全部 `reusable=false`；
- Artifact staging lock、Preparation lock 均为 `0`。

该历史基线已由后续 A～E 实机证据取代，不得再作为当前状态；当前链路见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-stage-a-artifact-9166921089.json` 至 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-stage-e-artifact-9166921089.json`。

## 3. 分阶段影响与时间

已完成 A 阶段，本次实测影响是：

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

以下五项互不继承，当前 A～E 均已完成；该完成状态不自动产生 Owner Acceptance。

### A. Foundation 发布准备与 Artifact 入场

状态：`COMPLETED`。Artifact `9166921089` 已完成隔离上传、9 项 Hash 校验、同卷原子晋级、新备份、Preparation Evidence 和三个候选镜像；Preparation 基线采集未执行 SQL，未切换服务、未运行模型。Artifact `9166253151` 的 A 阶段资产未被复用、覆盖或当作前序 Evidence。

> 历史已执行授权：Artifact `9166921089` 进入公司 QNAP Goal 7 隔离 incoming staging，允许执行 9 项 Hash 校验、同卷原子晋级、新的配置与旧镜像备份、三个候选镜像构建，并生成绑定该 Artifact 的新 Preparation Evidence；旧 Artifact `9166253151` 的 A 阶段资产仅保留审计且不得复用；不授权数据库 SQL、服务重建、Worker 读回、Collector、Shadow 或真实回滚演练。

### B. 既有迁移 012 只读证据对账

状态：`COMPLETED`。已验证历史 Source Archive、SQL Hash、现有四表、4/4 强制 RLS、Tenant Policy、真实 `ontology_app` 权限、无 DELETE 和无敏感正文列，并生成新的对账 Evidence；首次执行与幂等回放均输出 `database_sql_executed=0`，未再次执行 `012-goal7-authority-runtime.sql`。

> 历史已执行授权：只允许只读验证和写入脱敏 Evidence，必须输出 `database_sql_executed=0`，不得再次执行迁移 SQL。

### C. 三组件服务重建

状态：`COMPLETED`。已按恢复型 H-Lite → Agent Core → Knowledge Connector → H-Lite 恢复接单的顺序完成受控重建；切换证据时窗 `18.18 秒`，三组件全部健康，其他 Foundation 服务未重建，13 个服务 restart total 仍为 `0`。

> 历史已执行授权：允许按 drain/resume、逐服务健康检查和自动失败恢复路径重建三组件；不授权 Collector、Shadow、正式 P2、员工投递或 ERP/社媒写回。

### D. 真实 H Worker 双源读回与 Authority Canary

状态：`COMPLETED`。已执行一次固定合成请求，Worker HTTP 与 usage ledger 双源一致，模型为 `grok-4.5`、Route A、重试 `0`；Authority Canary 七项场景全部通过，拒绝路径正文读取 `0`、越权 Evidence `0`，合成数据已清理。

> 历史已执行授权：仅允许合成 Principal、合成知识资源和请求 Hash；不允许读取或输出真实员工正文，不运行 Collector、不迁移数据库、不重启服务。

### E. 真实回滚恢复演练

状态：`COMPLETED`。已按“当前候选版本快照 → 切换发布前旧镜像并验证 → 再恢复到获批候选版本并验证”的顺序完成，实测窗口 `34.709 秒`；旧版 Commit `cee5e995a3d7971f5357be34dac41eaa9002c97c` 与恢复候选 Commit `4a158d1d17141da905e9206dd54013cdac987039` 均验证通过，012 additive migration 保留且未执行 DROP。

> 历史已执行授权：允许真实切换旧镜像并恢复候选；不得执行 DROP、Collector、Shadow、正式 P2、员工投递或 ERP/社媒写回。

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

当前 A～E 已完成，下一步仅由川哥独立确认并记录 Evidence-bound Goal 7 Owner Acceptance。正式七日 `PUBLISH=false` Shadow 不属于本授权卡，仍需来源/P003/四角色 UAT和新的独立授权。A～E 脱敏实机证据见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-stage-a-artifact-9166921089.json` 至 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-stage-e-artifact-9166921089.json`；旧 Artifact `9166253151` 的失效原因见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-supersession-artifact-9166253151.json`。
