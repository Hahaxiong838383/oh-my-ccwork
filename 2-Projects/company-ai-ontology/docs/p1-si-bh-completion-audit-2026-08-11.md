# P1-SI-B～H 完成审计矩阵

日期：2026-08-11（Asia/Shanghai）

状态：`engineering_verified / human_review_pending / runtime_updated / production_blocked`

## 1. 结论

P1-SI-B～G 的机器契约、候选数据模型、Collector、报告、P003 审核工作台和 QNAP Shadow 准备链已经具备完整工程骨架。本轮进一步补齐：

- 模型失败的 ReportRun 必须保留错误码、重试、开始/结束时间、耗时、token 与成本谱系；
- PostgreSQL `report_runs` 同步执行状态约束，防止失败记录伪装成功或终态缺少结束证据；
- 回滚脚本新增真实执行负测，未获得独立回滚授权时必须在 QNAP 预检、备份读取和容器操作之前拒绝。
- 内部部署包必须保留完整项目树，否则 Runtime Validator 在部署后无法解析 Ontology Contracts 与 Collector 依赖；新增真实打包布局回归。
- QNAP bind mount 目录不能假设固定 UID `10001/10003` 可写；Compose 改为使用部署账号的非 root UID/GID，并在部署入口拒绝 root Runtime。
- QNAP 宿主机不保证提供 `node`；隔离迁移验证器新增 `NODE_BIN`，并增加 Node 缺失时在创建 Docker 状态前失败关闭的负测。
- 正式部署、数据库迁移、Dispatcher、Domain 持久化、撤权审计和副作用审计已全部移除宿主 `node` 假设，统一通过固定镜像的 `node-runtime.sh`；审批原件必须位于 QNAP 战略情报受控根目录内。
- 公司 QNAP 已用固定 PostgreSQL 17 digest、`network=none` 临时容器和一次性 Volume 真实验证 010/011、19/19 强制 RLS、Domain 持久化、二次幂等、ACL fail-closed 和 baseline restore；Foundation 前后指纹一致、restart 0，临时资源已清零。
- 最终完成证据改为由部署前/七日后运行快照、不可变发布包、审批原件和七日原始证据自动编译，拒绝人工填写 Hash、active Ontology 漂移和迁移缺口。P1-SI-H 部署前快照必须已有 Goal 7 `012` 且没有 010/011；七日后必须精确为 `010/011/012`。
- Goal 7 真实 H Worker 读回已改为双源编译证据：H-Lite 正式 Adapter 的脱敏 HTTP 元数据必须与 Postgres 同 request 的唯一 usage ledger 行完全一致；禁止用配置标签或手填 JSON冒充真实 provider/model/token/费用读回。
- Goal 7 Owner Acceptance 已改为受控记录证据：必须先重验四份工程 Evidence，并绑定其 SHA-256、双仓 Commit、接受时间和脱敏 Owner Principal Hash；复制模板或事后替换工程证据不能关闭 Goal。

当前采用双轨：最终 Commit `0342fcd39` / Artifact `9108034290` 已更新到公司 QNAP `internal_engineering_shadow` Runtime，旧 Commit `a7aeae25e` 已完整备份。首次内部 Collector 已真实通过：3 个公开来源各 20 条、总计 60 条、Hash-only、正文 0、重复 0，Foundation 13/13、异常 0、restart 0、指纹一致，临时容器/网络/端口归零，五类业务副作用为 0。该 Evidence 明确 `eligibleForProductionShadow=false`，`production_shadow` 仍不能关闭 Goal。

内部模式不会把任何 `pending` 改写为正式批准：候选 Registry 的 8 个来源继续 `paused / license pending / compliance pending`，Collector 只通过独立的 `INTERNAL_ENGINEERING_PROVISIONAL_ALLOW` 决策读取 3 个安全样例来源，并明确记录 `productionApprovalSatisfied=false / countsTowardProductionShadow=false`。

## 2. B～H 完成矩阵

