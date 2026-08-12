# P1-SI-F 公司 QNAP Shadow 部署准备包

本目录是公司战略情报雷达的独立 Shadow 部署候选，只服务于 `P1-SI-F`。当前状态是：

- `engineering_candidate=true`；
- `production_deployed=false`；
- `internal_engineering_runtime_prepared=true`；
- `internal_engineering_first_run=true`；
- `publish=false`；
- `required_gate=WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH`。

内部工程 Runtime 已按独立授权准备完成，并完成一次 accepted Collector；未经新的明确授权，不得继续第 2～3 天内部 Collector、部署正式 Orchestrator、执行生产候选 SQL、重启服务或执行真实回滚。

## 运行形态

1. `intelligence-orchestrator` 是 0.1 CPU / 96 MiB 的轻量常驻调度器，只在内部队列写入幂等请求，不连接外网、不挂载 Docker Socket。
2. QNAP Task Scheduler 每分钟执行一次 `scripts/dispatch-next.sh`。
3. Dispatcher 仅在存在请求时执行 `docker compose run --no-deps intelligence-collector`。
4. `intelligence-collector` 是临时 oneshot Worker，限制为 0.5 CPU / 512 MiB、只读根文件系统、`cap_drop=ALL`、`no-new-privileges`、`restart=no`。
5. Worker 退出后被删除，不形成第二套长期运行的个人站或雷达系统。
6. Collector 成功后编译 `publish=false` 的 Domain Batch，并以单事务写入既有 Postgres `strategic_intelligence` Schema；JSON 只作为可重放候选和审计证据，不是第二套结构化真源。

## 网络和安全

- Compose 不发布任何宿主机端口。
- 所有容器均不挂载 `/var/run/docker.sock`。
- Orchestrator 只连接内部 scheduler 网络。
- Collector 只连接专用 egress 网络和既有 Foundation data 网络。
- 所有发布、正式 P2、员工投递、ERP/社媒写回和因果关系激活开关固定为 false。
- Collector 镜像必须使用不可变 Image ID 或 Registry Digest。
- Foundation 运行态指纹只统计当前运行中的 13 个长期服务；Compose 的一次性 `foundation-init` 正常退出不计为故障。战略情报项目仍使用全量容器检查，任何退出后残留的临时 Collector 都视为资源泄漏。
- QNAP 宿主没有原生 Node；正式部署、数据库迁移、Dispatcher、Postgres 持久化、撤权审计和副作用审计统一通过 `NODE_BIN` / `node-runtime.sh` 使用固定 Image ID 或 Digest 的隔离 Node Runtime，禁止回退到宿主 `node` 假设。
- 最终 Source Registry、Collector Config、P003、四角色 UAT 和 Goal 7 审批原件必须先以 `0600` 权限放入 `/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/approvals/<release-id>/`，再由无网络 Node Runtime 校验；部署入口拒绝战略情报受控根目录以外的审批路径。
- 默认配置引用 P1-SI-B candidate Source Registry，所选来源保持 `paused`，因此在合规审批完成前会在网络请求前失败关闭。

## 自动保护

