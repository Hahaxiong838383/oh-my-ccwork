# P1-SI-F 公司 QNAP Shadow 部署准备工程验收

日期：2026-08-10（Asia/Shanghai）

## 1. 结论

公司战略情报雷达的 Shadow 部署候选包已经形成，并完成本地静态验证及 Linux/amd64 CI Runtime 验证：

- `engineering_package_verified=true`；
- `resource_and_security_limits_verified=true`；
- `deployment_gate_verified=true`；
- `image_build_verified=true`；
- `sql_runtime_verified=true`；
- `company_qnap_deployed=false`；
- `publish=false`。

当前开发机没有 Docker、Podman、Nerdctl、Buildah 或本地 Postgres，因此没有在开发机伪造 Runtime 结果。通过只允许手动触发、`contents: read`、固定 Action SHA 和固定 PostgreSQL 镜像 Digest 的 GitHub Actions，在与公司 QNAP 同为 Linux/amd64 的运行环境完成真实镜像构建、010/011 PostgreSQL 迁移、强制 RLS 和 baseline restore。没有连接、部署或重启公司 QNAP。

Runtime 证据：

- Source Commit：`c9909a8bad72b9db7761e7d2437c8788f604da12`；
- Workflow Run：`31416612677`；
- Collector Image ID：`sha256:f157370e5e57521eb24afdfc0a9b11ab64fa51cbce9073ce392c25fac38cc389`；
- Platform：`linux/amd64`；
- Image Archive SHA-256：`78337583cd35f40802ec9316da5942dc7d39c7d646019ac327e19ecd8b73726d`；
- PostgreSQL Image：`pgvector/pgvector:pg17-bookworm@sha256:7ae6051efd0e60444282c27c7e141af07f322ce033300e727a49c3dd11075e38`；
- Candidate tables：`19`；
- Forced RLS tables：`19`；
- Baseline restore：`verified`；
- Artifact manifest SHA-256：`511643bb94c7e8b757997b7b7ca262c942ba86b837c011e2b098b7a2b711f1af`。

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

`deploy-shadow.sh` 还必须同时取得：

- `SHADOW_DEPLOY_APPROVED=YES`；
- `SHADOW_DATABASE_MIGRATION_APPROVED=YES`；
- `GOAL7_STATUS=complete`；
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
- 阈值评估器；
- Critical Freeze 和预授权回滚入口。

生成器只创建 `pending_real_run / simulated=false` 模板，不能把模板或补录数据当成七日运行证据。

## 7. Collector 许可留存修复

F 阶段自检发现并修复一个正式 Shadow 前必须关闭的问题：Collector 原实现虽然在网络前执行 Source Registry 准入，但仍会把 `summary_metadata` 或 `metadata_only` 来源的完整响应保存为 Base64。

修复后：

- `reference_only / metadata_only / summary_metadata` 的 Raw Snapshot 只保留 Hash、长度、来源和时间，不保存响应体；
- `metadata_only / reference_only` 的 normalized item 不保留摘要；
- 只有 `full_text` 或合法 `structured_data` 来源才保留对应 payload；
- 留存行为直接使用 Source Policy Decision 返回的 retention 约束。

Collector 测试由 `6/6` 增至 `7/7`，覆盖 metadata-only 不留正文、structured-data 可留结构化 payload 的正负验证。

## 8. 本地证据

- Shadow 包测试：`8/8`；
- Shadow 静态验证：通过；
- Collector 测试：`7/7`；
- Ontology Contract 测试：`41/41`；
- Shell 与 Node 语法检查：通过；
- Git diff whitespace 检查：通过。

## 9. Linux/amd64 Runtime 证据

手动 Workflow：`.github/workflows/p1-si-runtime-verify.yml`。

运行 `31416612677` 对已推送 Source Commit `c9909a8bad72b9db7761e7d2437c8788f604da12` 执行：

1. Ontology `41/41`、Collector `7/7`、Shadow `8/8` 和全部候选编译；
2. 构建 Collector Linux/amd64 镜像并取得不可变 Image ID；
3. 输出可复核镜像归档及 SHA-256；
4. 在固定 Digest 的 PostgreSQL/pgvector 镜像中执行生产 baseline migrations；
5. 应用候选 010/011；
6. 验证 19 张候选表全部启用并强制 RLS；
7. 从 candidate 前的 baseline dump 恢复新数据库，确认不存在 `strategic_intelligence` Schema 且 Foundation 仍完整；
8. 使用临时 Docker Volume，成功后删除容器和卷，不留下 root-owned 测试目录。

前两次 Workflow 分别暴露并修复了相对路径被 Docker 当作卷名、PostgreSQL 容器 UID 导致宿主测试目录无法清理两个真实问题。最终运行完整通过，不能用前两次失败中的局部成功替代最终证据。

## 10. 当前未完成

- 未取得公司来源合规审批；
- Goal 7 尚未在本 Goal 中证明完成；
- 尚未从目标部署 Commit 运行 `prepare-shadow-release.sh` 生成公司 QNAP 最终源码包、镜像包和 Release Manifest；
- 未连接公司 QNAP；
- 未部署 Orchestrator 或 Collector；
- 未开始七日 Shadow；
- 未执行真实 Freeze 或回滚。

因此 P1-SI-F 当前是“部署准备工程候选与 Linux/amd64 Runtime 预验证已完成，公司 QNAP 发布和真实 Shadow 尚未开始”，不能标记为生产完成。
