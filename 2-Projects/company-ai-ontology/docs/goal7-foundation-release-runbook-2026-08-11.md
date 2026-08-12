# Goal 7 Foundation 正式发布运行手册

日期：2026-08-11（Asia/Shanghai）

状态：`IMMUTABLE_ARTIFACT_VERIFIED / STAGE_A_AUTHORIZATION_PENDING`

## 1. 结论

Goal 7 Foundation 的正式发布步骤、影响范围、预计中断、自动恢复和验收清单已经完成工程准备。机器 Release Plan `1.6.0` 的 9 项 Hash、隔离上传和原子晋级门禁已由 Workflow `31634250761` Attempt `1` / Artifact `9156356166` 验证通过。当前仅具备申请 A 阶段授权的条件；A 尚未授权，B～E 仍由前序 Evidence 阻断。本运行手册不构成部署、数据库 SQL、服务切换或回滚授权。

Artifact `9156356166` 是当前唯一候选，离线 `SHA256SUMS` 9/9 通过；Artifact `9155268396`、`9153663685`、`9151468565` 及更早包只保留历史工程证据并禁止部署。当前候选尚未进入公司 QNAP，也未获得任何 Runtime 动作授权。

- Ontology Commit：`63bead3665e7e7d616744b9484d4e49192b13541`；
- H-Lite Commit `baa00bf07089a3caf5fe6318aac28cb73bd5ae13`；
- Agent Core `2026-08-12.3`、Knowledge Connector `2026-08-11.1`、H-Lite `2026-08-12.1`；
- Collector Image：`sha256:7486070a3b91377ba87e0eaad08135549d612dcc6fe95cdefadd807f5e74ebc3`；
- Manifest：`1.6.0`。

当前 Artifact 已通过 9 项 `SHA256SUMS`、严格根目录白名单、`image.env` 与 Runtime Verification 交叉校验、Release Validator、Goal 7 Foundation 与 PostgreSQL Runtime Evidence，并固定 `goal7Migration012Mode=pre_existing_reconciliation_only / goal7Migration012SqlReplayAllowed=false`。A 阶段准备链已补齐全局互斥锁、危险或超长 `runId` 拒绝、失败回放保留既有 Evidence、仅清理本次创建的镜像标签、Agent Core/Knowledge Connector/H-Lite 基础镜像 digest 固定，以及 Preparation 状态采集不调用 Postgres 的可执行负测；`before/after/rollback` 阶段仍保留迁移只读检查。该工程门禁不构成生产授权；任何字段变化都需要重新生成 Artifact、预检与授权卡。

同一真实 Artifact 已在本机临时目录完成 staging 脚本实包演练：首次晋级返回 `completed`，第二次同字节重放返回 `replay_accepted`，篡改 `image.env` 后因 checksum mismatch 失败关闭，未留下无效 release、锁或 partial 目录；晋级后的 10 个文件全部为 `0600`。证据见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-local-stage-rehearsal-artifact-9156356166.json`。该演练不连接公司 QNAP、`countsTowardStageA=false`，正式 A Evidence 仍必须在明确授权后由公司 QNAP 实机生成。

历史只读预检与迁移溯源确认 active Schema `3.3.0 / in_sync`，Goal 7 四张 Authority/Runtime 表来自历史 Workflow `31555822727`，原始 B 阶段 Evidence 缺失。Artifact `9156356166` 生成后于 `2026-08-12T19:51:30Z` 经公网 Mini 跳板完成纯只读复核：五元组一致、Foundation `13/13 running / unhealthy=0 / restart=0`、战略情报容器/网络 `0/0`，新旧候选 Artifact 匹配文件和两类锁均为 `0`。脱敏证据见 `deploy/qnap/strategic-intelligence/evidence/goal7-migration-012-provenance-2026-08-12.json`、`deploy/qnap/strategic-intelligence/evidence/p1-si-runtime-artifact-9156356166.json` 和 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-readonly-preflight-artifact-9156356166.json`。本轮未写入 QNAP、未执行 SQL、未运行 Collector、未重启服务、未执行回滚。