- 任何敏感信息未脱敏、撤销后仍发起请求、正式 P2、员工投递、业务写回、因果激活、新宿主机端口或容器重启都会触发自动 Freeze。
- Freeze 只停止战略情报 Orchestrator，不停止或重启 Agent Core、H-Lite、Connector、Gateway、Postgres、Redis 或 Qdrant。
- 自动回滚只有在部署时预先设置 `SHADOW_AUTO_ROLLBACK_APPROVED=YES` 后才允许执行；默认只 Freeze，符合“部署、重启、真实回滚分别授权”的边界。
- 回滚只恢复战略情报包、配置和镜像引用，保留 append-only 证据；数据库恢复必须使用独立备份和独立授权。
- 内部 Runtime 更新只有在旧 package/config/env 已生成可读 `previous-runtime.tar.gz`、独立 SHA-256 校验通过且归档包含三类必需条目后才允许继续。内部回滚在移动当前 Runtime 前必须验证归档、校验和与目录完整性；首次安装留下的空备份指针不能执行回滚。
- Dispatcher 会从 Collector 运行产物和 Docker Stats 自动提取来源成功数、重复数、P95 时效、Raw Snapshot 字节数、CPU、内存和网络流量；采集不到资源证据时该自然日不能通过验收。
- Dispatcher 会真实执行 Source 撤销、敏感输出、业务副作用、Domain 编译和 Postgres 持久化审计；任一环节失败仍会写入失败 Evidence 并释放 running 队列。
- 七日 Shadow 每日必须同时证明 `domainCompilationCompleted=true`、`domainPersistenceCompleted=true` 和 `persistenceState=postgres_committed`；只生成 JSON Domain Batch 不计入生产 Shadow。

## 本地工程验证

```bash
cd deploy/qnap/strategic-intelligence
npm test
npm run validate
```

当前 Shadow / Readiness / Goal Completion 测试为 `119/119`，其中七日验收负测覆盖：缺日、日期断档、模拟证据、零来源、审计覆盖缺失、Postgres 未持久化、业务副作用、Source Commit 漂移、Collector 镜像漂移、Policy 漂移和容器重启；Domain 链覆盖 Collector 失败、来源无 Snapshot、P003 激活/缺类、模型执行冒领、单事务 SQL、幂等冲突策略和持久化未授权拒绝。首次内部运行新增独立 Evidence Schema、编译器和验证器，强制验证 3 个来源全部成功、每来源不超过 20 条、Raw Snapshot 仅保留 Hash、Foundation 13 服务前后指纹一致、临时容器/网络/发布端口归零、正式 P2/员工投递/ERP/社媒写回/因果激活归零。四角色 UAT 已升级为编译证据：最终验收只能由四份不同真实成员 Session 与一份绑定 Session Hash 的安全负责人接受记录生成，手改最终 JSON、篡改 Session、复用同一成员或提前接受均失败关闭。Goal 7 Foundation 后续要求发布准备、既有 012 只读对账、三个服务重建和真实回滚演练分别显式授权，并把授权精确绑定到 Ontology/H-Lite 双仓 Commit；后续阶段必须验证前序 Evidence Hash，不能用一次授权贯穿全部生产动作。Runtime Manifest `1.4.0` 额外生成 `runtime-component-versions.json`，固定 `goal7Migration012Mode=pre_existing_reconciliation_only / goal7Migration012SqlReplayAllowed=false`；旧 Manifest `1.3.0` 必须失败关闭。部署只逐个切换 Agent Core、Knowledge Connector、H-Lite，强制关闭知识整库同步并自动采集前后状态及零副作用证据。真实 H Worker 读回和 Goal 7 Owner Acceptance 均禁止手填，生产 readiness、内部模式、部署演练、最终完成判定和回滚授权继续保持 fail-closed。

Goal 7 正式 Foundation 发布计划由 `config/goal7-foundation-release-plan.json` 和 `scripts/validate-goal7-release-plan.mjs` 共同约束：总维护窗口预计 8～20 分钟，员工可感知间歇中断预计累计 15～120 秒，回滚预计 2～6 分钟；发布准备、既有 012 对账、三个服务重建和真实回滚演练为四项独立授权。发布顺序固定为 A 解包/备份/构建候选镜像 → B 只读对账既有 012 并证明 `database_sql_executed=0` → C 旧 H-Lite 安静窗口 → 恢复型 H-Lite 先切换 → H-Lite/Agent Core drain → Agent Core → Knowledge Connector → H-Lite resume；自动恢复只重建实际切换过的服务。详细运行手册见 `docs/goal7-foundation-release-runbook-2026-08-11.md`。

