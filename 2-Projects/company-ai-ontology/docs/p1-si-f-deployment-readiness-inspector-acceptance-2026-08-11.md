# P1-SI-F 部署 Readiness 检查器验收

日期：2026-08-11
状态：`engineering_verified / production_not_deployed`

## 结论

P1-SI-F 已新增统一只读部署 readiness 检查器，并由 `deploy-shadow.sh` 强制调用。当前真实状态为：部署授权已记录，其余六项门禁仍阻断，因此 `deploymentEligible=false / requiredGate=WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH`。本轮没有部署、数据库迁移、容器启动或生产服务重启。

## 检查范围

检查器固定验证七项：

1. 当次 Shadow 部署授权；
2. Goal 7 状态；
3. Release Manifest、源码包和 Collector 镜像包的不可变校验；
4. 已审批 Source Registry 与 Collector Config；
5. P003 36 条最终实名审核；
6. 四个职能角色的成员真实登录权限验收与安全负责人接受；
7. Goal 7 `engineeringVerified=true / ownerAccepted=true` 验收证据。

任一输入缺失返回 `missing_input`；文件存在但机器验证失败返回 `validation_failed`；整体退出码为 `2`。输出不包含文件路径、审批正文、实名人员或 Secret。

## 当前真实门禁

| 门禁 | 状态 | 原因码 |
|---|---|---|
| 部署授权 | pass | `ok` |
| Goal 7 状态 | blocked | `goal7_not_complete` |
| 最终不可变发布包 | blocked | `missing_input` |
| 来源 Registry / Collector Config | blocked | `missing_input` |
| P003 最终审核 | blocked | `missing_input` |
| 成员真实权限验收 | blocked | `missing_input` |
| Goal 7 Owner Acceptance | blocked | `missing_input` |

当前汇总：`passedGateCount=1 / blockedGateCount=6 / deploymentEligible=false`。

## 工程验证

- Shadow 包：`32/32`；
- Ontology Contracts：`60/60`；
- Collector：`7/7`；
- `npm run validate`：通过；
- Node 语法、Shell 语法和 Git whitespace：通过；
- readiness 正向测试：七项有效输入全部通过；
- readiness 负向测试：全部缺失、Goal 7 文件无效、仅 API 配置但缺成员真实体验均失败关闭；
- `deploy-shadow.sh` 静态断言：必须调用 `inspect-deployment-readiness.mjs`，且不得操作 Agent Core、H-Lite、Connector、Gateway、Postgres、Redis 或 Qdrant。

## 生产零副作用复核

在线只读复核公司 QNAP：

- 身份：`PRNas / TS-X65 / 192.168.61.18`；
- 战略情报目录：不存在；
- 战略情报容器：不存在；
- Foundation 容器：13 个，异常 0，累计 `restart_count=0`；
- ActionIntent：总数 3，`pending/leased=0`；
- Delivery Outbox：总数 12，`pending/leased=0`；
- `strategic_intelligence` 数据库 Schema：不存在。

以上证明本轮只增强部署门禁，没有产生正式 P2、员工投递、ERP/社媒写回、候选 SQL 迁移或生产运行副作用。

## 后续关闭条件

1. 完成 8 个来源的实名许可与合规审核并生成最终 Registry/Collector Config；
2. 完成 P003 36 条联合 DRI 最终审核并全部保持 `inactive`；
3. 由四名职能角色成员分别完成真实登录权限验收，并由安全负责人显式接受；
4. 完成 Goal 7 工程验证与川哥人工验收；
5. 从届时已推送的干净 Commit 重建 Manifest `1.2.0` 不可变发布包；
6. 再次运行 readiness，只有七项全绿后才能执行 Shadow 部署。
