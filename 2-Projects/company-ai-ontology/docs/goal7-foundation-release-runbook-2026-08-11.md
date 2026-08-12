# Goal 7 Foundation 正式发布运行手册

日期：2026-08-11（Asia/Shanghai）

状态：`WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH`

## 1. 结论

Goal 7 Foundation 的正式发布步骤、影响范围、预计中断、自动恢复和验收清单已经完成工程准备，但当前没有生产执行资格。本运行手册不构成部署、迁移、服务切换或回滚授权。

Artifact `9142197870` 没有把发布准备、012 迁移与三组件服务切换完全拆成独立授权阶段，现仅保留历史工程证据，禁止部署。当前唯一可申请授权的候选为 Runtime Workflow `31607792883` Attempt `1` / Artifact `9145915628`，精确绑定：

- Ontology Commit `b504f1295bf98b018479556c06e1072516966562`；
- H-Lite Commit `fab8be3f1467289400d0d63ffe378b63ad1a6957`；
- Agent Core `2026-08-12.3`；
- Knowledge Connector `2026-08-11.1`；
- H-Lite `2026-08-12.1`；
- Collector Image `sha256:59eadd7a3b95caa2a7a09604abb981b18f4ce8ec730408efd5f7d0f4efdfe39d`、Manifest `1.3.0` 和完整 8 项 `SHA256SUMS`。

8 项校验和、Release Validator、Goal 7 Foundation 与 PostgreSQL Runtime Evidence 已通过。任何字段变化都需要重新生成预检与授权卡；当前候选仍明确 `companyQnapDeployed=false / productionDeploymentAuthorized=false / publish=false`，本运行手册不自动授予执行资格。