Artifact `9142197870` 没有把发布准备、012 和服务切换完全拆成独立授权阶段，已降级为历史证据。Runtime Workflow `31607792883` Attempt `1` / Artifact `9145915628` 虽通过 Manifest `1.3.0` 工程验证，但仍包含可重复执行 012 的旧 B 阶段；中间候选 `9148389214` 又绑定了缺少连续性补丁的旧 H-Lite 源码，二者均禁止部署。最终 Workflow `31614522984` Attempt `1` / Artifact `9148675772` 已通过 Manifest `1.4.0`、完整 8 项 `SHA256SUMS`、Release Validator 与 Goal 7 Runtime Validator，固定 `pre_existing_reconciliation_only / SQL replay=false`，是当前唯一可申请 A～E 独立授权的工程候选。优雅 drain 不等于强杀恢复；宿主断电、`SIGKILL` 和半程 WorkCase 恢复继续由 Goal 8 lease/fencing 处理。

Foundation 部署完成后，真实 Worker 读回使用第五项独立授权 `GOAL7_WORKER_READBACK_APPROVED=YES`。该脚本不迁移数据库、不重启服务、不运行 Collector，只创建一份临时合成知识证据，经 H-Lite 正式 Agent Core Adapter 调用一次 Route A，并读取同一 request 的 `runtime.h_engine_usage_events`；最终只保留请求 Hash 和运行元数据，合成知识资源会删除、合成 Principal 会禁用。编译与验证命令为 `npm run goal7:compile-worker-readback` 和 `npm run goal7:validate-worker-readback`。

Goal 7 Owner Acceptance 必须在四份工程证据全部生成后，以独立显式确认执行：

```bash
GOAL7_OWNER_ACCEPTANCE_APPROVED=YES \
GOAL7_OWNER_PRINCIPAL_REF='company-directory:<owner-principal>' \
GOAL7_OWNER_ACCEPTANCE_REF='feishu:doc/<goal7-acceptance-document>' \
npm run goal7:record-owner-acceptance -- "$GOAL7_EVIDENCE_ROOT"

npm run goal7:compile-acceptance -- "$GOAL7_EVIDENCE_ROOT"
npm run goal7:validate-acceptance -- "$GOAL7_EVIDENCE_ROOT/goal7-acceptance.json"
```

记录器只保存 Owner Principal 的 SHA-256，不保存姓名或原始 Principal ID；缺少显式确认、工程证据漂移、接受时间早于工程证据、双仓 Commit 不一致或模板手填均失败关闭。

## 内部工程验证模式

当前先使用 `internal_engineering_shadow`，而不是放宽正式 `production_shadow`：

- 只选 3 个无需登录/凭据/反自动化绕过的公开来源；
- 每个来源必须提供确定的 `endpointRef`；端点只能复用 Registry 已登记的官方 origin/path，GitHub 还必须属于 `repositoryAllowlist`，禁止直接执行 URL 模板；
- 只保存 `reference_only`，最长 3 天；
- 六类 P003 各 1 条样例，全部 `sample_reviewed_keep_inactive / inactive`；
- 运行 1～3 天，`countsTowardProductionShadow=false`；
- 来源许可/合规、36 条 P003 最终审核、四角色 UAT 和 Goal 7 继续标记为 `deferred_before_production`；
- 正式 P2、员工投递、ERP/社媒写回和因果激活始终为 0。
- 部署包保留完整 `company-ai-ontology` 项目树，确保 Runtime Validator 的 Contracts/Collector 依赖在 QNAP 上可解析；容器运行身份使用部署账号的非 root UID/GID，不依赖管理员执行 `chown`。

本地生成并验证内部 Runtime：

```bash
npm run internal:validate
npm run internal:compile-runtime -- \
  config/internal-engineering-shadow-plan.json \
  /tmp/company-si-internal-engineering-runtime
npm run internal:validate-runtime -- /tmp/company-si-internal-engineering-runtime
npm run internal:readiness
```

