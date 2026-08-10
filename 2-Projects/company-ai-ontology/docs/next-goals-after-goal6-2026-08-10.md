# Goal 6 验收后的实施顺序

更新时间：2026-08-10（Asia/Shanghai）

## 当前已关闭基线

- Goal 6-A：`engineering_verified=true`、`owner_accepted=true`。
- QNAP：Schema `3.3.0`、Registry `in_sync`、Domain Connector `2026-08-10.1`、Agent Core `2026-08-10.2`。
- 领域读模型：ERP 95、Operations 38、Device 57、Market 369。
- H 控制面：`v1.58.2`，Source Commit `8f63fb9`，50 个运行文件 `in_sync`，真实 Chrome `99/99`。
- 仍关闭：整库导入、员工规模放量、ERP/社媒写回、ERP M4、MediaCrawler、Capability Governance 激活、真 3D。

## 推荐顺序

### ✅ Task 6-R：Release Provenance Guard（已完成）

目标：防止再次出现“版本号正确、生产源码错误”。

交付：

1. H `/healthz` 或受保护状态接口返回脱敏 `sourceCommit`、`releaseId`、`fileSetHash`。
2. 发布脚本在重启后对账目标文件 SHA-256，并把结果写入只读发布清单。
3. 管理看板显示 Runtime 与 Git 是否一致，但不暴露主机路径或凭据。
4. 制造一个文件漂移负测，确认状态变为 `drifted`；恢复后回到 `in_sync`。

结果：既有 `v1.58.1` 完成零重启补签，随后 `v1.58.2` 走完整发布链上线；停启跨 1 秒、`NRestarts=0`，回滚备份与 99 项浏览器验收齐备。未来 H 发布继续按本门禁执行。

### Goal 7：P1-PROD-READINESS

目标：把个人临时资源依赖和群组权限语义补成公司可运营基线。

范围：

1. 公司专用 CPA 账号/Key，替换个人 CPA 依赖。
2. 同厂双账号或双路由冗余、熔断、预算与真实模型读回。
3. `department/openchat`、`chat/group` Principal 映射。
4. 群组会话证据、用途、撤权、成员变化和 fail-closed 语义。
5. 只做小范围合成资源 Canary，不执行产品研究部整库导入。

完成判据：主路故障可切备用、个人凭据依赖为零、群组授权正负/撤权验收通过、无越权正文泄露。

### Goal 3：10 名真实员工 Canary

前置：Goal 7 完成。

范围：10 名真实员工、唯一 DRI、一条真实 P2；覆盖私聊、多人 @、并发会话、失败重投、任务下发、成果提交和 DRI 验收。

完成判据：员工权限无越界、任务与成果可追溯、真实业务结果由 DRI 接受；失败样本保留并退役。

### Goal 8：24 小时容量与 20/50 人扩容

前置：Goal 3 通过。

范围：24 小时持续观测、队列延迟、H-Lite lease/fencing、Worker 分池、故障恢复、20/50 人容量模型；300 人仅做容量规划，不直接放量。

完成判据：并发、排队、失败率、恢复时间和资源上限均有实测数据，形成 20/50 人分阶段放量决策卡。

## 后续独立 Goal

1. PESTIM Strategic Intelligence：43 个维度、108 个 GoalFacet 和 4644 个 draft Impact Hypothesis；持续采集外部情报，生成日/周/月/季/半年/年度报告。Schema/Source Registry 可只读并行规划；QNAP Shadow 和自动 P2 分别审批。
2. 受控知识库批量导入：仅在群组权限语义和真实 Canary 通过后审批范围与窗口。
3. Capability Governance 激活：从 `contract_only` 进入提案、评审、发布、回滚闭环。
4. Task Compiler / A2A：经营目标自动拆解与个人 Bot 协作，但保留 DRI 批准和 Action Gateway。
5. 真 3D：以大规模节点、跨域层级和时间演化的真实可视化瓶颈作为启动条件。
6. ERP/社媒写回：独立安全 Goal；不包含 ERP M4 或 MediaCrawler 风控恢复的默认授权。
