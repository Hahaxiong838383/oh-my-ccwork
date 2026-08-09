# Goal 6-A：Company Brain Operating Model + P1-DOMAIN 验收记录

验收日期：2026-08-09（Asia/Shanghai）

## 当前结论

Goal 6 的 QNAP 数据面、Operating Model、P1-DOMAIN 只读骨架、跨域演示链和 3D-ready 数据协议已经完成当前层级生产验收。H 控制面 `v1.54.0` 已完成代码、完整测试、密码文件离线校验和只读发布检查，但生产已恢复并保持 `v1.53.0`；在获得川哥当前明确重启授权、完成管理员密码切换和真实 Mac 浏览器验收之前，Goal 6-A 不能标记完整完成。

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
| H 控制面生产 | `v1.53.0` | 绿色基线 |
| H Goal 6 白盒 | `v1.54.0` 代码完成，待授权发布 | 灰色 |
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

- Ontology Contracts：12/12。
- Domain Connector：5/5。
- H Goal 6 专项：8/8。
- H 控制面完整测试：260/260。
- QNAP 完整 `verify.sh`：通过。
- Registry Definition/Runtime：`in_sync`。
- 状态 Cursor：只返回 `cursorPresent` 和时间，不返回真实 Cursor。
- 无权角色：fail-closed。
- 敏感字段：0。
- 新增公网端口：0。

## H 控制面发布门禁

生产当前是 `v1.53.0`，服务、监听、`.env` 属主权限、公网健康和未认证跳转均正常。`v1.54.0` 只读发布检查已经验证：

- 管理员密码 RTF 存在且可唯一识别一个 31 字符候选，正文未输出。
- 源码提交已推送，目标版本为 `v1.54.0`。
- 本地专项和完整测试通过。
- 远端基线为 `v1.53.0`、服务 active、`.env` 为 `h-control:h-control / 0600`。
- 公网健康 200，未认证管理员页面 302。
- 发布归档已生成并校验 SHA-256。
- 本次检查没有执行重启或密码切换。

重新发布必须先向川哥说明目标版本、影响范围、预计中断、备份与回滚，再获得当前明确批准。历史 Goal 授权不能替代本次生产变更窗口授权。

## 尚未完成

1. H 控制面 `v1.54.0` 生产发布和管理员密码切换。
2. 真实 Mac 浏览器二维/2.5D 点击、右键拖动、双指平移、缩放、焦点居中、搜索与新增领域节点验收。
3. 浏览器控制台错误、失败请求和横向溢出为 0 的新启动后证据。
4. Domain Connector 旧版真实回滚与新版恢复演练。
5. 完成后的共享记忆、Skill、最终 commit/push 和飞书方案文档更新。

10 名真实员工 Canary、20/50/300 人扩容、产品研究部整库导入、ERP/社媒写回、ERP M4、MediaCrawler 和真 3D 继续不属于本 Goal 的已完成范围。