默认 `internal:readiness` 会因缺少当次部署授权、公司 QNAP 在线五元组预检和最终不可变发布包而退出码 `2`。只有这三项全部通过，才允许准备内部部署动作；它不要求、也不能替代正式来源审批、P003 最终审核、成员 UAT 或 Goal 7。

获得单独授权后，内部部署使用 `scripts/deploy-internal-engineering-shadow.sh`：只加载不可变 Collector 镜像、复制独立配置和准备运行目录，不执行 010/011 迁移、不启动常驻容器、不安装正式 Dispatcher、不重启既有服务。单次采集由 `scripts/run-internal-engineering-once.sh` 执行，并再次要求运行授权；运行产物位于独立 `internal-engineering` 目录，不进入正式七日 Evidence。真实回滚由 `scripts/rollback-internal-engineering-shadow.sh` 单独授权，且只恢复内部包和配置，不操作数据库或既有服务。

## 部署门禁只读检查

部署前先运行统一只读检查器。它只返回稳定的门禁状态和原因码，不输出审批正文、实名人员、文件路径或 Secret；任何输入缺失或验证失败都会以退出码 `2` 失败关闭。

```bash
SHADOW_DEPLOY_APPROVED=YES \
GOAL7_STATUS=complete \
SI_RELEASE_ROOT=/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/release/<release-id> \
SI_APPROVED_SOURCE_REGISTRY_FILE=/path/to/approved-source-registry.json \
SI_APPROVED_COLLECTOR_CONFIG_FILE=/path/to/approved-collector-config.json \
SI_APPROVED_P003_REVIEW_FILE=/path/to/approved-p003-review.json \
SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE=/path/to/reviewer-role-access-acceptance.json \
SI_GOAL7_ACCEPTANCE_FILE=/path/to/goal7-acceptance.json \
npm run readiness
```

只有输出 `deploymentEligible=true / requiredGate=READY_FOR_EXPLICIT_DEPLOYMENT` 时，才允许进入 `deploy-shadow.sh`；检查器本身不复制文件、不执行迁移、不启动容器，也不重启任何既有服务。

## 七日 Shadow 验收闭环

每日 Dispatcher 生成的正式证据必须同时包含 `simulated=false / publish=false`，并由 `evaluate-shadow.mjs` 绑定原始 Evidence SHA-256。零来源采集、运行失败、超时、缺少五类审计覆盖、资源指标缺失、业务副作用、新端口或容器重启都会失败关闭。

七个真实自然日结束后，在公司 QNAP 的受控证据目录执行：

```bash
npm run shadow:compile-seven-day -- "$SI_SHADOW_ROOT/evidence" "$SI_SHADOW_ROOT/evidence/seven-day-shadow-summary.json"
```

编译器只接受恰好七个连续的上海自然日，并要求七日 Source Commit、Collector 镜像、Policy Version 和 Policy Hash 完全一致。输出只代表 `engineeringVerified=true / ownerAccepted=false`。

川哥完成真实体验验收后，才能使用独立显式确认记录 Owner Acceptance：

```bash
SHADOW_OWNER_ACCEPTANCE_APPROVED=YES \
SHADOW_OWNER_PRINCIPAL_REF='company-directory:<owner-principal>' \
SHADOW_OWNER_ACCEPTANCE_REF='feishu:doc/<acceptance-document>' \
npm run shadow:record-owner-acceptance -- \
  "$SI_SHADOW_ROOT/evidence/seven-day-shadow-summary.json" \
  "$SI_SHADOW_ROOT/evidence" \
  "$SI_SHADOW_ROOT/evidence/seven-day-shadow-summary.accepted.json"

npm run shadow:validate-seven-day -- \
  "$SI_SHADOW_ROOT/evidence/seven-day-shadow-summary.accepted.json" \
  "$SI_SHADOW_ROOT/evidence"
```

