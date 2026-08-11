# P1-SI-F 公司 QNAP Shadow 部署准备工程验收

日期：2026-08-10（Asia/Shanghai）

## 1. 结论

公司战略情报雷达的 Shadow 部署候选包已经形成，并完成本地静态验证及 Linux/amd64 CI Runtime 验证：

- `engineering_package_verified=true`；
- `resource_and_security_limits_verified=true`；
- `deployment_gate_verified=true`；
- `image_build_verified=true`；
- `sql_runtime_verified=true`；
- `immutable_release_candidate_verified=true`；
- `company_qnap_deployed=false`；
- `publish=false`。

当前开发机没有 Docker、Podman、Nerdctl、Buildah 或本地 Postgres，因此没有在开发机伪造 Runtime 结果。通过只允许手动触发、`contents: read`、固定 Action SHA 和固定 PostgreSQL 镜像 Digest 的 GitHub Actions，在与公司 QNAP 同为 Linux/amd64 的运行环境完成真实镜像构建、010/011 PostgreSQL 迁移、强制 RLS 和 baseline restore。没有连接、部署或重启公司 QNAP。

Runtime 证据：

- Source Commit：`2974c19eaab1282a0f2dd168ed7056e5a79e6f68`；
- Workflow Run：`31421625978`；
- Artifact：`p1-si-runtime-2974c19eaab1282a0f2dd168ed7056e5a79e6f68`，Artifact ID `9075587049`；
- Artifact 保留期：90 天，GitHub 返回到期时间 `2026-11-08T18:56:45Z`；
- Collector Image ID：`sha256:e642103af70444f67c27fa4f1804541ae9a87f7bd6a0502531decbe7f23a8e7e`；
- Platform：`linux/amd64`；
- Image Archive SHA-256：`8d286478fbd84645f753c8b8788c616fed03f089430e7c78d8e1211e2f9abead`；
- Source Archive SHA-256：`bf9e6fd82f6aaefc42cdcb1706bd66f7cbc88c75d3f5156d9c45f7f1ef532723`；
- Release Manifest SHA-256：`c19cb35eb9e14f869d4fdf980cb4c921588e153b6349ad24b98e8130ab6c094f`；
- PostgreSQL Image：`pgvector/pgvector:pg17-bookworm@sha256:7ae6051efd0e60444282c27c7e141af07f322ce033300e727a49c3dd11075e38`；
- Candidate tables：`19`；
- Forced RLS tables：`19`；
- Baseline restore：`verified`；
- Artifact 解压后直接执行 `sha256sum -c SHA256SUMS`：全部通过。

## 2. 部署形态

目录：`deploy/qnap/strategic-intelligence/`

部署包采用：

```text
轻量常驻 Intelligence Orchestrator
  → 内部文件队列
  → QNAP 既有 crontab Dispatcher
  → docker compose run --no-deps
  → 临时 Intelligence Collector Worker
```

- Orchestrator：`0.1 CPU / 96 MiB`，只连接 internal scheduler 网络；
- Collector：`0.5 CPU / 512 MiB / 128 PIDs`；
- Collector 根文件系统只读、`cap_drop=ALL`、`no-new-privileges`、`restart=no`；
- 不挂载 Docker Socket；
- 不发布宿主机端口；
- 不长期运行个人站或完整雷达系统；
- 不执行 Agent Core、H-Lite、Connector、Gateway、Postgres、Redis 或 Qdrant 的 `up/restart/stop`。

Compose SHA-256：`cf731b4a15adc09b63c788f56e7303bb266269090f5459445b92d40286edbaa1`。

## 3. Shadow 指标

策略文件：`config/shadow-policy.json`，SHA-256：`91612d5cc8d2737322b46e03c2c9f3f1707a011cb155f31b7c35aac9ae12d64f`。

固定指标包括：

- 来源成功率至少 95%；
- 重复率不超过 30%；
- P95 时效不超过 6 小时；
- Worker 失败率不超过 5%，超时率不超过 2%；
- 单日报成本不超过 2 美元、单周报不超过 8 美元；
- Raw Snapshot 每日不超过 1 GiB，网络每日不超过 2 GB；
- Source 撤销 300 秒内生效，撤销后网络请求数为 0；
- 未脱敏敏感信息、正式 P2、员工投递、ERP 写回、社媒写回、因果激活、新端口和容器重启均必须为 0；
- last-good 保存率必须为 100%。

