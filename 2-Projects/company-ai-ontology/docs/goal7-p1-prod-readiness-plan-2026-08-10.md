# Goal 7：P1-PROD-READINESS 实施计划

> 2026-08-12 更新：Phase 1、Phase 2 和 Phase 4 已形成并推送工程候选，Runtime Workflow `31598703363` / Artifact `9142197870` 已通过不可变 Linux/PostgreSQL 验证。Goal 7 Acceptance 已升级为五份原始 Evidence 绑定的 `2.0.0` 编译产物。当前仍为 `immutable_runtime_verified / production_not_deployed / owner_acceptance_pending`，公司专用 CPA 凭据、真实 H Worker 双源读回、合成 Canary、QNAP 三组件发布和 Owner Acceptance 均未完成。

## 结论

Goal 7 建议拆成两条互不越权的工作流：

1. **P1-AUTHORITY：飞书部门 / 群聊 Principal 与撤权闭环**；
2. **P1-RUNTIME：H 引擎同厂冗余、熔断、预算和真实模型读回**。

本文件保留 Goal 7 的实施基线。当前已完成本地代码、候选迁移、负向测试和 CI 验证接线，但尚未部署、迁移、飞书写回、整库导入或执行真实员工 Canary。公司专用 CPA 账号 / Key 延后，当前候选继续显式标记 `temporary_personal_credential`；任何凭据明文都不进入 Git、文档、记忆、日志或 QNAP。

## Goal 7 完成定义

Goal 7 完成不等于“接口能返回数据”，而是必须同时证明：

- 飞书原始 `department/openchat` 成员可以稳定映射为 Ontology Principal；
- 群聊授权只作用于当前请求员工，不能借被艾特成员、历史成员或 Bot 自身权限放大；
- 授权用途只会缩小访问范围，不会扩大员工原有权限；
- 成员变化、离职、退群和资源撤权能在目标窗口内收敛；
- 权限证据不可用时在读取正文前失败关闭；
- H 引擎主路由异常时可控熔断，不发生无限重试、预算失控、模型静默降级或绕过权限层；
- 全部正负测试通过后，仍保持产品研究部整库导入、10 人真实 Canary、员工私人 Bot 迁移和业务写回关闭。

## 工作流 A：P1-AUTHORITY

### A1. Principal 统一模型

建议把所有飞书授权主体统一编译为：

```text
PrincipalRef
├── user:<employee_open_id>
├── department:<department_id>
└── chat:<chat_id>
```

实现要求：

- Connector 同时兼容飞书返回的 `type` 与原始 `member_type`，显式处理 `department`、`openchat`、`chat`、`group` 等等价形态；
- 不把部门或群聊成员在导入时展开成永久个人 ACL，避免成员变化后遗留授权；
- ACL 真源保留“资源直接授权给哪个 Principal”，成员关系单独维护；
- Principal、成员关系和资源 ACL 使用双时间：业务生效时间与系统观测时间分离；
- 未识别成员类型进入隔离队列，不降级成 `user` 或全员权限。

### A2. 群聊请求授权语义

推荐规则：

1. 群聊消息的请求 Principal 永远是**实际发送者**，不是群聊所有成员、被艾特成员或 Bot。
2. 多人艾特不做权限并集；被艾特人的权限不能被发送者借用。
3. 资源直接授权给 `chat:<chat_id>` 时，必须同时证明发送者当前仍是该群成员。
4. 私聊只使用发送者的 `user` Principal，不继承任何群聊上下文。
5. Bot 的应用级读取能力只负责取证，不代表员工有权看到取到的内容。
6. 若任务需要多人协作，只能使用所有参与者共同可访问的证据，或由 DRI 显式创建受控共享成果；不能把多人的个人权限做并集。

### A3. 会话授权证据

每次权限化检索生成 `ConversationAuthoritySnapshot`：