| 阶段 | 已有权威证据 | 当前判断 | 未关闭事项 |
|---|---|---|---|
| P1-SI-B Source Registry | 3.5.0 contract-only；8 个来源；未登记、暂停、撤销、许可过期和未批准均在网络前失败关闭；CSV 强类型人工审核闭环 | 工程完成，人审未完成 | 8/8 仍为 `pending`，来源继续 `paused` |
| P1-SI-C 公司雷达 | 独立 namespace、oneshot Worker、去重、retention、last-good、失败不覆盖、固定复用锁；Collector `9/9`；新增内部 provisional policy | 工程发布候选已重建 | 无最终批准来源；正式部署前仍需从全部人审完成后的最终 Commit 重建 |
| P1-SI-D 数据底座 | 3.6.0、Postgres 真源、双时间、append-only Raw、幂等/重放、RLS/ACL、010/011 候选迁移；Run `31508346323` 已验证 19/19 RLS、Domain 持久化、幂等、ACL 和 baseline restore | 工程 Runtime 已验证，生产未迁移 | 正式数据库迁移仍等待 Goal 7、人审和独立迁移授权 |
| P1-SI-E 多周期报告 | 9 类报告、非递归输入、ReportRun 完整谱系、飞书/H 只读投影；模型失败机器与 SQL 负测 | 工程完成，真实报告未运行 | Shadow 前不调用真实模型、不发布报告 |
| P1-SI-F Shadow 准备 | 资源限制、无宿主端口、无 Docker Socket、备份/Freeze/回滚、首次运行 Evidence、七日证据链、生产七项 readiness、内部独立 readiness、完整部署脚本演练、统一 QNAP Node Runtime、两阶段运行快照、四角色 UAT 编译验收、Goal 7 编译验收、Worker 双源读回、Evidence-bound Owner Acceptance、双仓 Commit 绑定部署门禁、维护窗口机器计划和最终 Goal Completion 八项门禁；当前代码 `114/114` | 双模式工程与首次内部运行完成 | Artifact `9108034290` 仍是 `77/77` 历史 Runtime，未包含 UAT v2、Goal 7 编译验收、Worker 双源读回、受控 Owner Acceptance、H-Lite 双仓来源证明和最终人审批准，不能作为生产批准；内部 Evidence 不计入正式七日 Shadow |
| P1-SI-G P003 审核 | 从 4644 条中筛选 36 条，六类各 6 条；工作台、结构化 Principal、四职能角色和脱敏进度检查器 | 工程完成，人审未完成 | 36/36 `pending / inactive`；供应链及若干专业角色仍缺口 |
| P1-SI-H QNAP Shadow | 部署、迁移、回滚、七日验收和最终 Goal Completion 机器门禁均存在；最终门禁重新校验四类审批原件、部署快照和不可变身份 | 未开始 | 未部署、未启动七日 Shadow、未获最终体验验收 |

## 3. Goal 状态派生

| 状态 | 当前值 | 权威依据 |
|---|---|---|
| `engineering_verified` | `true` | Contracts `61/61`、Collector `9/9`、当前 Strategic Intelligence `98/98`、发布包 Hash、隔离 SQL Runtime 与首次内部运行全部通过；UAT v2 和 Goal 7 双仓新增代码尚待推送后的 CI Evidence |
| `human_review_pending` | `true` | 飞书实时回拉：来源最终决定 `0/8`；P003 最终决定 `0/36`，全部保持 `pending / inactive` |
| `runtime_update_pending` | `false` | QNAP 当前内部 Runtime 已绑定 `0342fcd39` / Artifact `9108034290`，0600 环境已固化固定 Node Image；首次 Collector、生产迁移、重启和回滚仍分别关闭 |
| `production_blocked` | `true` | Deployment Readiness `0/7`，要求继续等待 Goal 7、审批原件和当次明确部署授权 |
| `owner_accepted` | `false` | 四角色 UAT、Goal 7 Owner Acceptance 和七日 Shadow Owner Acceptance 均不存在 |
| `goal_complete` | `false` | Goal Completion `0/8`，要求继续等待生产 Shadow 与 Owner Acceptance |

