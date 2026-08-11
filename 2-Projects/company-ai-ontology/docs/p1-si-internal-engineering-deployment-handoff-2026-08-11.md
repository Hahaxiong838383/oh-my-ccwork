# P1-SI 内部工程验证部署交接单

日期：2026-08-11（Asia/Shanghai）

状态：`engineering_verified / immutable_release_verified / internal_runtime_prepared / first_run_not_authorized`

## 1. 当前结论

内部工程验证 Runtime 已从已推送 Commit `a7aeae25e` 的 GitHub Actions 不可变 Artifact 部署到公司 QNAP。当前只完成镜像加载、配置准备、完整项目包安装和 Compose config 校验，没有启动 Orchestrator/Collector、没有迁移数据库、没有新增端口、没有重启 Foundation。

本次部署授权已执行完毕，但不外推为首次真实采集、生产 Shadow、生产数据库迁移、Foundation 重启或真实回滚授权。

## 2. 公司 QNAP 只读真值

- 主机：`PRNas`；
- 型号：`TS-X65`；
- 地址：`192.168.61.18`；
- Foundation：`/share/CACHEDEV1_DATA/ai-ontology/foundation`；
- Foundation 容器：13 个运行，健康检查容器均为 healthy；
- Foundation 累计 `restart_count=0`；
- 部署账号：`Rayman.chen / uid=1000 / gid=100`，满足非 root Runtime 要求；
- `/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence`：已创建受控 Release、Internal Runtime 和 `internal-engineering` 目录；
- 战略情报容器：0；
- 内部工程验证目录：Runtime 已准备，状态和报告文件数为 0；
- 热数据卷和备份卷空间充足。

## 3. 已执行部署动作

`2026-08-11` 已执行：

1. 从最终已推送 Commit 构建 Linux/amd64 Collector 镜像和不可变 Release Manifest；
2. 将不可变发布包和内部 Runtime 复制到公司 QNAP 受控目录；
3. 再次执行公司 QNAP 五元组和发布 Hash 校验；
4. 加载 Collector 镜像；
5. 创建独立 `internal-engineering` 配置、状态和报告目录；
6. 以 QNAP 部署账号 UID/GID 编译 Compose，确保状态与报告 bind mount 可写且容器保持非 root；
7. 校验完整项目包内的 Runtime Validator 依赖，但不启动 Orchestrator 或 Collector；
8. 保存上一版内部 Runtime 备份指针。

不可变发布来源为 Workflow Run `31473316988`、Artifact `9094240704`；源码、镜像、Manifest 和 PostgreSQL Runtime 证据 Hash 全部通过。公司 QNAP 实际部署输出为 `container_started=0 / database_migration_count=0 / existing_service_restart_count=0`。

部署后 Runtime Validator 与内部 Readiness 均通过：3 个来源、6 条 P003 样例、8 个 Registry 来源继续 `paused`，`productionApprovalSatisfied=false / countsTowardProductionShadow=false`。Foundation 13 个服务前后指纹一致、异常 0、restart 0；战略情报项目容器、网络和发布端口均为 0。

## 4. 影响评估

| 项目 | 预期影响 |
|---|---|
| 既有 Foundation 容器重启 | 0 |
| Agent Core / H-Lite / Connector / Gateway 重启 | 0 |
| 数据库迁移 | 0 |
| 新常驻容器 | 0 |
| 新公网或局域网端口 | 0 |
| 员工消息、正式 P2、ERP/社媒写回 | 0 |
| 部署准备耗时 | 约 3～5 分钟 |
| 既有业务中断 | 预期 0 秒 |

加载镜像和解包时会产生短时磁盘 I/O；不会触碰现有数据库 Schema、现有服务配置或员工 Bot。

## 5. 后续独立授权

部署完成不等于允许运行。第一次真实采集必须另行授权：

- 运行形态：一次性临时 Worker；
- 资源上限：`0.5 CPU / 512 MiB / 128 PIDs`；
- 来源：3 个确定 URL；
- 最大结果：每来源 20 条；
- 保存：`reference_only / hash_only`；
- `PUBLISH=false`；
- 预计单次运行：1～3 分钟；
- 运行完成后容器自动删除。

真实回滚同样需要独立授权。回滚只撤下内部 Runtime 目录并恢复上一版内部包，不恢复数据库、不停止既有服务，预计 1～2 分钟，既有业务中断预期 0 秒。

## 6. 当前关闭门禁

内部部署 Readiness 已 `4/4 pass`。当前下一门禁是首次真实采集的独立授权；在未授权前，状态和报告文件保持为 0。

正式生产门禁继续后补：8 来源最终审批、P003 最终审核、四角色真实权限 UAT、Goal 7、连续七个上海自然日 `production_shadow` 和 Owner Acceptance。

## 7. 证据

- 不可变源码 Commit：`a7aeae25e414b570cab8ff1fdfbdc12d5d027dc5`；
- Runtime Workflow：`31473316988`；
- 部署证据：`deploy/qnap/strategic-intelligence/evidence/qnap-internal-engineering-deployment-2026-08-11.json`；
- 生产 Readiness 继续 `deploymentEligible=false / WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH`，当前 7 个生产门禁全部失败关闭。