`2026-08-12 22:48 CST` 已经公网 Mini 跳板完成公司 QNAP 纯只读生产预检：五元组一致、Foundation `13/13 running / unhealthy=0 / restart=0`、active Schema `3.3.0 / in_sync`、唯一宿主绑定仍为 `192.168.61.18:19080`；战略情报 Schema、表、容器和网络均为 `0`，五类业务副作用均为 `0`，Artifact `9145915628` 尚未进入 QNAP。脱敏证据见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-readonly-preflight-2026-08-12.json`。本次未写入 QNAP、未迁移、未运行 Collector、未重启服务、未执行回滚。

同轮容量与回滚输入预检确认：QNAP/Docker 为 `x86_64`，与 Artifact `linux/amd64` 兼容；可用内存约 `11.1 GiB`，热卷可用约 `604.7 GiB`，备份卷可用约 `7.1 TiB`；三组件当前镜像均可读，合计约 `882 MiB`，Foundation Compose 校验通过。候选 Runtime 三个部署归档合计约 `56.5 MiB`，尚未传入 QNAP，避免在授权前产生写入。脱敏证据见 `deploy/qnap/strategic-intelligence/evidence/p1-si-goal7-capacity-rollback-preflight-2026-08-12.json`。

正式执行与验收前必须分别取得五项明确授权：

1. Foundation 发布准备授权：`GOAL7_DEPLOY_APPROVED=YES`，只允许 Artifact 入场、备份和候选镜像构建；
2. 012 候选迁移授权：`GOAL7_MIGRATION_012_APPROVED=YES`；
3. Agent Core、Knowledge Connector、H-Lite 服务重建授权：`GOAL7_SERVICE_RECREATION_APPROVED=YES`；
4. 真实回滚演练授权：`GOAL7_ROLLBACK_APPROVED=YES`，不得从前三项继承。
5. 真实 H Worker 双源读回授权：`GOAL7_WORKER_READBACK_APPROVED=YES`，只允许一次固定合成请求和同 request 的 usage ledger 读取，不得从发布授权继承。

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
4. additive migration `012-goal7-authority-runtime.sql`。

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

1. 重新核对公司 QNAP 五元组；
2. 验证 Runtime Artifact 全量 `SHA256SUMS`、六项内部 Hash、Release Manifest 和获批双仓 Commit；
3. 捕获部署前 active Schema、Registry、三个服务版本/Commit、13 个 Foundation 服务、端口、restart count 和指纹；
4. 备份 `.env`、Compose 和三个当前镜像；
5. 应用 additive 012；
6. 构建三个候选镜像，旧服务继续运行；
7. 等待旧 H-Lite 至少 30 秒无飞书入站/出站且 Agent Core admission 空闲；
8. 先切换具备 SQLite 恢复能力的 H-Lite，验证飞书订阅、版本和双仓 Commit；
9. H-Lite 进入 drain，但保持飞书连接，新消息只持久化、不继续调用 Agent Core；
10. Agent Core active request drain 到 0；
11. 仅切换 Agent Core，健康后继续；
12. 仅切换 Knowledge Connector，健康后继续；
13. H-Lite resume，恢复处理持久化消息，要求 `inFlight=0 / pendingDeliveries=0`；
14. 捕获部署后状态和业务副作用窗口；
15. 编译 `deployment-evidence.json`；
16. 另行运行七场景合成权限 Canary；
17. 另行运行 H Worker 双源读回：H-Lite 正式 Adapter 发起固定合成请求，Postgres 读取同一 request 的唯一 usage ledger 行；
18. 编译并验证 `worker-readback.json`，不得手填 provider、model、usage 或 credential mode；
19. 所有工程证据完成后，川哥独立确认 Goal 7 Owner Acceptance；
20. 只通过受控记录器生成 `owner-acceptance.json`，随后编译并验证最终 `goal7-acceptance.json`。

## 5. 验收标准

- active Ontology Schema 仍为 `3.3.0`；
- Registry 为 `in_sync`；
- 012 四张表存在并保持强制 RLS；
- Agent Core 版本为 `2026-08-12.3`，Knowledge Connector 为 `2026-08-11.1`，H-Lite 为 `2026-08-12.1`；
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
- `owner-acceptance.json` 必须绑定 Runtime、Worker、Authority Canary、Deployment 四份工程证据的文件名与 SHA-256，只保存 Owner Principal Hash；
- Owner Acceptance 缺少 `GOAL7_OWNER_ACCEPTANCE_APPROVED=YES`、接受时间早于最新工程证据或工程证据事后变化时失败关闭；
- `deployment-evidence.json` 只能由前后快照和副作用原始证据编译生成。

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

若恢复型 H-Lite 仍有待送达回复，自动恢复优先保留新 H-Lite，恢复旧 Agent Core/Knowledge Connector 后让 H-Lite `resume` 并清空消息；禁止为了完整镜像回退丢弃员工回复。只有 H-Lite 已停止订阅且 `inFlight=0 / pendingDeliveries=0` 时，才允许恢复旧 H-Lite。

本流程覆盖优雅发布、正常容器停止和飞书发送失败。宿主断电、`SIGKILL` 或 WorkCase 半程强杀后的阶段恢复未在 Goal 7 解决，继续留给 Goal 8 lease/fencing；禁止简单按幂等 TTL 从头重跑。

012 是 additive migration。自动恢复和显式服务回滚均保留 012，不自动执行 `DROP TABLE` 或 `DROP SCHEMA`；如未来需要数据库逆向恢复，必须使用独立备份、独立方案和独立授权。

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

因此当前工程准备、不可变 Runtime、容量和公司 QNAP 只读预检已经完成；没有对应单项授权时，不允许上传 Artifact、执行发布准备、Worker 读回、迁移、服务重建或真实回滚动作。A、B、C 三阶段必须按顺序逐项验证前序 Evidence Hash，不能用一次授权贯穿全部动作。

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

该命令不部署、不迁移、不重启、不调用模型；它只重验四份工程证据并写入权限 `0600` 的接受记录。模板不能作为真实接受证据。
