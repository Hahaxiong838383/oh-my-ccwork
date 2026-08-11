# P1-SI 内部工程验证部署交接单

日期：2026-08-11（Asia/Shanghai）

状态：`engineering_verified / qnap_preflight_verified / immutable_release_pending / deploy_authorization_pending`

## 1. 当前结论

内部工程验证模式已完成本地开发、负向门禁、真实公网 Smoke、完整临时目录部署脚本演练和公司 QNAP 只读预检，但尚未部署。

本轮“继续”只用于继续开发与只读预检，不外推为内部部署、单次真实运行或真实回滚授权。

## 2. 公司 QNAP 只读真值

- 主机：`PRNas`；
- 型号：`TS-X65`；
- 地址：`192.168.61.18`；
- Foundation：`/share/CACHEDEV1_DATA/ai-ontology/foundation`；
- Foundation 容器：13 个运行，健康检查容器均为 healthy；
- Foundation 累计 `restart_count=0`；
- 部署账号：`Rayman.chen / uid=1000 / gid=100`，满足非 root Runtime 要求；
- `/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence`：不存在；
- 战略情报容器：0；
- 内部工程验证目录：不存在；
- 热数据卷和备份卷空间充足。

## 3. 部署动作

获得单独部署授权后，仅执行：

1. 从最终已推送 Commit 构建 Linux/amd64 Collector 镜像和不可变 Release Manifest；
2. 将不可变发布包和内部 Runtime 复制到公司 QNAP 受控目录；
3. 再次执行公司 QNAP 五元组和发布 Hash 校验；
4. 加载 Collector 镜像；
5. 创建独立 `internal-engineering` 配置、状态和报告目录；
6. 以 QNAP 部署账号 UID/GID 编译 Compose，确保状态与报告 bind mount 可写且容器保持非 root；
7. 校验完整项目包内的 Runtime Validator 依赖，但不启动 Orchestrator 或 Collector；
8. 保存上一版内部 Runtime 备份指针。

本地完整演练已使用真实源码包、虚拟镜像包和假 Docker 跑通上述部署脚本，证明安装后的 Runtime Validator、非 root UID/GID 和 0600 配置权限有效；Docker 调用仅为镜像加载、镜像检查和 Compose config，容器启动、数据库迁移、Dispatcher 安装及既有服务重启均为 0。

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

内部部署 Readiness 当前仅剩：

1. cc 选择性提交并推送本 Goal 文件；
2. 从最终 Commit 构建并校验不可变发布包；
3. 川哥明确授权本次 `internal_engineering_shadow` 部署。

正式生产门禁继续后补：8 来源最终审批、P003 最终审核、四角色真实权限 UAT、Goal 7、连续七个上海自然日 `production_shadow` 和 Owner Acceptance。

## 7. cc 选择性收口

主工作区同时存在其他项目和 Agent 改动，禁止 `git add .` 或 `git add -A`。cc 收口时只检查并选择性暂存：

- `.claude/skills/company-ai-ontology/SKILL.md`；
- `2-Projects/company-ai-ontology/packages/ontology-contracts/`；
- `2-Projects/company-ai-ontology/services/intelligence-collector/`；
- `2-Projects/company-ai-ontology/deploy/qnap/strategic-intelligence/`；
- `2-Projects/company-ai-ontology/deploy/qnap/candidate-migrations/010-pestim-strategic-intelligence.sql`；
- `2-Projects/company-ai-ontology/README.md` 和本 Goal 的 `docs/p1-si-*`、`docs/pestim-strategic-intelligence-architecture-2026-08-10.md`、`docs/next-todos.md`；
- `0-System/RECENT_EVENTS.md`、`0-System/memory-items.md` 中本次 P1-SI 增量。

暂存后重新执行专项 Secret 扫描、`git diff --cached --check`、Contracts `61/61`、Collector `9/9` 和 Shadow/Readiness/Goal Completion `48/48`，并确认暂存区不含 KidsHub、Geo Engine、TTS、Xray、Scheduler 或其他并发任务文件。
