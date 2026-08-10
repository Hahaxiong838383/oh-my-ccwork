# P1-SI-C 公司版前沿资讯雷达包工程验收

日期：2026-08-10（Asia/Shanghai）

## 1. 结论

公司版 Intelligence Collector 的机器契约、JSON Schema、独立运行目录协议、oneshot Worker、Source Registry 前置准入、去重、原子产物、last-good 失败回退和固定基础镜像配方已完成：

- `engineering_verified=true`；
- `package_validated=true`；
- `image_recipe_verified=true`；
- `image_build_verified=false`；
- `production_deployed=false`；
- `publish=false`。

当前开发机没有 Docker、Podman、Buildah 或 Nerdctl，因此不能声称 OCI 镜像已经实际构建。P1-SI-C 交付的是可构建、可测试、无个人运行时依赖的部署包；镜像实构和资源验收进入 P1-SI-F 的隔离构建环境，不得借机连接公司 QNAP 生产目录。

## 2. 对个人站雷达的复用范围

只复用模式：

- Horizon 固定 Commit、oneshot pipeline、阶段产物、去重、last-good；
- Theory Radar 的 RSS/API、候选快照、失败不覆盖和 `PUBLISH=false`；
- Horizon 上游固定 `1e2fdc7ccb177f33c59aef2082c4093e1e82b22c`，许可证已核对为 MIT；
- 本地 Horizon/Theory Radar 关键文件保存 SHA-256 锁，后续漂移必须重新审计。

没有复制或依赖：

- 个人站数据目录；
- 个人报告目录；
- 个人账号、API Key 或 Webhook；
- Next.js 展示层；
- 个人站定时任务或生产进程。

## 3. 公司独立身份

Collector Contract 固定独立 namespace：

| 资源 | Namespace |
|---|---|
| Account | `company-ai-ontology-strategic-intelligence` |
| Credential | `company-intelligence` |
| Database | `company_strategic_intelligence` |
| State | `company-intelligence-collector` |
| Report | `company-intelligence-reports` |
| Feishu Outlet | `company-intelligence-feishu-outlet`，当前 disabled |

Secret 仅允许通过后续批准的公司 Secret Store 或 `0600` 文件注入；配置、日志和报告不保存 Secret。

## 4. 运行流程

```text
读取配置
  → 校验独立目录与 publish=false
  → 校验 Registry Snapshot
  → 对全部 sourceKey 先生成 allow/deny 决策
  → 任一来源拒绝则在网络前终止
  → HTTPS 请求 + 超时 + 响应体上限
  → raw snapshot + 内容 Hash
  → RSS/JSON 标准化
  → URL/item/content Hash 去重
  → 原子写 run/items/candidate
  → 成功才更新 last-good
```

## 5. JSON 契约

已提供：

- `collector-config.schema.json`；
- `normalized-item.schema.json`；
- `collector-run.schema.json`；
- `company-intelligence-collector-v1.json`；
- `reuse.lock.json`。

Run Contract 固定保存：run ID、Collector 版本、起止时间、publish 状态、Source Registry 版本/Hash、准入决策数、来源数、Raw Snapshot 数、Item 数、重复数和错误码。

## 6. 测试证据

执行：

```bash
cd 2-Projects/company-ai-ontology/services/intelligence-collector
npm test
npm run validate
sh -n scripts/build-image.sh
```

结果：

- Collector 测试 `7/7` 通过；
- 配置与候选 Registry 验证通过；
- paused 来源在网络请求前失败，网络调用数为 0；
- approved fixture 可生成 Raw Snapshot、2 条唯一 Item 和 last-good；
- 1 条重复 URL 被去重；
- HTTP 失败不覆盖已有 last-good；
- 超出响应体上限时不生成 candidate report；
- Horizon/Theory Radar 锁文件 Hash 对账通过；
- Dockerfile 固定 Base Digest、非 root 用户和 Source Commit label；
- 构建脚本 Shell 语法通过。
- Source Registry retention 已成为硬约束：metadata/reference/summary 来源不再保存完整响应体，metadata/reference item 不保留摘要，只有获批 full-text 或 structured-data 才保留对应 payload。

## 7. 未完成及关闭门禁

- 没有真实启用来源；
- 没有实际构建 OCI 镜像；
- 没有连接 Postgres、Redis 或 Qdrant；
- 没有运行 Timer 或常驻 Orchestrator；
- 没有连接公司 QNAP；
- 没有飞书发布；
- 没有模型分析；
- 没有生成正式 P2、员工任务或业务写回。

## 8. 下一步

1. P1-SI-D 建立 Raw Snapshot、Observation、Signal、Evidence、Impact Assessment 和 ReportRun 的 Postgres 真源与双时间契约；
2. P1-SI-E 建立多周期报告输入和投影契约；
3. P1-SI-F 在隔离构建环境实际构建镜像、记录 digest、限制 CPU/内存并形成 QNAP Shadow 准备包；
4. 公司合规 DRI 审批 Source Registry 后，才能在 Shadow 中访问对应来源。