没有 `SHADOW_OWNER_ACCEPTANCE_APPROVED=YES`、验收时间早于第七日完成时间、Evidence/Evaluation 被修改、Hash 漂移或缺少 Owner Acceptance 时，最终验证器必须拒绝。模板、补录文件和测试 fixture 不能作为真实七日证据。

## Goal 最终完成门禁

七日 Owner Acceptance 之后，仍不能只凭汇总文档关闭 Goal，也不得手工填写最终 Hash。部署前和七日 Owner Acceptance 后必须分别在公司受控目录保存 `pre-deployment-runtime-snapshot.json` 与 `post-seven-day-runtime-snapshot.json`，记录公司 QNAP 五元组、active Schema/Hash、Foundation 容器数量与 restart count、战略情报容器健康、010/011 迁移、新端口、备份/回滚和业务副作用计数。Git 中的 `config/goal-runtime-snapshot.template.json` 与 `config/goal-completion-evidence.template.json` 均保持 `pending`，不能直接作为运行或完成证据。

先分别验证两份运行快照：

```bash
npm run goal:validate-runtime-snapshot -- /path/to/pre-deployment-runtime-snapshot.json pre_deployment
npm run goal:validate-runtime-snapshot -- /path/to/post-seven-day-runtime-snapshot.json post_seven_day
```

再由编译器读取两份快照、不可变发布包、五类审批原件及七日原始证据，自动生成 `goal-completion-evidence.json`：

```bash
SI_PRE_DEPLOYMENT_SNAPSHOT_FILE=/path/to/pre-deployment-runtime-snapshot.json \
SI_POST_SEVEN_DAY_SNAPSHOT_FILE=/path/to/post-seven-day-runtime-snapshot.json \
SI_RELEASE_ROOT=/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/release/<release-id> \
SI_APPROVED_SOURCE_REGISTRY_FILE=/path/to/approved-source-registry.json \
SI_APPROVED_COLLECTOR_CONFIG_FILE=/path/to/approved-collector-config.json \
SI_APPROVED_P003_REVIEW_FILE=/path/to/approved-p003-review.json \
SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE=/path/to/reviewer-role-access-acceptance.json \
SI_GOAL7_ACCEPTANCE_FILE=/path/to/goal7-acceptance.json \
SI_SEVEN_DAY_ACCEPTED_SUMMARY_FILE="$SI_SHADOW_ROOT/evidence/seven-day-shadow-summary.accepted.json" \
SI_SEVEN_DAY_EVIDENCE_ROOT="$SI_SHADOW_ROOT/evidence" \
SI_GOAL_COMPLETION_EVIDENCE_FILE=/path/to/goal-completion-evidence.json \
SI_GOAL_COMPLETION_DEPLOYED_AT=<deployment-time-iso8601> \
SI_GOAL_COMPLETION_VERIFIED_BY_PRINCIPAL_REF=<company-principal-ref> \
npm run goal:compile-completion-evidence
```

编译器要求部署前后 QNAP 身份、active Ontology Hash 和 Foundation 容器数量一致；七日后的快照必须晚于 Owner Acceptance，010/011 必须恰好存在，战略情报 Orchestrator 健康且重启为 0，业务副作用仍为 0。任何审批、运行快照、发布包或七日证据漂移都会失败关闭。

```bash
SI_RELEASE_ROOT=/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/release/<release-id> \
SI_APPROVED_SOURCE_REGISTRY_FILE=/path/to/approved-source-registry.json \
SI_APPROVED_COLLECTOR_CONFIG_FILE=/path/to/approved-collector-config.json \
SI_APPROVED_P003_REVIEW_FILE=/path/to/approved-p003-review.json \
SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE=/path/to/reviewer-role-access-acceptance.json \
SI_GOAL7_ACCEPTANCE_FILE=/path/to/goal7-acceptance.json \
SI_GOAL_COMPLETION_EVIDENCE_FILE=/path/to/goal-completion-evidence.json \
SI_SEVEN_DAY_ACCEPTED_SUMMARY_FILE="$SI_SHADOW_ROOT/evidence/seven-day-shadow-summary.accepted.json" \
SI_SEVEN_DAY_EVIDENCE_ROOT="$SI_SHADOW_ROOT/evidence" \
npm run goal:completion
```

