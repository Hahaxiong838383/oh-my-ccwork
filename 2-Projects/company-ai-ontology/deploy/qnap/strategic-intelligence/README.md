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

具备容器运行时且 Git 已干净推送后，才能执行：

```bash
scripts/prepare-shadow-release.sh
```

该脚本会验证 Git `HEAD` 等于 upstream、运行测试、构建 Collector 镜像、执行 010/011 候选迁移隔离验证、验证 baseline restore，并生成不可变源码包、镜像包和 Manifest。

实际部署入口是 `scripts/deploy-shadow.sh`，但它同时要求：

- `SHADOW_DEPLOY_APPROVED=YES`；
- `SHADOW_DATABASE_MIGRATION_APPROVED=YES`；
- `GOAL7_STATUS=complete`；
- 已审批 Source Registry 和 Collector Config；
- 完整且 Hash 一致的不可变发布包。

部署脚本只应用 010/011 战略情报候选迁移并启动 `intelligence-orchestrator`，不会执行任何既有核心服务的 `up`、`restart` 或 `stop`。
Dispatcher 使用 QNAP 既有 crontab 每分钟检查队列，安装过程不会重启 cron daemon。

## 当前明确待验

当前开发机没有 Docker、Podman、Nerdctl、Buildah 或本地 Postgres，因此以下内容尚未执行：

- Collector 镜像真实构建；
- 010/011 候选 SQL 的真实 PostgreSQL Runtime 验证；
- baseline dump/restore；
- 公司 QNAP Compose config；
- 公司 QNAP Shadow 部署；
- 七个真实自然日 Shadow。

这些项目不得用静态测试冒充完成。