## 4. 完成标准负向测试覆盖

| 必测项 | 证据 | 结果 |
|---|---|---|
| 权限撤销 | Agent Core 无权限 Evidence=0；Knowledge Connector 撤权后 Evidence 归零；RLS 要求 Principal、Purpose 和有效 ACL | 已覆盖 |
| 来源撤销 | Source Registry `SOURCE_REVOKED`；Collector 对暂停/撤销来源网络调用数为 0 | 已覆盖 |
| 采集失败 | HTTP/解析/响应体超限失败；失败不覆盖 `last-good`，不生成候选报告 | 已覆盖 |
| 模型失败 | `failed` ReportRun 必须有稳定 `errorCode`、终态时间、重试、耗时、token 和成本；缺失失败关闭 | 本轮补齐 |
| 重复数据 | Raw dedup/idempotency；Collector 重复 URL 去重；P003 重复源行拒绝 | 已覆盖 |
| 过期证据 | Evidence Package 对过期/陈旧 Evidence 降为低置信且禁止确定性结论；Source 许可过期拒绝采集 | 已覆盖 |
| 回滚负测 | 无独立授权时回滚脚本真实执行拒绝；历史 CI 已证明 010/011 baseline restore | 本轮加强 |
| QNAP Node Runtime 缺失 | `NODE_BIN` 指向不存在路径时退出码 2，且发生在创建 Docker Volume/容器之前 | 本轮补齐 |

## 5. 当前工程验证

- Ontology Contracts：`61/61`；
- Intelligence Collector：`9/9`；
- Shadow / Readiness / Goal Completion：当前代码 `98/98`；Artifact `9108034290` 为此前 `77/77`；
- 当前工程不可变发布：Commit `0342fcd3991fc88e32f1f68750b837112717db67`、Workflow Run `31508346323`、Artifact `9108034290`、Collector Image `sha256:26db1ddd56c21cf7e50586efb5953da158b98437f36d5701c6f21e8dfb8c9ab9`，下载后 `SHA256SUMS` 全部通过；
- 公司 QNAP 隔离 Runtime：010/011、表 `19`、强制 RLS `19/19`、Domain Persistence、二次幂等、ACL fail-closed、baseline restore 全部 verified；
- 公司 QNAP 更新前后在线复核：active Schema `3.3.0`、active Hash `41689393289d9514d1ed9cd22455a164f1bc59286f0db16deb9235e703e6ae77`、Registry `in_sync`；13 个长期运行 Foundation 服务异常 0、restart 0，运行服务指纹均为 `b11e7789fea4d8b6f62e1e0aad0ac70fb5f0ae2bd134ff8cbf799da0d6f75887`；`foundation-init exited(0)` 是正常一次性任务；
- 临时 QNAP 目录完整部署演练证明安装后的项目依赖、Runtime Validator、非 root UID/GID 和 0600 配置权限有效，且 Docker 调用仅为 `load / image inspect / compose config`；
- `goal:compile-completion-evidence` 从部署前/七日后快照与原始审批证据自动派生最终 Hash；`goal:completion` 只有在不可变发布包、来源 Registry、P003、成员权限 UAT、Goal 7、生产部署证据、七日原始证据与 Owner Acceptance 全部通过，且 Release/Deployment/Summary 身份一致时才输出 `GOAL_COMPLETE`；
- PESTIM、Source Registry、Data Foundation、Reporting 和 P003 Review 编译通过；
- Candidate Ontology 仍为 `3.7.0`，Hash 保持 `c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860`；
- 首次内部 Collector：3 来源全部成功、各 20 条、总计 60 条、Raw Snapshot 3、正文保留 0、重复 0、Candidate Report 未发布；Evidence accepted，且不计入生产 Shadow；
- 自动 P2、员工投递、ERP 写回、社媒写回、因果激活和生产发布继续为 0；
- 本轮在独立授权下将 Artifact `9108034290` 更新为当前内部 Runtime；只执行 Hash/契约校验、旧 Runtime 备份、镜像加载、Compose config 和三件套原子切换。战略情报容器、网络、端口、Collector 状态和报告均为 0；`strategic_intelligence` Schema 仍 absent、表 0，没有启动 Collector、迁移生产数据库或重启既有服务。

