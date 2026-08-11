# P1-SI-F 公司 QNAP Shadow 部署准备包

本目录是公司战略情报雷达的独立 Shadow 部署候选，只服务于 `P1-SI-F`。当前状态是：

- `engineering_candidate=true`；
- `production_deployed=false`；
- `publish=false`；
- `required_gate=WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH`。

未经川哥明确授权，不得把本目录复制到公司 QNAP、启动 Orchestrator、运行 Collector、执行候选 SQL、重启服务或执行真实回滚。

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
- 默认配置引用 P1-SI-B candidate Source Registry，所选来源保持 `paused`，因此在合规审批完成前会在网络请求前失败关闭。

## 自动保护

- 任何敏感信息未脱敏、撤销后仍发起请求、正式 P2、员工投递、业务写回、因果激活、新宿主机端口或容器重启都会触发自动 Freeze。
- Freeze 只停止战略情报 Orchestrator，不停止或重启 Agent Core、H-Lite、Connector、Gateway、Postgres、Redis 或 Qdrant。
- 自动回滚只有在部署时预先设置 `SHADOW_AUTO_ROLLBACK_APPROVED=YES` 后才允许执行；默认只 Freeze，符合“部署、重启、真实回滚分别授权”的边界。
- 回滚只恢复战略情报包、配置和镜像引用，保留 append-only 证据；数据库恢复必须使用独立备份和独立授权。
- Dispatcher 会从 Collector 运行产物和 Docker Stats 自动提取来源成功数、重复数、P95 时效、Raw Snapshot 字节数、CPU、内存和网络流量；采集不到资源证据时该自然日不能通过验收。
- Dispatcher 会真实执行 Source 撤销、敏感输出、业务副作用、Domain 编译和 Postgres 持久化审计；任一环节失败仍会写入失败 Evidence 并释放 running 队列。
- 七日 Shadow 每日必须同时证明 `domainCompilationCompleted=true`、`domainPersistenceCompleted=true` 和 `persistenceState=postgres_committed`；只生成 JSON Domain Batch 不计入生产 Shadow。

## 本地工程验证

```bash
cd deploy/qnap/strategic-intelligence
npm test
npm run validate
```

当前 Shadow / Readiness / Goal Completion 测试为 `64/64`，其中七日验收负测覆盖：缺日、日期断档、模拟证据、零来源、审计覆盖缺失、Postgres 未持久化、业务副作用、Source Commit 漂移、Collector 镜像漂移、Policy 漂移和容器重启；Domain 链覆盖 Collector 失败、来源无 Snapshot、P003 激活/缺类、模型执行冒领、单事务 SQL、幂等冲突策略和持久化未授权拒绝。生产 readiness、内部模式、部署演练、最终完成判定和回滚授权负测继续保持 fail-closed。

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

`SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE` 必须指向受控目录中的成员真实权限验收文件。四个职能角色分别要求 30/18/6/6 条可编辑记录范围，未分配范围编辑必须被拒绝，旧宽泛角色成员必须为 0，并由安全负责人显式接受。模板 `config/reviewer-role-access-acceptance.template.json` 默认不可通过；验证器输出只包含角色数量、验收时间和 Evidence Hash，不输出成员身份或证据正文。

`GOAL7_STATUS=complete` 只作为显式操作者确认，不能单独证明 Goal 7 已完成。`SI_GOAL7_ACCEPTANCE_FILE` 还必须通过 `validate-goal7-acceptance.mjs`，证明 `engineeringVerified=true / ownerAccepted=true`，Principal、请求发送者隔离、用途收窄、撤权 fail-closed、正文读取前 ACL、Runtime 熔断/重试/成本预算和真实模型读回均已验证；Route B、整库导入、真实员工 Canary、私人 Bot 迁移和 ERP/社媒写回继续关闭。模板 `config/goal7-acceptance.template.json` 默认不可通过，禁止把复制模板当验收证据。

部署脚本只应用 010/011 战略情报候选迁移并启动 `intelligence-orchestrator`，不会执行任何既有核心服务的 `up`、`restart` 或 `stop`。
Dispatcher 使用 QNAP 既有 crontab 每分钟检查队列，安装过程不会重启 cron daemon。

## 当前 Runtime 与发布候选证据

当前开发机没有 Docker、Podman、Nerdctl、Buildah 或本地 Postgres，因此没有在开发机伪造 Runtime 结果。手动 GitHub Actions Run `31421625978` 已对已推送 Source Commit `2974c19eaab1282a0f2dd168ed7056e5a79e6f68` 完成：

- Collector Linux/amd64 镜像真实构建，Image ID `sha256:e642103af70444f67c27fa4f1804541ae9a87f7bd6a0502531decbe7f23a8e7e`；
- 010/011 候选 SQL 的隔离 PostgreSQL Runtime 验证；
- 19/19 候选表强制 RLS；
- baseline dump/restore；
- 不可变 `source.tar.gz`、`collector-image.tar.gz` 和 `release-manifest.json`；
- Artifact 解压目录内直接执行 `sha256sum -c SHA256SUMS` 全部通过；
- `immutableReleaseCandidateVerified=true`、`publish=false`、`productionDeploymentAuthorized=false`。

Artifact：`p1-si-runtime-2974c19eaab1282a0f2dd168ed7056e5a79e6f68`，保留 90 天，到期时间 `2026-11-08T18:56:45Z`。当前仍未完成：

- 公司来源许可和合规审批；
- Goal 7 完成证据；
- 公司 QNAP 五元组在线复核；
- 公司 QNAP Compose config、备份和部署前快照；
- 公司 QNAP Shadow 部署；
- 七个真实自然日 Shadow及川哥最终体验验收。
- 新 Domain Batch → Postgres 持久化链的两次幂等写入与无 ACL 读取负测 Runtime 证据。

该 Artifact 生成于 P003 最终审核、成员真实权限验收、Goal 7 文件化验收门禁和 Domain Postgres 持久化链加入之前，现在只保留为历史工程证据，`deploymentEligible=false`。Release Manifest 已升级到 `1.2.0 / P1-SI-F-shadow-candidate-gated`；必须在实名审核、成员权限体验和 Goal 7 完成后，从当时已推送的最终 Commit 重新运行 Runtime Workflow 并生成不可变发布包。

以上未完成项不得用 CI、静态测试、模板或模拟数据冒充完成。