最终检查器重新执行不可变发布包、来源 Registry、P003、四角色 UAT、Goal 7、部署完成证据和七日 Owner Acceptance 验证，并比较 Release、Deployment、七日 Summary 的 Source Commit、Collector Image、Policy Version/Hash 与审批 Hash。只有输出 `goalCompletionEligible=true / requiredGate=GOAL_COMPLETE` 时，才具备关闭 Goal 的机器条件；仍需以川哥真实 Owner Acceptance 为最终事实。

具备容器运行时且 Git 已干净推送后，才能执行：

```bash
scripts/prepare-shadow-release.sh
```

该脚本会验证 Git `HEAD` 等于 upstream、运行测试、构建 Collector 镜像、执行 010/011 候选迁移隔离验证、验证 baseline restore，并生成不可变源码包、镜像包和 Manifest。

实际部署入口是 `scripts/deploy-shadow.sh`，但它同时要求：

- `SHADOW_DEPLOY_APPROVED=YES`；
- `SHADOW_DATABASE_MIGRATION_APPROVED=YES`；
- `GOAL7_STATUS=complete`；
- `SI_GOAL7_ACCEPTANCE_FILE` 指向 Goal 7 工程证据和川哥人工验收文件；
- 已审批 Source Registry 和 Collector Config；
- P003 36 条候选均有实名 DRI 最终决定，且所有关系继续保持 `inactive`；
- 四个职能角色必须由各自成员真实登录完成分配类别可编辑、未分配类别不可编辑、来源表无权限以及新增/删除/复制/下载/视图修改均拒绝的体验验收；
- 完整且 Hash 一致的不可变发布包。

部署时必须通过 `SI_APPROVED_P003_REVIEW_FILE` 指向公司受控目录中的最终审核工作簿。部署入口会执行 `validate-approved-p003-review.mjs`：任何 `pending`、候选 Hash 漂移、缺少实名参与者、审核字段不完整或 `activationStatus` 被改为 `active` 都会在数据库迁移和服务启动前失败关闭。该审核文件包含个人信息，不进入 Git、共享记忆或公开验收报告。

`SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE` 必须指向受控目录中由编译器生成的成员真实权限验收文件。四个职能角色分别要求 30/18/6/6 条可编辑记录范围，必须由四个不同真实成员完成 Session，未分配范围编辑必须被拒绝，旧宽泛角色成员必须为 0；安全负责人必须接受四份实际 Session Hash。模板 `config/reviewer-role-access-acceptance.template.json` 默认不可通过；验证器会重读五份原始 Evidence，并且只输出角色数量、验收时间、原始文件数量和 Evidence Hash，不输出成员身份或证据正文。

`GOAL7_STATUS=complete` 只作为显式操作者确认，不能单独证明 Goal 7 已完成。`SI_GOAL7_ACCEPTANCE_FILE` 还必须通过 `validate-goal7-acceptance.mjs`，证明 `engineeringVerified=true / ownerAccepted=true`，Principal、请求发送者隔离、用途收窄、撤权 fail-closed、正文读取前 ACL、Runtime 熔断/重试/成本预算和真实模型读回均已验证；Route B、整库导入、真实员工 Canary、私人 Bot 迁移和 ERP/社媒写回继续关闭。模板 `config/goal7-acceptance.template.json` 默认不可通过，禁止把复制模板当验收证据。