## 6. 本轮门禁审计

- Source Review 模板进度：`8 pending / 0 final`；`--final` 返回 8 项错误并失败关闭；飞书实时审核同样为 `8 pending / 0 final`。
- P003 Review 模板进度：`36 pending / 0 final`；`--final` 返回 36 项错误并失败关闭；飞书实时审核同样为 `36 pending / 0 final`。
- 四角色 UAT 模板保持 `incomplete`，成员本人登录、分配范围可编辑、未分配范围拒绝、来源表拒绝和临时编辑回退证据缺失时失败关闭。
- Goal 7 保持 `incomplete`。P1-AUTHORITY/P1-RUNTIME 已形成未部署的本地工程候选并通过 Agent Core `63/63`、Knowledge Connector `18/18`；012 候选迁移与 Runtime Workflow 已接线，候选验证已要求真实 `ontology_app` 读写、完整 usage、预算拒绝后落账和 Ontology/H-Lite 双仓不可变来源证明。最终验收已升级为五份 Evidence 绑定的 `2.0.0` 编译包，其中 Worker Evidence 又必须由 HTTP 与 ledger 两份原始证据二次编译，Owner Acceptance 必须由记录器绑定前四份证据 Hash。当前双仓推送、PostgreSQL CI Evidence、飞书合成 Canary、真实 H Worker 双源运行、QNAP 部署和 Owner Acceptance 仍缺失，因此 `engineeringVerified=false / ownerAccepted=false`。
- Deployment Readiness：`0 passed / 7 blocked`，`requiredGate=WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH`。
- Goal Completion：`0 passed / 8 blocked`，`requiredGate=WAIT_PRODUCTION_SHADOW_AND_OWNER_ACCEPTANCE`。

## 7. 当前内部验证顺序

1. ✅ Artifact `9108034290` 已完成独立授权更新；
2. ✅ 首次 `internal_engineering_shadow` 一次性采集通过机器验收；
3. 当前最低 1 天内部验证已满足；如继续第 2～3 天排错，需新的运行授权；
4. 主线转入来源/P003 人审、四角色 UAT 和 Goal 7，内部结果不得计入正式七日 Shadow。

## 8. 正式生产前必须关闭的门禁

1. 四名职能角色成员分别完成真实登录权限 UAT，并由安全负责人接受；
2. 完成 8 个来源的许可、保留策略和合规最终决定；
3. 完成 36 条 P003 关系的语义重写、正反证据、条件、指标、DRI 和最终决定，全部保持 `inactive`；
4. 完成 Goal 7 工程证据及 Owner Acceptance；
5. 选择性提交并推送本 Goal 最终代码；
6. 从最终已推送 Commit 重建 Manifest 1.2、Linux/amd64 镜像、010/011 战略情报 Runtime 与 012 Goal 7 Runtime 证据；
7. 重新在线核对公司 QNAP 五元组，并获得当次部署、数据库迁移和服务动作的明确授权；
8. 只部署战略情报组件，连续运行七个真实上海自然日 `PUBLISH=false` Shadow；
9. 第七日后由川哥完成 Owner Acceptance，才允许关闭 P1-SI Goal。

剩余人审建议采用最小闭环：3 个已验证公开来源批准 Shadow、其余 5 个继续暂停；P003 六类各 1 条完整深审，其余 30 条快速保持 inactive。具体执行批次见 `p1-si-remaining-gates-execution-pack-2026-08-11.md`。
