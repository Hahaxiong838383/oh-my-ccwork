# P1-SI-B～H 完成审计矩阵

日期：2026-08-11（Asia/Shanghai）

状态：`engineering_verified / human_review_pending / runtime_update_pending / production_blocked`

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
- 最终完成证据改为由部署前/七日后运行快照、不可变发布包、审批原件和七日原始证据自动编译，拒绝人工填写 Hash、active Ontology 漂移和缺失 010/011。

当前采用双轨：公司 QNAP 上仍是 Commit `a7aeae25e` 的旧 `internal_engineering_shadow` Runtime；Artifact `9096846710` 因 QNAP Docker 输出分隔符不兼容被拒绝，Artifact `9107441466` 又因 package/config/env 非原子切换风险被取代，二者均未替换旧 Runtime。最终 Commit `0342fcd39` 已形成不可变 Artifact `9108034290`，通过真实 QNAP 状态采集、QNAP Shell 语法、Compose 失败不变更和切换中途自动恢复验证，但尚未获得最终 Artifact 的内部 Runtime 更新授权，也未运行 Collector。`production_shadow` 仍不能关闭 Goal。

内部模式不会把任何 `pending` 改写为正式批准：候选 Registry 的 8 个来源继续 `paused / license pending / compliance pending`，Collector 只通过独立的 `INTERNAL_ENGINEERING_PROVISIONAL_ALLOW` 决策读取 3 个安全样例来源，并明确记录 `productionApprovalSatisfied=false / countsTowardProductionShadow=false`。

## 2. B～H 完成矩阵

| 阶段 | 已有权威证据 | 当前判断 | 未关闭事项 |
|---|---|---|---|
| P1-SI-B Source Registry | 3.5.0 contract-only；8 个来源；未登记、暂停、撤销、许可过期和未批准均在网络前失败关闭；CSV 强类型人工审核闭环 | 工程完成，人审未完成 | 8/8 仍为 `pending`，来源继续 `paused` |
| P1-SI-C 公司雷达 | 独立 namespace、oneshot Worker、去重、retention、last-good、失败不覆盖、固定复用锁；Collector `9/9`；新增内部 provisional policy | 工程发布候选已重建 | 无最终批准来源；正式部署前仍需从全部人审完成后的最终 Commit 重建 |
| P1-SI-D 数据底座 | 3.6.0、Postgres 真源、双时间、append-only Raw、幂等/重放、RLS/ACL、010/011 候选迁移；Run `31508346323` 已验证 19/19 RLS、Domain 持久化、幂等、ACL 和 baseline restore | 工程 Runtime 已验证，生产未迁移 | 正式数据库迁移仍等待 Goal 7、人审和独立迁移授权 |
| P1-SI-E 多周期报告 | 9 类报告、非递归输入、ReportRun 完整谱系、飞书/H 只读投影；模型失败机器与 SQL 负测 | 工程完成，真实报告未运行 | Shadow 前不调用真实模型、不发布报告 |
| P1-SI-F Shadow 准备 | 资源限制、无宿主端口、无 Docker Socket、备份/Freeze/回滚、首次运行 Evidence、七日证据链、生产七项 readiness、内部独立 readiness、完整部署脚本演练、统一 QNAP Node Runtime、两阶段运行快照和最终 Goal Completion 八项门禁；`76/76` | 双模式工程完成，新 Artifact 已验证但未更新到 QNAP | 当前 Artifact 未包含最终人审批准，不能作为生产批准 |
| P1-SI-G P003 审核 | 从 4644 条中筛选 36 条，六类各 6 条；工作台、结构化 Principal、四职能角色和脱敏进度检查器 | 工程完成，人审未完成 | 36/36 `pending / inactive`；供应链及若干专业角色仍缺口 |
| P1-SI-H QNAP Shadow | 部署、迁移、回滚、七日验收和最终 Goal Completion 机器门禁均存在；最终门禁重新校验四类审批原件、部署快照和不可变身份 | 未开始 | 未部署、未启动七日 Shadow、未获最终体验验收 |

## 3. Goal 状态派生