Goal 7 权限验收必须在候选 Agent Core、H-Lite 和 012 迁移部署后单独运行 `deploy/qnap/scripts/run-goal7-authority-canary.sh`。脚本只创建带 `simulation=true` 的临时 Principal、知识资源和 ACL，通过已部署 H-Lite 代码验证群聊/私聊上下文传递，再对真实 Agent Core 执行私聊发送者隔离、活跃群成员、过期成员、撤权、多人艾特不扩权、用途收窄和 ACL 拒绝七项场景；结束时删除合成资源、ACL、Principal、授权快照和审计事件，生成权限 `0600` 的 `authority-canary.json`。它不运行 Collector、不迁移数据库、不部署或重启任何 Foundation 服务。执行前必须同时具备已推送的 40 位 `GOAL7_SOURCE_COMMIT` 与容器内完整 `H_LITE_SOURCE_COMMIT`，最终 Acceptance 会绑定两个仓的 Commit 和 H-Lite 源码归档 Hash。

部署脚本只应用 010/011 战略情报候选迁移并启动 `intelligence-orchestrator`，不会执行任何既有核心服务的 `up`、`restart` 或 `stop`。
Dispatcher 使用 QNAP 既有 crontab 每分钟检查队列，安装过程不会重启 cron daemon。

## 当前 Runtime 与发布候选证据

当前开发机没有 Docker、Podman、Nerdctl、Buildah 或本地 Postgres，因此没有在开发机伪造 Runtime 结果。手动 GitHub Actions Run `31480010967` 已对已推送 Source Commit `c0d9ce92fb94d09b2c46ae1e019c166da8b32468` 完成：

- Collector Linux/amd64 镜像真实构建，Image ID `sha256:9f7d03ba5eca8e1ca1654e17272099cc0bfdebdd07bc303ed04faec7d8b1776a`；
- 010/011 候选 SQL 的隔离 PostgreSQL Runtime 验证；
- 19/19 候选表强制 RLS；
- Domain Batch 两次幂等持久化与无 ACL 读取 fail-closed；
- baseline dump/restore；
- 不可变 `source.tar.gz`、`collector-image.tar.gz` 和 `release-manifest.json`；
- Artifact 解压目录内直接执行 `sha256sum -c SHA256SUMS` 全部通过；
- `immutableReleaseCandidateVerified=true`、`publish=false`、`productionDeploymentAuthorized=false`。

Artifact：`p1-si-runtime-c0d9ce92fb94d09b2c46ae1e019c166da8b32468`，Artifact ID `9096846710`，保留至 `2026-11-09T09:57:08Z`。下载后 `SHA256SUMS` 全量通过，并直接确认源码包使用 `docker ps -q` 统计运行中的 Foundation 服务、使用 `docker ps -aq` 检查战略情报残留容器；部署脚本生成旧 Runtime 归档及 SHA-256，回滚脚本在 `retired=` 之前验证归档存在、校验和和三类必需条目；当前仍未完成：

- 公司来源许可和合规审批；
- Goal 7 完成证据；
- 正式生产部署前的公司 QNAP 五元组、Compose config、备份和运行快照复核；
- 公司 QNAP Shadow 部署；
- 七个真实自然日 Shadow及川哥最终体验验收。

该 Artifact 已覆盖当前工程代码、统一 QNAP Node Runtime 和首次内部运行 Evidence 链，但生成时来源最终审核、P003 最终审核、成员权限 UAT 与 Goal 7 尚未完成，因此仍是 `productionDeploymentAuthorized=false / deploymentEligible=false` 的工程发布候选。Artifact `9108034290` 已更新为公司 QNAP 当前内部 Runtime，并已完成一次 accepted 内部采集；正式生产部署前仍必须从全部人审门禁完成后的最终 Commit 再运行 Runtime Workflow，不能直接把本 Artifact 当作生产批准。

