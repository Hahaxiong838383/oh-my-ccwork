# P1-SI 内部工程验证模式

日期：2026-08-11（Asia/Shanghai）

状态：`engineering_verified / deployment_not_authorized / production_gates_deferred`

## 1. 决策

P1-SI 拆成两个互不替代的运行模式：

1. `internal_engineering_shadow`：当前内部搭建与验证使用，目标是尽早发现采集、保留、报告和运行稳定性问题。
2. `production_shadow`：后续正式上线前使用，继续执行来源实名审批、P003 最终审核、成员真实权限 UAT、Goal 7、不可变发布包、七个上海自然日 Shadow 和 Owner Acceptance。

内部模式的任何运行、样例审核或 Owner Smoke Test 都不能满足正式生产门禁，也不能计入七日生产 Shadow。

## 2. 当前内部范围

- 来源：仅 3 个无需登录、无需凭据、无需反自动化绕过的公开端点；每个内部样本使用确定 URL，不允许把 `{owner}/{repo}` 等模板直接交给 Worker。
- 保存：只允许 `reference_only`，最长保留 3 天；响应正文只保存 Hash、长度、来源和时间，不保存 Base64 原文。
- P003：六类各选 1 条，共 6 条；状态固定为 `sample_reviewed_keep_inactive / inactive`。
- 周期：1～3 个自然日，仅用于工程排错。
- 输出：本地运行产物、内部报告草稿和管理员 Smoke Test；不产生员工侧投影。
- 副作用：正式 P2、员工投递、ERP 写回、社媒写回、因果激活全部为 0。

## 3. 后补而非删除的门禁

以下事项统一记录为 `deferred_before_production`：

- 8 个来源的最终许可、保留策略和合规审批；
- 36 条 P003 的语义重写、正反证据、指标、DRI 和最终决定；
- 四个职能角色成员真实登录权限 UAT；
- Goal 7 工程证据与 Owner Acceptance；
- 最终已推送 Commit 对应的不可变发布包；
- 七个真实上海自然日 `production_shadow`；
- 正式生产 Owner Acceptance。

现有飞书负责人和角色映射继续保留，但当前不要求相关员工操作。

## 4. 审核负担优化

正式阶段采用风险分级，不再要求所有负责人审核所有关系：

| 等级 | 场景 | 审核方式 |
|---|---|---|
| L0 | 内部样例、无业务副作用 | 系统门禁 + 管理员 Smoke Test |
| L1 | 低风险公开资料、只读参考 | 一名领域负责人 |
| L2 | 跨领域经营判断 | 主负责人 + 一名会签人 |
| L3 | 儿童隐私、版权、全文保存、自动任务或业务写回 | 领域负责人 + 合规/安全 + Owner |

正式 P003 首批按领域拆分，每位负责人只审核自己的筛选视图和少量高价值关系，不审核全部 36 条。

## 5. 机器门禁

内部模式由以下资产约束：

- `config/internal-engineering-shadow-plan.json`：3 个来源、6 条 P003 样例和后补门禁的单一配置。
- `validate-internal-engineering-shadow-plan.mjs`：拒绝来源扩张、全文保存、超过 3 天保留、关系激活和任何业务副作用。
- `evaluateInternalEngineeringSourcePolicy`：允许候选 Registry 中的安全样例来源，但决策明确记录为 `INTERNAL_ENGINEERING_PROVISIONAL_ALLOW`，同时记录 `productionApprovalSatisfied=false`；运行端点必须匹配官方路径，GitHub 还必须匹配 Registry 的仓库白名单且单次最多请求 20 条。
- `compile-internal-engineering-runtime.mjs`：生成候选 Registry、Collector 配置、Plan 和内容寻址 Manifest；所有正式许可与合规状态仍保持 `pending / paused`。
- `inspect-internal-engineering-readiness.mjs`：内部部署仍要求当次明确授权、公司 QNAP 五元组预检和不可变发布包。
- 正式 `inspect-deployment-readiness.mjs` 不读取内部模式证据，仍会因正式审批、UAT 和 Goal 7 缺失而失败关闭。

## 6. 当前工程证据

- Ontology Contracts：`61/61`；
- Intelligence Collector：`9/9`；
- Strategic Intelligence Shadow / Readiness / Goal Completion：`48/48`；
- `2026-08-11` 本机真实公网采集：arXiv、Federal Register、GitHub 白名单仓库均返回 `200`，各解析 20 条，共 60 条；
- 三个 Raw Snapshot 均为 `payloadRetention=hash_only / bodyBase64=null`，只保存 Hash、长度、来源与时间；
- 已修复 GitHub URL 模板不能直接执行的问题，改为 Plan 内确定 URL + Registry 仓库白名单双重约束；
- 已修复内部部署包仅复制部署目录导致 Validator 依赖缺失的问题，真实打包布局回归通过；
- 已修复固定容器 UID 对 QNAP bind mount 不可写的问题，Compose 使用已验证的非 root 部署账号 UID/GID；
- 已用临时 QNAP 目录、真实源码包、虚拟镜像包和假 Docker 执行完整部署脚本，安装后 Runtime Validator 可运行，配置权限为 0600，Docker 调用仅为 `load / image inspect / compose config`；
- 非计划来源在网络请求前拒绝；
- 内部模式不能满足正式生产 readiness；
- Runtime 编译后 8 个来源继续 `paused / license pending / compliance pending`；
- `2026-08-11` 公司 QNAP 只读预检通过：`PRNas / TS-X65 / 192.168.61.18 / Foundation root` 一致，部署账号为 `uid=1000 / gid=100`，13 个 Foundation 容器运行、累计 `restart_count=0`，战略情报目录、内部运行目录和相关容器均不存在；
- 本轮尚未部署、未迁移、未启动服务、未重启；不可变发布包和本次内部部署授权仍是独立门禁。

## 7. 川哥后续只需完成

1. 在收到部署影响、预计时间和回滚说明后，单独授权本次公司 QNAP 内部模式部署。
2. 部署后完成一次管理员 Smoke Test，确认“基本可用”或记录问题。
3. 正式上线决策时，再启动分级来源审批、P003 审核和成员权限 UAT。

内部模式确认不构成 QNAP 部署、数据库迁移、服务启动、重启或真实回滚授权。