- `requestPrincipal`：实际发送者；
- `conversationPrincipal`：私聊为空，群聊为当前 `chat`；
- `membershipObservedAt`：群成员关系观测时间；
- `resourceAclSnapshot`：资源直接 ACL 版本；
- `purpose`：本次 WorkCase 的访问用途；
- `decision`：allow / deny / unknown；
- `ruleVersion`：授权规则版本；
- `expiresAt`：本次证据有效期。

只持久化可审计判据、引用和结果，不持久化隐藏推理，不在拒绝结果中泄露被排除文档的标题、URL、作者或正文。

### A4. 用途绑定

用途建议先固定为四类：

- `company_knowledge_query`：公司资料问答；
- `task_execution_support`：个人任务执行辅助；
- `decision_support`：基于授权证据的决策支持；
- `result_submission`：成果提交与引用验证。

用途是附加约束，不是授权来源：

```text
最终可见范围 = 员工权限 ∩ 会话权限 ∩ 用途允许范围 ∩ 数据政策
```

涉及用户身份操作、个人日历、个人消息、个人云盘写入或其他用户授权动作时，公司 Bot 必须提醒员工改用自己的私人 Bot；公司 Bot 不代理用户权限。

### A5. 撤权与收敛

建议采用“事件失效 + 读取时确认”双保险：

- 接收部门成员、群成员、离职和资源 ACL 变化事件，立即使相关缓存失效；
- 每次敏感检索在正文读取前检查当前 Principal 与资源 ACL；
- 成员或 ACL API 不可用时返回 `unknown` 并失败关闭；
- 初始收敛目标建议为 **60 秒内 Evidence 归零**，最终 SLA 由合成 Canary 实测后拍板；
- 已生成的 Evidence Package 带有效期，过期后不能继续用于新回答或新决策。

### A6. 合成 Canary 矩阵

在不导入产品研究部整库、不选真实员工的前提下，创建最小合成资源覆盖：

| 场景 | 预期 |
|---|---|
| 用户直接授权 | 允许，Evidence > 0 |
| 部门直接授权 + 当前部门成员 | 允许 |
| 部门已移除 | 60 秒目标窗口内 Evidence = 0 |
| 群聊直接授权 + 当前群成员 | 允许 |
| 群成员退群 / 被移除 | Evidence = 0 |
| 多人艾特，发送者无权、被艾特者有权 | 拒绝，不做权限并集 |
| Bot 能读正文但 ACL 读取失败 | 正文读取前失败关闭 |
| 猜链接、跨部门、历史群成员 | 拒绝且无元数据泄露 |
| 私聊用户无权、所在群有权 | 拒绝，不继承群权限 |
| 用途不匹配 | 拒绝或只返回允许用途内证据 |

## 工作流 B：P1-RUNTIME

### B1. 路由模型

建议先定义而不启用：

```text
Company Agent Core
  -> H Engine Router
     -> Route A: 当前个人 CPA / grok-4.5（临时主路由）
     -> Route B: 同厂冗余路由（disabled，等待独立凭据和授权）
```

公司专用 CPA 凭据不属于本轮实施；Route B 在没有独立凭据前必须保持 `disabled`，不得复用同一 Key 伪装成冗余。

### B2. 熔断与降级

- 区分网络失败、限流、余额 / 配额、模型不可用、上游 5xx 和业务拒绝；
- 只对可重试错误做有上限退避，禁止无限重试；
- 熔断器按 Route 独立计数，不能因为一个路由失败把整个 Agent Core 标记离线；
- 权限证据不足、策略拒绝和业务校验失败不能触发模型切路重试；
- 备用路由必须使用同一 H Engine 输入契约、权限化 Evidence Package 和输出校验；
- 不允许静默切到能力更弱、上下文更小或数据政策不同的模型。

### B3. 预算与配额