`2026-08-12` 生产溯源确认四张 Goal 7 表来自历史 Workflow `31555822727` / Artifact `9125968266`，SQL Hash 与当前候选一致；历史发布目录缺失原始 `migration-012-evidence.json`。因此 Runtime Workflow `31607792883` Attempt `1` / Artifact `9145915628`、中间候选 `9148389214`、`9142197870`、`9138991942`、`9130040972` 及更早版本一并只保留历史证据，禁止部署。当前唯一授权候选是 Workflow `31614522984` / Artifact `9148675772`；其脱敏验签证据见 `evidence/p1-si-runtime-artifact-9148675772.json`。

内部 Runtime 更新实机证据见 `evidence/qnap-internal-runtime-update-9108034290.json`：旧 `a7aeae25e` 已完成可验证备份，更新前后 Foundation 13/13、异常 0、restart 0、指纹一致；战略情报容器、网络、端口、数据库 Schema、Collector 状态和报告均为 0。继续第 2～3 天内部 Collector 仍要求新的独立授权。

`evidence/p1-si-current-gate-snapshot-2026-08-12.json` 与 `evidence/p1-si-live-gate-status-2026-08-12.json` 保留最终 Artifact 生成前的历史门禁快照，不改写其原始 Hash；最终候选身份见 `evidence/p1-si-runtime-artifact-9148675772.json`，当前解释见 `docs/p1-si-bh-gate-audit-2026-08-12.md`。

最新公司 QNAP 无落盘只读预检见 `evidence/p1-si-goal7-readonly-preflight-2026-08-12.json`：`2026-08-12 22:48 CST` 经公网 Mini 跳板复核，五元组正确，Foundation `13/13 running / unhealthy=0 / restart=0`，唯一宿主绑定仍为 `192.168.61.18:19080`；active Schema `3.3.0 / in_sync`，`strategic_intelligence` Schema、表、容器和网络均为 `0`，五类业务副作用均为 `0`。该预检发生在最终 Artifact 生成前；最终验签 Evidence 继续证明 Artifact `9148675772` 尚未上传公司 QNAP。Goal 7 四表的后续溯源见 `evidence/goal7-migration-012-provenance-2026-08-12.json`。这些证据均不授予 Runtime 动作。

容量与回滚输入见 `evidence/p1-si-goal7-capacity-rollback-preflight-2026-08-12.json`：主机/Docker 架构与 `linux/amd64` 平台一致，内存、热卷和备份卷容量充足，三个当前服务镜像均可读，Foundation Compose 有效；最终候选 Runtime 未提前传入 QNAP，所有写入和服务动作继续为 `0`。

飞书审核工作台的最新脱敏回拉仍见 `evidence/p1-si-live-gate-status-2026-08-12.json`：来源 `8 pending / 0 final`，P003 `36 pending / 36 inactive / 0 final`。该文件中的 Artifact `9145915628` 身份是历史快照；使用最终 Artifact `9148675772` 重新运行机器检查器后，当前结果仍为 Deployment Readiness `1 pass / 6 blocked`、Goal Completion `1 pass / 7 blocked`，其中唯一通过项为不可变 Release。该证据不包含姓名、Principal 或审批正文。

首次内部运行证据见 `evidence/qnap-first-internal-run-9108034290.json`。第一次尝试在 Collector 启动前发现外部网络默认值与 Foundation 固定网络不一致，来源请求为 0 并失败留证；修正为 `company_ai_data` 后，第二次尝试完成 3 来源、60 条、Hash-only、正文 0、重复 0，Foundation 指纹一致，临时容器/网络/端口和五类业务副作用均为 0。Evidence 只接受为内部工程验证，不具生产 Shadow 资格。

历史 Run `31421625978` / Commit `2974c19ea`、Run `31473316988` / Commit `a7aeae25e`、Run `31475369650` / Commit `6e15417cf`、Run `31476183330` / Commit `80f3fc6dd`、Run `31478053382` / Commit `47d90ae1b` 和 Run `31479040859` / Commit `6cb49ad48` 仅保留为演进证据，均不得替代当前或未来的正式发布身份。

以上未完成项不得用 CI、静态测试、模板或模拟数据冒充完成。