| 状态 | 当前值 | 权威依据 |
|---|---|---|
| `engineering_verified` | `true` | Contracts `61/61`、Collector `9/9`、Strategic Intelligence `76/76`、发布包 Hash 与隔离 SQL Runtime 全部通过 |
| `human_review_pending` | `true` | 飞书实时回拉：来源最终决定 `0/8`；P003 最终决定 `0/36`，全部保持 `pending / inactive` |
| `runtime_update_pending` | `true` | QNAP 当前内部 Runtime 仍为 `a7aeae25e`；Artifact `9096846710` 与 `9107441466` 均已取代，目标 Artifact `9108034290` 尚未获得新授权，且当前配置缺少新 Node Runtime Image 绑定 |
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
- Shadow / Readiness / Goal Completion：`76/76`；
- 当前工程不可变发布：Commit `0342fcd3991fc88e32f1f68750b837112717db67`、Workflow Run `31508346323`、Artifact `9108034290`、Collector Image `sha256:26db1ddd56c21cf7e50586efb5953da158b98437f36d5701c6f21e8dfb8c9ab9`，下载后 `SHA256SUMS` 全部通过；
- 公司 QNAP 隔离 Runtime：010/011、表 `19`、强制 RLS `19/19`、Domain Persistence、二次幂等、ACL fail-closed、baseline restore 全部 verified；
- 公司 QNAP 在线复核：active Schema `3.3.0`、active Hash `41689393289d9514d1ed9cd22455a164f1bc59286f0db16deb9235e703e6ae77`、Registry `in_sync`；13 个长期运行 Foundation 服务异常 0、restart 0，运行服务指纹 `29a2dfb752d66dbd7c721815cb78d6c02d3fa0e26cddaf98b9fe77a5e9b153`；`foundation-init exited(0)` 是正常一次性任务；
- 临时 QNAP 目录完整部署演练证明安装后的项目依赖、Runtime Validator、非 root UID/GID 和 0600 配置权限有效，且 Docker 调用仅为 `load / image inspect / compose config`；
- `goal:compile-completion-evidence` 从部署前/七日后快照与原始审批证据自动派生最终 Hash；`goal:completion` 只有在不可变发布包、来源 Registry、P003、成员权限 UAT、Goal 7、生产部署证据、七日原始证据与 Owner Acceptance 全部通过，且 Release/Deployment/Summary 身份一致时才输出 `GOAL_COMPLETE`；
- PESTIM、Source Registry、Data Foundation、Reporting 和 P003 Review 编译通过；
- Candidate Ontology 仍为 `3.7.0`，Hash 保持 `c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860`；
- 自动 P2、员工投递、ERP 写回、社媒写回、因果激活和生产发布继续为 0；
- 本轮连接公司 QNAP，确认部署账号 `uid=1000 / gid=100`、五元组和 Foundation 状态；战略情报容器、网络、端口、运行报告和 Evidence 均为 0。没有修改或迁移生产数据库，没有启动战略情报服务、运行 Collector、重启既有服务或更新内部 Runtime。

## 6. 本轮门禁审计

- Source Review 模板进度：`8 pending / 0 final`；`--final` 返回 8 项错误并失败关闭；飞书实时审核同样为 `8 pending / 0 final`。
- P003 Review 模板进度：`36 pending / 0 final`；`--final` 返回 36 项错误并失败关闭；飞书实时审核同样为 `36 pending / 0 final`。
- 四角色 UAT 模板保持 `incomplete`，成员本人登录、分配范围可编辑、未分配范围拒绝、来源表拒绝和临时编辑回退证据缺失时失败关闭。
- Goal 7 模板保持 `incomplete`，工程证据、Owner Acceptance、权限主体隔离、撤权、ACL、熔断、重试、成本和真实模型读回缺失时失败关闭。
- Deployment Readiness：`0 passed / 7 blocked`，`requiredGate=WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH`。
- Goal Completion：`0 passed / 8 blocked`，`requiredGate=WAIT_PRODUCTION_SHADOW_AND_OWNER_ACCEPTANCE`。

## 7. 当前内部验证顺序

1. 获得“更新 Artifact `9108034290` 到公司 QNAP 内部 Runtime”的独立授权；此前 Artifact 的授权均不继承，更新动作不得运行 Collector、迁移数据库或重启 Foundation；
2. 更新完成并核对新 Runtime、0600 配置、备份归档、SHA-256、Foundation 指纹和零战略情报运行资源；
3. 再单独获得首次 `internal_engineering_shadow` 一次性采集授权；
4. 运行 3 个公开来源的一次性 Worker，验证每来源最多 20 条、正文保存 0、`PUBLISH=false` 和全部业务副作用为 0；
5. 连续运行 1～3 天内部排错，并由川哥完成管理员 Smoke Test；内部结果不得计入正式七日 Shadow。

## 8. 正式生产前必须关闭的门禁

1. 四名职能角色成员分别完成真实登录权限 UAT，并由安全负责人接受；
2. 完成 8 个来源的许可、保留策略和合规最终决定；
3. 完成 36 条 P003 关系的语义重写、正反证据、条件、指标、DRI 和最终决定，全部保持 `inactive`；
4. 完成 Goal 7 工程证据及 Owner Acceptance；
5. 选择性提交并推送本 Goal 最终代码；
6. 从最终已推送 Commit 重建 Manifest 1.2、Linux/amd64 镜像和 010/011 Runtime 证据；
7. 重新在线核对公司 QNAP 五元组，并获得当次部署、数据库迁移和服务动作的明确授权；
8. 只部署战略情报组件，连续运行七个真实上海自然日 `PUBLISH=false` Shadow；
9. 第七日后由川哥完成 Owner Acceptance，才允许关闭 P1-SI Goal。
