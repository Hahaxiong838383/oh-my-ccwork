# P1-SI 首次内部运行 Evidence 工程验收

状态：`ACCEPTED_FOR_INTERNAL_ENGINEERING_NOT_PRODUCTION_SHADOW`

本文记录 Artifact `9096846710` 的历史工程证据。该 Artifact 因 QNAP 分隔符兼容问题拒绝，后续 Artifact `9107441466` 又因非原子 config/env 切换风险被取代。当前最终候选为 Commit `0342fcd39`、Workflow `31508346323`、Artifact `9108034290`；任何旧授权均不得继承。

## 结论

首次内部一次性采集的机器验收链已完成工程实现并在公司 QNAP 实际通过。Artifact `9108034290` 的真实 Collector 对三个公开来源各采集 20 条，共 60 条；全部 Raw Snapshot 只保存 Hash，正文为 0，且机器 Evidence 明确 `eligibleForProductionShadow=false`。

## 已完成

- 新增 `internal-engineering-run-evidence` JSON Schema、编译器和验证器；
- 每次运行强制验证 3 个选定来源全部成功、每来源最多 20 条；
- 遍历全部 Raw Snapshot，要求 `payloadRetention=hash_only`、`bodyBase64=null` 且内容 Hash 合法；
- 运行前后记录 Foundation 13 个容器的镜像、状态、健康、restart、端口指纹；
- Foundation 指纹明确排除正常完成并退出的 Compose 一次性 `foundation-init`，只统计 13 个长期运行服务；战略情报临时容器仍按全量容器检查；
- 运行后要求战略情报临时容器、项目网络和发布端口全部归零；
- 数据库审计要求正式 P2、员工投递、ERP 写回、社媒写回和因果激活全部为 0；
- Collector 非零退出、证据缺失、Foundation 漂移、临时资源泄漏或业务副作用都会生成结构化失败 Evidence；
- 所有内部 Evidence 固定 `countsTowardProductionShadow=false / eligibleForProductionShadow=false`。

## 工程证据

- Source Commit：`c0d9ce92fb94d09b2c46ae1e019c166da8b32468`；
- Contracts：`61/61`；
- Collector：`9/9`；
- Strategic Intelligence：`76/76`；
- Runtime Workflow：`31480010967`；
- Artifact：`p1-si-runtime-c0d9ce92fb94d09b2c46ae1e019c166da8b32468`；
- Artifact ID：`9096846710`；
- Collector Image ID：`sha256:9f7d03ba5eca8e1ca1654e17272099cc0bfdebdd07bc303ed04faec7d8b1776a`；
- 010/011、19/19 强制 RLS、Domain 二次幂等、ACL fail-closed、baseline restore 通过；
- Artifact `SHA256SUMS` 下载后全量通过。

## 当前边界

- 公司 QNAP 内部 Runtime 已绑定 Commit `0342fcd3991fc88e32f1f68750b837112717db67`；
- 当前 QNAP 已有 1 次成功内部 Collector 和 1 次 Collector 启动前网络接线失败 Evidence；成功运行不计入正式生产 Shadow；
- 战略情报数据库迁移、正式 Orchestrator、员工投递、正式 P2、ERP/社媒写回和因果激活仍为 0；
- 本 Artifact 是工程候选，不包含来源最终合规批准、P003 最终审核、四角色 UAT 或 Goal 7 Owner Acceptance；
- 本工程验收不等于生产部署、七日生产 Shadow 或 Goal 完成。

## 下一门禁

1. ✅ Artifact `9108034290` 已更新到公司 QNAP 内部 Runtime；
2. ✅ 未授权运行门禁实机负测通过；
3. ✅ 首次内部一次性采集通过，Evidence accepted；
4. 下一步转入来源/P003 人审、四角色 UAT 和 Goal 7；如需第 2～3 天内部排错，仍需新的运行授权。
