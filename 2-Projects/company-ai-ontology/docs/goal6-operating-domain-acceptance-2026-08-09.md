# Goal 6-A：Company Brain Operating Model + P1-DOMAIN 验收记录

验收日期：2026-08-09（Asia/Shanghai）

## 当前结论

Goal 6 的 QNAP 数据面、Operating Model、P1-DOMAIN 只读骨架、跨域演示链和 3D-ready 数据协议已经完成当前层级生产验收。H 控制面 `v1.55.1` 已于 `2026-08-09 23:06:38 CST` 上线，真实 Chrome `59/59` 通过；`2026-08-09 23:19 CST` 又通过 Mini 既有安全密码助手恢复公司 QNAP 只读连接并复跑完整 `verify.sh`。当前剩余生产缺口只有 Domain Connector 旧版回滚与新版恢复演练；该演练会切换 QNAP 生产容器，必须另获当前变更窗口明确授权。

## 生产真值

| 项目 | 当前真值 | 状态 |
|---|---|---|
| 公司 QNAP | 公司资产五元组在线匹配，13 容器健康 | 绿色 |
| Ontology Schema | `3.3.0` | 绿色 |
| Registry | `in_sync` | 绿色 |
| Registry Hash | `41689393289d9514d1ed9cd22455a164f1bc59286f0db16deb9235e703e6ae77` | 绿色 |
| Definition Source Commit | `86108cc700df4e1f1d6802765cadb47e0bb65bcb` | 绿色 |
| Agent Core | `2026-08-09.3` | 绿色 |
| Domain Connector | `2026-08-09.3 / read_only` | 绿色 |
| Work / Practice Protocol | `1.1.0 / active` | 绿色 |
| H 控制面生产 | `v1.55.1`，服务 active，`NRestarts=0`，错误日志 0 | 绿色 |
| H Goal 6 白盒 | 真实 Chrome `59/59`，节点重叠、错接、穿卡、焦点偏差均为 0 | 绿色 |
| 真 3D | `contract_only`，降级到 2.5D | 灰色 |

## Company Brain Operating Model v1

Operating Model 固化了 12 类责任角色，并分别定义可读、可提案、可批准、可执行、必须验证、必须人工介入和禁止读取的数据。工作闭环固定为：

```text
Observation
→ Evidence
→ Claim / Hypothesis
→ Decision
→ Goal / P2 / Task
→ Action
→ Outcome
→ Verification
→ Learning
→ Ontology Change Proposal
```

核心不变量：

- `WorkCase=completed` 只代表工作流程结束，不代表 Task、Action 或 Goal 成功。
- 技术执行、业务流程和经营目标三层结果分别验证。
- Learning 默认只能为 `proposed`，不能自动修改 Ontology、Prompt 或业务流程。
- Company Agent 只读最小 Permissioned Evidence Package，不继承公司 App 的全局读取能力。
- 外部写入必须经过 Action Gateway、Action Approver 和读回验证；本 Goal 没有打开写回。

## P1-DOMAIN 最小骨架

Schema `3.3.0` 增量增加 Product、Device、Operations 和 Market 最小对象、关系、Function、Policy 与 Constraint。所有领域对象继续遵守稳定外部 ID、Namespace、Schema Version、Transaction/Valid Time、Provenance、Authority、Purpose、Event Envelope、幂等和审计要求。

没有新增第二套结构化事实真源：Postgres 继续保存受治理事实、权限和审计；Qdrant 仍是可重建召回层。

## ERP M3 与社媒只读证据

- ERP M3 当前 Read Model 共 95 条，其中 Operations 38 条、Device 57 条。
- Market Read Model 共 369 条，只接收已有系统的归一化结果。
- 敏感字段扫描为 0；未带入 Token、Cookie、密码、账号凭据或原始业务正文。
- 应用角色未设置 Tenant 时读取 0；设置当前 Tenant 后读取 95。
- Action Gateway 读取 `domain_read` 被数据库拒绝。
- ERP 和 Market Replay 不产生重复写入；失败或历史 Replay 不覆盖 Live Cursor。
- 删除、撤销、过期和恢复状态均有显式记录；非法记录进入 Dead Letter，不进入稳定 View。
- 本 Goal 未恢复 ERP M4、MediaCrawler、自动登录、平台风控绕过或任何业务写回。

## 跨域只读演示链

生产演示链为：

```text
MarketSignal
→ Evidence
→ Claim
→ DecisionCase
→ ProductVersion
→ Goal / P2 / Task Proposal
→ ERP FulfillmentEvidence
→ Verification
→ Learning
```

验收计数为 11 节点、9 关系；Decision 和 Task 处于草案/提案，Verification 为 pending，Learning 为 proposed，ActionIntent 和 Delivery Outbox 均为 0。没有向真实员工投递，没有写回 ERP 或社媒，也没有把演示对象冒充经营结果。

## 3D-ready 协议

H 控制面源码已统一定义：

```text
ArchitectureNode
ArchitectureEdge
ArchitectureLayer
ArchitectureGroup
ArchitectureFocus
ArchitectureSelection
ArchitectureCameraState
ArchitectureFilter
ArchitectureTrace
ArchitectureViewMode
```

`overview-2d` 和 `diagnostic-2.5d` 使用同一 Registry、Node ID、状态 DTO、权限和焦点模型。`topology-3d` 只保留契约并强制降级到 2.5D，不开发第二套节点定义或 WebGL 数据源。

## 测试与负向验证

- Ontology Contracts：15/15。
- Domain Connector：5/5。
- H Goal 6 专项：8/8。
- H 控制面完整测试：260/260。
- QNAP 完整 `verify.sh`：通过。
- Registry Definition/Runtime：`in_sync`。
- 状态 Cursor：只返回 `cursorPresent` 和时间，不返回真实 Cursor。
- 无权角色：fail-closed。
- 敏感字段：0。
- 新增公网端口：0。

## H 控制面生产验收

- 发布源码：`feishu-grok-bridge@02e3ab4dc031bf93385a44758a82fe1785e339cb`；发布证据提交：`6260061`。
- 自动回滚点已创建并完成完整性校验；内部路径不进入方案文档。
- 公网 `/healthz` 为 `v1.55.1`；未认证管理页面继续返回 `302`。
- `h-control` 为 active，`NRestarts=0`，`.env` 保持 `h-control:h-control / 0600`，新启动后错误日志为 0。
- 真实 Chrome `59/59`：节点重叠 0、端口错误 0、穿卡连线 0、焦点偏差 0、控制台错误 0、失败请求 0、横向溢出 0。
- 验收证据：`output/playwright/goal6/goal6-whitebox-20260809-230734.{json,png}`。

后续任何 H 控制面重新发布或重启仍必须先说明目标版本、影响范围、预计中断、备份与回滚，再获得当前明确批准；本次 `v1.55.1` 授权不能继承到下一次变更窗口。

## 尚未完成

1. Domain Connector 旧版真实回滚与新版恢复演练。
2. 完成后的共享记忆、Skill、最终 commit/push 和飞书方案文档更新。

10 名真实员工 Canary、20/50/300 人扩容、产品研究部整库导入、ERP/社媒写回、ERP M4、MediaCrawler 和真 3D 继续不属于本 Goal 的已完成范围。