同轮容量与回滚输入预检确认：QNAP/Docker 为 `x86_64`，与 Artifact `linux/amd64` 兼容；可用内存约 `11.1 GiB`，热卷可用约 `604.7 GiB`，备份卷可用约 `7.1 TiB`；三组件当前镜像均可读，合计约 `882 MiB`，Foundation Compose 校验通过。候选 Runtime 三个部署归档合计约 `56.5 MiB`，尚未传入 QNAP，避免在授权前产生写入。脱敏证据见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-capacity-rollback-preflight-2026-08-12.json`。

正式执行与验收仍必须分别取得五项明确授权：

1. Foundation 发布准备授权：`GOAL7_DEPLOY_APPROVED=YES`，只允许 Artifact 入场、备份和候选镜像构建；
2. 既有 012 对账授权：`GOAL7_MIGRATION_012_RECONCILIATION_APPROVED=YES`，只允许只读验证和写入脱敏 Evidence，必须输出 `database_sql_executed=0`；
3. Agent Core、Knowledge Connector、H-Lite 服务重建授权：`GOAL7_SERVICE_RECREATION_APPROVED=YES`；
4. 真实 H Worker 双源读回与 Authority Canary 授权：`GOAL7_WORKER_READBACK_APPROVED=YES`，两条路径共用一次 D 阶段授权，且都必须在任何写入前通过公司 QNAP 五元组预检；
5. 真实回滚恢复演练授权：`GOAL7_ROLLBACK_APPROVED=YES`，必须验证发布前旧版本后再恢复到获批候选版本，不得从前四项继承。

自动失败恢复属于本次发布的安全保护，不等于获得真实回滚演练授权。

## 2. 时间与中断预估

以下是基于当前脚本顺序和健康检查上限的发布前估算，不是生产实测值。正式发布后必须用真实时间替换估算值。

| 阶段 | 预计时间 | 用户影响 |
|---|---:|---|
| Runtime 包、Hash、双 Commit、配置和旧镜像检查 | 2～5 分钟 | 0 秒 |
| 三个候选镜像构建 | 6～15 分钟 | 0 秒，旧服务继续运行 |
| 等待旧 H-Lite 30 秒安静窗口 | 30～180 秒 | 旧服务继续接单 |
| 恢复型 H-Lite 切换与飞书重连 | 5～40 秒 | 飞书长连接短暂重连；新消息先持久化 |
| H-Lite 与 Agent Core 排空 | 0～90 秒 | 新请求进入 H-Lite 待恢复队列，不发送假失败结果 |
| Agent Core 顺序切换与健康确认 | 5～40 秒 | 公司 Bot 推理暂缓，H-Lite 保留消息 |
| Knowledge Connector 顺序切换与健康确认 | 5～40 秒 | 公司知识检索短暂降级 |
| H-Lite 恢复接单并清空待送达 | 0～90 秒 | 已持久化消息继续处理并送达 |
| 部署后快照、零副作用审计和证据编译 | 1～3 分钟 | 无新增预期中断 |

- 总维护窗口预计：`8～20 分钟`；
- 预计员工可感知间歇中断：累计 `15～120 秒`；
- 单个目标服务硬健康检查上限：`180 秒`；
- 任一服务超过上限立即停止后续切换并触发自动恢复；
- 自动或显式回滚预计：`2～6 分钟`，回滚健康检查硬上限 `180 秒`。

## 3. 影响范围

仅允许变更：

1. `agent-core`；
2. `knowledge-connector`；
3. `h-lite`；
4. 已存在的 012 四表只读证据对账；不得再次执行 SQL。

必须保持不重启、不重建：

- Postgres；
- Redis；
- Qdrant；
- Ontology Registry；
- Action Gateway；
- Domain Connector；
- Gateway。

继续关闭：Collector、正式七日 Shadow、产品研究部整库导入、正式 P2、员工任务投递、ERP 写回、社媒写回和因果关系激活。

## 4. 执行顺序

1. 将 Artifact 上传到 `incoming/goal7-<artifact-id>.uploading`；上传中断只能留下隔离半包，不能成为 Runtime 输入；
2. 使用 `stage-goal7-runtime-release.sh` 校验九项 `SHA256SUMS`、拒绝任何额外根文件，并在同一卷内原子晋级为 `release/goal7-<artifact-id>`；
3. 验证 Runtime Artifact 内部 Hash、Release Manifest 和获批双仓 Commit；
4. 捕获部署前 active Schema、Registry、三个服务版本/Commit、13 个 Foundation 服务、端口、restart count 和指纹；
5. 备份 `.env`、Compose 和三个当前镜像；
6. 构建并绑定三个候选镜像，旧服务继续运行；
7. 验证 A 阶段 Preparation Evidence；
8. 对历史 Source Archive、固定 SQL Hash、现有四表、RLS、Tenant Policy 和 `ontology_app` 权限做只读对账；
9. 验证 B 阶段 Migration Evidence，必须证明 `database_sql_executed=0`；
10. 等待旧 H-Lite 至少 30 秒无飞书入站/出站且 Agent Core admission 空闲；
11. 先切换具备 SQLite 恢复能力的 H-Lite，验证飞书订阅、版本和双仓 Commit；
12. H-Lite 与 Agent Core 进入 drain，新消息只持久化，Agent Core active request 降到 0；
13. 仅切换 Agent Core，健康后继续；
14. 仅切换 Knowledge Connector，健康后继续；
15. H-Lite resume，恢复处理持久化消息，要求 `inFlight=0 / pendingDeliveries=0`；
16. 捕获部署后状态；
17. 审计正式 P2、员工投递、ERP/社媒写回和因果激活均为 0；
18. 编译并验证 `deployment-evidence.json`；
19. D 阶段运行 H Worker 双源读回并编译验证 `worker-readback.json`；
20. 同一 D 授权下运行合成 Authority Canary，验证私聊、群聊、多人艾特、Purpose、撤权和正文前 ACL；
21. E 阶段执行候选版本快照 → 旧版本切换验证 → 获批候选版本恢复；
22. 从六份原始文件编译并验证 `rollback-drill-evidence.json`；
23. 五份工程证据完成后，由川哥独立确认 Owner Acceptance，再通过受控记录器生成 `owner-acceptance.json` 并编译最终 `goal7-acceptance.json`。

## 5. 验收标准

- active Ontology Schema 仍为 `3.3.0`；
- Registry 为 `in_sync`；
- 012 四张表存在并保持强制 RLS；
- Agent Core、Knowledge Connector、H-Lite 版本与新 Artifact 的 `runtime-component-versions.json` 完全一致；
- Agent Core、Knowledge Connector 读回 Ontology Commit，H-Lite 读回独立 H-Lite Commit；
- Foundation 关键服务数 `13`、unhealthy `0`、restart total `0`；
- 新增宿主端口 `0`；
- Route A operational，Route B disabled；
- 正式 P2、员工投递、ERP 写回、社媒写回、因果激活均为 `0`；
- 产品研究部整库导入和 Collector 均未启动；
- 合成 Canary 临时资源清理为 `0`；
- H Worker 读回必须为 `Route A / Route B disabled / productionReady=true / ledgerRecorded=true`；
- HTTP 元数据和 Postgres ledger 的 request Hash、provider、model、credential mode、token、费用与 retry count 完全一致，ledger row count 必须恰好为 1；
- 读回证据不得保存 Prompt、回复、请求正文、员工问题或原始 request ID；
- `worker-readback.json` 只能由 `worker-http-response.json` 与 `worker-ledger-row.json` 编译生成，任一原始文件或最终文件被修改即失败；
- `rollback-drill-evidence.json` 必须证明旧版本已验证、获批候选版本已恢复、012 保留、restart/端口/五类业务副作用均为 0；
- `owner-acceptance.json` 必须绑定 Runtime、Worker、Authority Canary、Deployment、Rollback Drill 五份工程证据的文件名与 SHA-256，只保存 Owner Principal Hash；
- Owner Acceptance 缺少 `GOAL7_OWNER_ACCEPTANCE_APPROVED=YES`、接受时间早于最新工程证据或工程证据事后变化时失败关闭；
- `deployment-evidence.json` 只能由前后快照和副作用原始证据编译生成；`rollback-drill-evidence.json` 只能由六份回滚原始证据编译生成。

## 6. 自动恢复与回滚触发条件

出现任一条件立即停止。只恢复实际已经切换的服务，未切换服务绝不重建：

- 目标服务在 180 秒内未健康；
- Runtime 或健康读回的任一双仓 Commit 不一致；
- active Schema 改变或 Registry 不再 `in_sync`；
- Foundation 出现 unhealthy 或 restart；
- 出现新增宿主端口；
- 检测到正式 P2、员工投递、ERP/社媒写回或因果激活；
- 部署证据无法由原始快照重新编译。
- Worker 双源读回缺账本、重复账本、Route B、模型/费用/Token/凭据漂移或发现敏感字段。
- H-Lite 或 Agent Core drain 超时，或 H-Lite `pendingDeliveries` 无法归零。
- 旧版本未通过验证、获批候选版本未恢复或回滚原始证据无法重新编译。

若恢复型 H-Lite 仍有待送达回复，自动恢复优先保留新 H-Lite，恢复旧 Agent Core/Knowledge Connector 后让 H-Lite `resume` 并清空消息；禁止为了完整镜像回退丢弃员工回复。只有 H-Lite 已停止订阅且 `inFlight=0 / pendingDeliveries=0` 时，才允许恢复旧 H-Lite。

本流程覆盖优雅发布、正常容器停止和飞书发送失败。宿主断电、`SIGKILL` 或 WorkCase 半程强杀后的阶段恢复未在 Goal 7 解决，继续留给 Goal 8 lease/fencing；禁止简单按幂等 TTL 从头重跑。

012 是已落库的 additive migration。新流程禁止 SQL replay；自动恢复和显式服务回滚均保留 012，不执行 `DROP TABLE` 或 `DROP SCHEMA`。如未来需要数据库逆向恢复，必须使用独立备份、独立方案和独立授权。

## 7. 当前关闭门禁

| 门禁 | 当前值 |
|---|---:|
| 来源最终决定 | `0/8` |
| P003 最终决定 | `0/36` |
| 四角色真实 UAT | `0/4` |
| Goal 7 Owner Acceptance | `未完成` |
| Production Readiness | `1/7`，仅不可变 Release 通过 |
| 七日 Production Shadow | `0/7` |
| Goal Completion | `1/8`，仅不可变 Release 通过 |

因此当前工程准备、Artifact 验签、容量和公司 QNAP 公网只读预检已完成。下一步只申请 A 阶段；A Evidence 通过前不得申请 B，后续仍必须按阶段逐项验证前序 Evidence Hash，不能用一次授权贯穿全部动作。

机器契约：`deploy/qnap/strategic-intelligence/config/goal7-foundation-release-plan.json`。

Owner Acceptance 记录命令：

```bash
GOAL7_OWNER_ACCEPTANCE_APPROVED=YES \
GOAL7_OWNER_PRINCIPAL_REF='company-directory:<owner-principal>' \
GOAL7_OWNER_ACCEPTANCE_REF='feishu:doc/<goal7-acceptance-document>' \
npm run goal7:record-owner-acceptance -- "$GOAL7_EVIDENCE_ROOT"

npm run goal7:compile-acceptance -- "$GOAL7_EVIDENCE_ROOT"
npm run goal7:validate-acceptance -- "$GOAL7_EVIDENCE_ROOT/goal7-acceptance.json"
```

该命令不部署、不迁移、不重启、不调用模型；它只重验五份工程证据并写入权限 `0600` 的接受记录。模板不能作为真实接受证据。
