# Goal 6-A 逐项完成审计

审计时间：2026-08-09（Asia/Shanghai）

## 结论

Goal 6-A 尚未完整完成。QNAP 数据面、Operating Model、P1-DOMAIN、只读演示链和 3D-ready 协议已有生产证据；H 控制面 `v1.54.0` 仍等待当前明确生产重启授权，真实浏览器验收、Domain Connector 回滚恢复演练、飞书方案文档和最终记忆收口尚未完成。

状态含义：

- `已证明`：当前权威证据覆盖完整要求。
- `部分证明`：代码、测试或部分生产证据存在，但要求范围尚未全部覆盖。
- `待证明`：缺少当前真实证据，不能判定完成。

## 阶段审计

| 要求 | 状态 | 权威证据 | 缺口 |
|---|---|---|---|
| Phase 0 多仓、H、QNAP、ERP、社媒、Registry 在线基线 | 已证明 | 当前 Git 状态、公网 `/healthz`、QNAP 五元组与状态接口、完整 `verify.sh` | 无 |
| Phase 1 二维/2.5D 部署到认证 H 控制面 | 部分证明 | `feishu-grok-bridge@396210f`、260/260 测试、发布脚本只读检查 | 生产仍为 `v1.53.0` |
| Phase 1 真实浏览器交互 | 待证明 | `ops/accept-company-ontology-whitebox.sh` 已准备并通过版本硬门负测 | 必须在新服务启动后执行 |
| Phase 2 Company Brain Operating Model v1 | 已证明 | `company-brain-operating-model-v1.json`、Contracts 12/12、Schema `3.3.0` | 无 |
| Phase 3 Product/Device/Operations/Market 最小骨架 | 已证明 | `domain-v1.json`、Compiler、Registry `in_sync` | 无 |
| Phase 4 ERP M3 只读接入 | 已证明 | ERP Read Model 95 条、应用角色/RLS、Replay 与敏感扫描 | 无 |
| Phase 4 社媒归一化结果只读接入 | 已证明 | Market Read Model 369 条、事实类型/置信度/有效期契约 | 无 |
| Phase 4 删除、撤销、过期、错误恢复 | 已证明 | Lifecycle、Dead Letter、失败恢复和 Live Cursor 保护负测 | 无 |
| Phase 4 真实回滚与恢复 | 待证明 | 回滚脚本和既有备份存在 | 未获 QNAP 生产重启授权 |
| Phase 5 3D-ready 统一协议 | 已证明 | 10 类 Architecture DTO、Z0–Z4、ViewMode、严格验证器 8/8 | 真 3D 按范围保持灰色 |
| Phase 6 新领域白盒 | 部分证明 | 新节点、连线、搜索、焦点代码和测试 | 待 `v1.54.0` 上线与浏览器证据 |

## 验收要求审计

| 验收要求 | 状态 | 证据或说明 |
|---|---|---|
| Definition、Compiler、Registry 一致 | 已证明 | Schema `3.3.0`、Hash `41689393289d`、`in_sync` |
| 不新增第二套事实真源 | 已证明 | Postgres 为唯一结构化事实/权限/审计真源；Qdrant 为派生层 |
| Migration 与部署幂等 | 已证明 | 重复迁移、重复同步和 Replay 验收通过 |
| 真实应用角色读取稳定 View | 已证明 | 无 Tenant 为 0，当前 Tenant 为 95 |
| 无权角色无法读取 | 已证明 | Action Gateway 领域表读取被拒绝 |
| 跨域只读演示链 | 已证明 | 11 节点/9 关系，ActionIntent/Outbox 为 0 |
| 不投递员工、不写回 ERP/社媒 | 已证明 | 演示对象保持提案态，审计未产生写动作 |
| 新领域节点可搜索、选择、聚焦 | 部分证明 | 自动测试覆盖；真实浏览器待执行 |
| 二维节点无重叠、2.5D 卡片可点击 | 部分证明 | 浏览器自动断言已落盘；生产证据待执行 |
| Mac 触摸板双指、右键拖动、捏合缩放 | 部分证明 | Wheel/右键/Ctrl-Wheel 自动断言已准备；真实 Mac 运行待执行 |
| 控制台错误、失败请求、横向溢出为 0 | 待证明 | 必须采集 `v1.54.0` 新启动后的浏览器证据 |
| 状态接口白名单和 Cursor 脱敏 | 已证明 | Domain 状态只返回存在性和时间，专项负测通过 |
| 无 Evidence 不调用 H 引擎 | 已证明 | Goal 4 策略层 fail-closed 生产证据继续有效 |
| 敏感信息扫描为 0 | 部分证明 | 当前代码、领域记录和差异扫描为 0；发布后日志/截图需复验 |
| 没有新增公网端口 | 已证明 | QNAP 仍只有公司 LAN 健康入口，H 复用既有 HTTPS |

## Git 与沉淀审计

| 项目 | 当前状态 |
|---|---|
| QNAP Domain Runtime 代码 | `mycc@57c3b2123` 已推送 |
| Goal 6 状态、Skill 和技术架构文档 | `mycc@605f47646` 已推送 |
| H Goal 6 白盒 | `feishu-grok-bridge@396210f` 已推送 |
| 生产重启门禁与回滚脚本 | `feishu-grok-bridge@b7d7dbf` 已推送 |
| 浏览器验收自动化 | `feishu-grok-bridge@b8ea156` 已推送 |
| 共享记忆与 Codex 私有 memory note | 待 Goal 完成后更新 |
| 飞书《公司 AI Ontology 基座架构方案》 | 待最终生产与浏览器证据后更新 |

## 剩余严格顺序

1. 获得 H 控制面本次重启和管理员密码切换的当前明确授权。
2. 执行带自动备份/失败回滚的 `v1.54.0` 发布。
3. 运行隔离 Playwright 会话和真实 Mac 触摸板验收。
4. 单独申请 Domain Connector 回滚/恢复演练窗口并执行。
5. 更新飞书方案文档、共享记忆、Skill 最终状态和 Codex memory note。
6. 复跑完成审计、选择性提交并 push；所有项目均有权威证据后才标记 Goal complete。
