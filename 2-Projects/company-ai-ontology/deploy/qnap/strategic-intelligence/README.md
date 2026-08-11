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

## 本地工程验证

```bash
cd deploy/qnap/strategic-intelligence
npm test
npm run validate
```

当前 Shadow 包测试为 `29/29`，其中七日验收负测覆盖：缺日、日期断档、模拟证据、零来源、审计覆盖缺失、业务副作用、Source Commit 漂移、Collector 镜像漂移、Policy 漂移和容器重启；部署 readiness 另覆盖输入缺失、完整通过和无效验收文件三条路径。

## 部署门禁只读检查

部署前先运行统一只读检查器。它只返回稳定的门禁状态和原因码，不输出审批正文、实名人员、文件路径或 Secret；任何输入缺失或验证失败都会以退出码 `2` 失败关闭。

```bash
SHADOW_DEPLOY_APPROVED=YES \
GOAL7_STATUS=complete \
SI_RELEASE_ROOT=/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/release/<release-id> \
SI_APPROVED_SOURCE_REGISTRY_FILE=/path/to/approved-source-registry.json \
SI_APPROVED_COLLECTOR_CONFIG_FILE=/path/to/approved-collector-config.json \
SI_APPROVED_P003_REVIEW_FILE=/path/to/approved-p003-review.json \
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
- 完整且 Hash 一致的不可变发布包。

部署时必须通过 `SI_APPROVED_P003_REVIEW_FILE` 指向公司受控目录中的最终审核工作簿。部署入口会执行 `validate-approved-p003-review.mjs`：任何 `pending`、候选 Hash 漂移、缺少实名参与者、审核字段不完整或 `activationStatus` 被改为 `active` 都会在数据库迁移和服务启动前失败关闭。该审核文件包含个人信息，不进入 Git、共享记忆或公开验收报告。

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

该 Artifact 生成于 P003 最终审核门禁和 Goal 7 文件化验收门禁加入之前，现在只保留为 Linux/amd64 镜像、SQL Runtime 和可复现打包的历史工程证据，`deploymentEligible=false`。Release Manifest 已升级到 `1.1.0 / P1-SI-F-shadow-candidate-gated`，并强制声明 `p003ReviewGateRequired=true / goal7AcceptanceGateRequired=true`；旧 `1.0.0` Artifact 会被新验证器拒绝。必须在实名审核和 Goal 7 完成后，从当时已推送的最终 Commit 重新生成不可变发布包。

以上未完成项不得用 CI、静态测试、模板或模拟数据冒充完成。