- 分离请求数、Token、上游费用、重试费用和被熔断请求；
- 按公司、部门、WorkCase 类型和 Route 聚合，不记录员工问题正文；
- 设置单请求、单 WorkCase、每日和月度四层预算上限；
- 超预算时返回明确的 `budget_blocked`，不伪装成模型故障；
- 当前个人 CPA 只作为临时依赖，监控中必须标注 `temporary_personal_credential`。

### B4. 真实模型读回

每次 H 引擎调用必须记录上游实际响应中的：

- `provider`；
- `route`；
- `model`；
- 请求时间、响应时间和重试次数；
- Token / 费用可得摘要；
- `credentialMode`，只记录模式，不记录 Key。

验收以真实响应 `model` 和实际请求增量为准，不以 UI、配置文件或模型目录标签为准。

## 分阶段实施顺序

### Phase 0：拍板与测试资源

- 川哥确认本文件决策卡；
- 确认合成部门、合成群聊和合成文档的范围；
- 明确撤权目标窗口和可接受的飞书 API 调用量；
- 保持生产整库导入、真实 Canary 和 Route B 关闭。

### Phase 1：契约与数据库迁移

- 增加 `PrincipalRef`、`PrincipalMembership`、`ConversationAuthoritySnapshot` 和用途枚举；
- 增加双时间、版本、幂等和撤权审计字段；
- 迁移先在本地 / 隔离环境验证，真实应用角色必须能读写其应有表，Action Gateway 继续不能读知识正文。

### Phase 2：Connector 与 Retrieval Gateway

- 修复 `department/openchat` 原始类型映射；
- 增加群成员发现、事件失效与读取时确认；
- Retrieval 在正文读取前完成 Principal、当前成员、资源 ACL 和用途求交；
- 所有 unknown / timeout / schema mismatch 失败关闭。

### Phase 3：合成 Canary 与撤权演练

- 执行 A6 全矩阵；
- 验证直接授权、部门授权、群授权、多人艾特、私聊隔离、撤权和 API 失败；
- 记录 Evidence 数、H 引擎调用数、元数据泄露检查和收敛时间；
- 回滚并清理全部临时资源、Principal、ACL、Chunk 和 Token 文件。

### Phase 4：Runtime 框架

- 实现 Route 状态、熔断、预算和真实模型读回数据契约；
- Route A 继续使用当前个人 CPA，但明确临时状态；
- Route B 保持 disabled，等待公司专用或独立冗余凭据另行授权；
- 不在本 Phase 做自动切路生产演练。

### Phase 5：Goal 7 验收与后续门禁

- 输出工程证据包和可视化验收清单；
- 川哥明确人工验收后再记录 `owner_accepted=true`；
- Goal 7 完成后，Goal 3 十人真实 Canary 仍需单独授权；
- 产品研究部整库导入仍是独立决策，不因 Goal 7 完成自动开启。

## 决策卡（推荐值）

| 决策 | 推荐 |
|---|---|
| Principal 类型 | `user / department / chat` 三类统一模型 |
| 群聊请求人 | 只认实际发送者 |
| 多人艾特 | 不做权限并集 |
| 群授权 | 资源直接 ACL + 发送者当前群成员同时成立 |
| 私聊 | 不继承群聊权限 |
| 用途 | 只收窄，不扩权 |
| API 不可用 | 正文读取前 fail-closed |
| 撤权目标 | 初始 60 秒，实测后再定 SLA |
| 合成 Canary | 先做，不使用真实员工和整库 |
| Route A | 临时个人 CPA，显式标记 |
| Route B | 契约先建、默认 disabled，不复用同一 Key 假冗余 |
| 整库导入 | Goal 7 完成后仍需单独审批 |

## 川哥拍板后首个开发批次

建议只启动 Phase 1 + Phase 2 的本地实现和测试，不连接生产飞书、不部署 QNAP、不启用 Route B。完成后先交付数据库迁移、Principal 映射、Retrieval fail-closed 单测和合成测试工具，再申请下一阶段授权。