Dispatcher 会从 Collector 产物和 Docker Stats 自动提取来源数、成功数、重复数、P95 时效、Raw 字节、CPU、内存和网络流量。资源证据缺失时该自然日不能通过验收。

## 4. 发布与授权门禁

`prepare-shadow-release.sh` 要求：

1. 项目子树相对 Git HEAD 干净；
2. HEAD 等于已推送 upstream；
3. Ontology、Collector 和 Shadow 包测试通过；
4. Collector 镜像真实构建并取得不可变 Image ID；
5. 010/011 在隔离 PostgreSQL 中应用成功；
6. baseline dump 恢复后不存在 candidate schema；
7. 生成源码包、镜像包、Hash 和发布 Manifest。

部署前 Registry 验证器只接受人工审核编译后的 `shadow_reviewed` 状态，并逐个检查 Collector Config 中的来源是否返回 `SOURCE_APPROVED`；`candidate`、`paused`、`revoked` 或审批不完整来源均拒绝。

`deploy-shadow.sh` 还必须同时取得：

- `SHADOW_DEPLOY_APPROVED=YES`；
- `SHADOW_DATABASE_MIGRATION_APPROVED=YES`；
- `GOAL7_STATUS=complete`；
- `SI_GOAL7_ACCEPTANCE_FILE` 通过机器校验，且同时证明 `engineeringVerified=true / ownerAccepted=true`；
- 公司合规批准的 Source Registry；
- 与 Source Registry 对应的 Collector Config；
- 公司 QNAP 五元组在线一致。

任一门禁不满足时不得部署。

## 5. 自动保护与回滚

- Critical 指标触发时默认自动 Freeze，只停止战略情报 Orchestrator；
- `SHADOW_AUTO_ROLLBACK_APPROVED=YES` 只有在真实回滚获得预授权时才允许设置；
- 回滚恢复战略情报包、配置和镜像引用，不删除 append-only 证据；
- 数据库恢复使用独立备份和独立授权；
- 部署、服务重启和真实回滚授权不得互相继承。

## 6. 七日证据

已提供：

- 日证据 JSON Schema；
- 单日模板；
- 七日汇总模板；
- 七个真实自然日证据文件生成器；
- 单日阈值评估器，并将 Evaluation 绑定到原始 Evidence SHA-256；
- 七日工程汇总编译器；
- 七日最终验收 JSON Schema；
- 显式 Owner Acceptance 记录器；
- 七日最终验收验证器；
- Critical Freeze 和预授权回滚入口。

单日评估现在要求 `sourceAttemptCount > 0`；零来源、运行失败、超时、五类审计覆盖不完整、资源指标缺失、敏感输出、撤权失败、业务副作用、新端口和容器重启均不能通过。

七日编译器要求：

1. 恰好七个真实 Evidence 文件；
2. 上海时区自然日连续且无断档；
3. 每日 `simulated=false / publish=false / status=succeeded`；
4. 每日 Evaluation 为 `ok=true / violations=[]` 且 Evidence Hash 一致；
5. 七日 Source Commit、Collector 镜像、Policy Version 和 Policy Hash 不漂移；
6. 正式 P2、员工投递、ERP/社媒写回、因果激活、新端口和容器重启总数全部为 0；
7. 输出先固定为 `engineeringVerified=true / ownerAccepted=false`。

Owner Acceptance 必须在第七日完成以后，由 `SHADOW_OWNER_ACCEPTANCE_APPROVED=YES` 配合 Owner Principal 和验收引用显式记录。最终验证器会重新读取七日 Evidence 和 Evaluation，重新计算工程证据 Hash，再校验 Owner Acceptance Hash；修改任一日证据都会让既有验收失效。

生成器只创建 `pending_real_run / simulated=false` 模板，不能把模板、测试 fixture 或补录数据当成七日运行证据。

