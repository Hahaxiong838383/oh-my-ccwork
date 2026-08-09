# Goal 5 决策—实践闭环生产验收报告

日期：2026-08-09（Asia/Shanghai）

## 结论

Goal 5 `P0-DEC + Decision/P2/Task/Action/Verification/Learning` 已在公司 QNAP 完成生产部署并切换为 `active`。公司大脑已从“可解释回答”扩展为可回放的决策—实践闭环，但本轮仍只做一名真实 DRI、一个受控 P2，不代表 10 名真实员工 Canary 已完成。

Goal 3 继续延后。下一阶段推荐先做 Goal 6：以只读方式接入 ERP M3、社媒归一化结果和产品/设备领域骨架，同时深化公司大脑工作逻辑的经营可视化；大框架稳定后再启动 10 名真实员工 Canary。

## 生产锚点

- 资产：公司 QNAP `prnas` / `prnas-pub`，型号 `TS-X65`，地址 `192.168.61.18`。
- 项目根：`/share/CACHEDEV1_DATA/ai-ontology/foundation`。
- Schema：`3.2.0`。
- Ontology Hash：`ffa8943255b93b61adcfe08dc5e0c524cfeb88c9c51bb312a29ac56f37f9136e`。
- Active 元素：48 Object、35 Link、6 Function、3 Action、8 Policy、11 Constraint，共 111 个。
- Agent Core：`2026-08-09.2`。
- Action Gateway：`2026-08-09.2`。
- Work / Practice Protocol：`1.1.0 / active`。
- Ontology Definition Source Commit：`e6a98c6dc`；本轮没有伪造新的 Definition 来源。
- Runtime Release Commit：`19793e100`；Agent Core、Action Gateway 和 Registry 构建上下文已切换到版本化 release。
- Operations Guard Commit：`f807eca84`；用于安全退役失败 Canary，拒绝退役 `goal_verified` Lineage。
- H-Lite Source：`b3f5ed2`；员工私人 Bot 未迁移、未切换。

## 单 DRI 决策—实践闭环

受控生产 P2 完成以下链路：

```text
Decision Proposal
  -> DRI Approval
  -> P2 Binding
  -> Single Task
  -> Action Intent / Dry-run / Approval / Execute / Readback
  -> Verification
  -> Learning Proposal
```

最终 Decision Lineage：

| 指标 | 结果 |
|---|---:|
| Task | 1 |
| Action | 1 |
| Verification | 1 |
| Learning | 1 |
| 技术执行成功 | true |
| 业务结果成功 | true |
| 经营目标成功 | true |
| Learning 状态 | proposed |

Learning 只形成提案，没有自动修改 Ontology、Prompt、流程或业务系统。

## 失败尝试审计

- 失败演练 `a–d` 没有删除，4 个 WorkCase 均改为 `blocked` 并追加 `canary_attempt_retired` 事件。
- 已形成 Decision 的 `c–d` Lineage 均标记为 `retired`；失败尝试待执行状态为 0。
- `d` 中已接受的任务保留为历史事实，但其上游 Decision 已 `superseded`，不能冒充正式成功 P2。
- Canary 脚本新增失败退出自动退役；专用退役脚本在目标 Lineage 已 `goal_verified` 时强制拒绝。

## 本轮修复

1. 扩展 WorkCase 状态约束，允许 Decision、Plan、Execution、Verification、Learning 的真实状态推进。
2. 为 PostgreSQL `jsonb_build_object` 的多态参数增加显式 `text` 类型，消除生产类型推断错误。
3. Decision 审批重放只读回同一结果，不重复推进 WorkCase 或追加重复阶段事件。
4. 演示目标初始化移到 Action Gateway；Agent Core 不再拥有目标系统初始化权限。
5. `verify.sh` 的历史任务事件计数改为只统计指定演示 P2，避免新 P2 让旧验收器误报。
6. Practice active 门禁要求至少一条三层结果均为 `true` 的 `goal_verified` Lineage。
7. 失败或撤销的 Decision Lineage 显式显示为 `retired`，不再占据 `plan_pending` / `execution_pending`。

## 验收结果

- Agent Core `34/34`、Action Gateway `2/2` 通过；Shell 语法和 staged secret 扫描通过。
- 公司 QNAP 完整 `verify.sh` 通过：Registry `in_sync`、Schema `3.2.0`、111 个 active 元素、Practice `active`、`goal_verified_lineages=1`。
- WorkCase/Decision/Task/Action/Verification/Learning 重启后仍可读；Agent Core、Action Gateway、Registry、H-Lite、Gateway `restart_count=0`。
- 失败演练：`retired_work_cases=4`、`retired_lineages=2`、`pending_failed_lineages=0`。
- 最近服务日志中，已配置敏感值命中 0，通用 Bearer/API Key/App Secret 模式命中 0。
- QNAP 唯一 LAN 暴露仍为 `192.168.61.18:19080`；Postgres、Qdrant、Redis、Prometheus 未新增宿主机端口。
- H 控制面 `v1.53.0` 显示 9/9 组件、P0-DEC 绿色、Practice active、Goal Verified 1；真实浏览器控制台错误、页面错误、失败请求和横向溢出均为 0。

## 未改变的边界

- 未执行 10 名真实员工 Canary，未批量通知员工。
- 未迁移、未切换员工私人 Bot 的飞书 App、订阅或会话。
- 未导入产品研究部整库。
- 未启用真实 ERP 或社媒写回；爱视可 ERP M4 和 MediaCrawler 风控恢复继续禁止。
- 公司 Agent 仍是非特权前门；员工身份操作继续提示使用员工自己的 Bot。

## 下一 Goal 推荐

推荐启动 `Goal 6：P1-DOMAIN + Company Brain Operating Model v1`：

1. 固化经营主干：Objective → Metric → Decision → P2 → Task → Action → Outcome → Verification → Learning。
2. 只读接入 ERP M3 已验收事实，不改变 ERPNext/Frappe 事务真源。
3. 只读接入社媒系统归一化结果，不恢复 MediaCrawler、不把 HTTP 200 当业务成功。
4. 实例化 Product/SKU/BOM/Firmware/SN/DeviceState 与 Market Signal 的最小对象，不一次建全企业本体。
5. H 控制面增加 Goal/Decision/P2/Outcome 经营视图、失败/退役 Lineage、证据时效和未知/冲突，不展示隐藏思维链。
6. 完成 Goal 6 后再评估是否启动 Goal 3 的 10 名真实员工 Canary。