## 7. Collector 许可留存修复

F 阶段自检发现并修复一个正式 Shadow 前必须关闭的问题：Collector 原实现虽然在网络前执行 Source Registry 准入，但仍会把 `summary_metadata` 或 `metadata_only` 来源的完整响应保存为 Base64。

修复后：

- `reference_only / metadata_only / summary_metadata` 的 Raw Snapshot 只保留 Hash、长度、来源和时间，不保存响应体；
- `metadata_only / reference_only` 的 normalized item 不保留摘要；
- 只有 `full_text` 或合法 `structured_data` 来源才保留对应 payload；
- 留存行为直接使用 Source Policy Decision 返回的 retention 约束。

Collector 测试由 `6/6` 增至 `7/7`，覆盖 metadata-only 不留正文、structured-data 可留结构化 payload 的正负验证。

## 8. 本地证据

- Shadow 包测试：`26/26`；
- Shadow 静态验证：通过；
- Collector 测试：`7/7`；
- Ontology Contract 测试：`52/52`；
- Shell 与 Node 语法检查：通过；
- Git diff whitespace 检查：通过。

## 9. Linux/amd64 Runtime 证据

手动 Workflow：`.github/workflows/p1-si-runtime-verify.yml`。

运行 `31421625978` 对已推送 Source Commit `2974c19eaab1282a0f2dd168ed7056e5a79e6f68` 执行：

1. Ontology `52/52`、Collector `7/7`、Shadow `10/10` 和全部候选编译；
2. 构建 Collector Linux/amd64 镜像并取得不可变 Image ID；
3. 输出可复核镜像归档及 SHA-256；
4. 在固定 Digest 的 PostgreSQL/pgvector 镜像中执行生产 baseline migrations；
5. 应用候选 010/011；
6. 验证 19 张候选表全部启用并强制 RLS；
7. 从 candidate 前的 baseline dump 恢复新数据库，确认不存在 `strategic_intelligence` Schema 且 Foundation 仍完整；
8. 生成绑定 Source Commit、源码包、镜像包、Ontology Hash、Registry Hash 和授权门禁的 Release Manifest；
9. 在 CI 内和 Artifact 下载解压后分别直接执行 `sha256sum -c SHA256SUMS`，全部通过；
10. 使用临时 Docker Volume，成功后删除容器和卷，不留下 root-owned 测试目录。

前序 Workflow 分别暴露并修复了相对路径被 Docker 当作卷名、PostgreSQL 容器 UID 导致宿主测试目录无法清理，以及 Artifact 解压后 `SHA256SUMS` 路径前缀不可直接校验三个真实问题。最终运行完整通过，不能用前序运行中的局部成功替代最终证据。

## 10. 当前未完成

> 后续完成性审计补充：本文件记录的 Run `31421625978` / Commit `2974c19ea` Artifact 生成于 P003 最终审核、四名职能角色真实权限体验和 Goal 7 文件化验收门禁加入之前。它继续证明镜像、SQL Runtime、RLS、baseline restore 和 Artifact 便携校验，但 `deploymentEligible=false`。当前 Release Manifest 为 `1.2.0 / P1-SI-F-shadow-candidate-gated`，要求 `reviewerRoleAccessGateRequired=true`；旧 `1.1.0` 及更早包会被拒绝，生产前必须从最终已推送 Commit 重新构建。

- 未取得公司来源合规审批；
- Goal 7 尚未在本 Goal 中证明完成；
- 不可变公司 QNAP 发布候选 Artifact 已形成，但尚未在公司 QNAP 执行五元组复核、备份、Compose preflight 或部署物化；
- 未连接公司 QNAP；
- 未部署 Orchestrator 或 Collector；
- 未开始七日 Shadow；
- 未形成七日 `engineeringVerified=true` 证据；
- 未取得七日 Shadow 的川哥 `ownerAccepted=true` 体验验收；
- 未执行真实 Freeze 或回滚。

因此 P1-SI-F 当前是“部署准备工程候选与 Linux/amd64 Runtime 预验证已完成，公司 QNAP 发布和真实 Shadow 尚未开始”，不能标记为生产完成。
