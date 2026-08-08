# 飞书产品研究部知识库 ACL 只读审计

日期：2026-08-08（Asia/Shanghai）

## 结论

本轮只验证公司智慧中枢 App 能否枚举知识库节点、读取文档成员权限和公开权限设置，**没有触发正式导入**。审计发现当前 Knowledge Connector 存在两个会造成权限放大的 P0 缺陷，因此在修复、测试、部署和撤权复测完成前，禁止把任何飞书知识空间批量导入 Ontology。

当前知识表保持空索引状态：

```text
knowledge.resources = 1
knowledge.chunks = 0
knowledge.acl_entries = 0
```

## 只读审计范围

- 目标：产品研究部知识库。
- 节点总数：1,222。
- 节点类型：Docx 930、旧 Doc 146、Sheet 29、Bitable 32、Mindnote 13、File 68、Slides 4。
- 文档成员 ACL 可读：1,167；失败：54 个返回 `1063004`，另有 1 个节点缺少资源 Token。
- 公开权限设置可读：1,182。
- 知识空间成员原始类型：`openid × 3`、`department × 1`、`openchat × 1`。
- 可进入现有正文管线的 Docx/Sheet 共 958 个：文档 ACL 可读 916，ACL 读取失败 42。
- 916 个 ACL 可读文档中，858 个明确含 `wikispaceid`，58 个没有空间继承标识。
- 42 个 ACL 失败文档中，有 10 个正文接口仍可读取。

以上数量是 2026-08-08 的权限快照，不是永久常量。审计过程没有输出文档 Token、成员 ID、正文或凭据。

## P0-1：ACL 读取失败必须无条件跳过

### 当前问题

`services/knowledge-connector/src/sync.mjs` 的 `syncResource()` 捕获文档 ACL 错误后，仍会把预先传入的知识空间 ACL 与空的文档 ACL 合并。只要空间 ACL 非空，`aclKnown` 就可能变成 `true`，随后继续读取正文、生成 Chunk 并入库。

这不是理论风险：本次 42 个 ACL 读取失败的 Docx/Sheet 中，有 10 个正文仍可被 App 身份读取。若按当前整库同步逻辑运行，这 10 个文档可能在文档权限未知时被索引，属于明确的 fail-open。

### 必须修改

- `listPermissionMembers()` 发生任何错误时，立即写入 `acl_status=unknown`、`status=skipped` 和脱敏错误码。
- 不得调用正文接口，不得计算正文 Hash，不得生成 Chunk，不得写入任何继承 ACL。
- 空间公开、空间成员已知或正文可读都不能覆盖文档 ACL 读取失败。
- 增加测试：`document ACL error + inherited space ACL` 必须断言正文读取次数为 0、Chunk 为 0、资源为 skipped。

## P0-2：只有文档 ACL 明确包含 `wikispaceid` 才能继承空间权限

### 当前问题

整库循环在读取每个节点前就获取空间成员，并无条件作为 `inheritedAcl` 传入 `syncResource()`。这会让没有 `wikispaceid` 的文档也继承整个空间权限。

本次 916 个 ACL 可读文档中，有 58 个没有 `wikispaceid`。按当前算法，这些文档会额外合并 1～2 个可映射的空间成员，形成高风险权限放大候选。

### 必须修改

- 先读取文档直接 ACL，并保留是否出现 `subjectType=wiki_space` 的证据。
- 只有文档 ACL 明确包含对应空间的 `wikispaceid` 时，才调用 `listSpaceMembers()` 并展开空间权限。
- 没有 `wikispaceid` 时，只保存文档直接 ACL；不能因为节点位于某知识空间就推断权限继承。
- 公开团队空间也遵循同一规则：只有文档 ACL 明确声明空间继承时，才能映射为 tenant 可读。
- 增加正反测试：含 `wikispaceid` 正常继承；不含 `wikispaceid` 时空间成员不得进入资源 ACL。

## P1 后续缺口

### P1-1：空间成员类型映射不完整

飞书空间成员返回的原始字段存在 `member_type=department/openchat`。当前 `spaceAclEntry()` 主要判断 `type=department/chat`，没有完整兼容原始 `member_type`，本次空间成员只正确映射出 3 名人员，部门和群聊可能丢失。

修复时应覆盖 `openid`、`department`/`opendepartmentid`、`openchat`、`groupid`，并为未知类型记录计数而不是静默吞掉。

### P1-2：检索授权主体类型不完整

Agent Core 当前 Knowledge SQL 只匹配 `tenant`、`person`、`department`。即使 Connector 正确保存 `chat`、`group` 或 `wiki_space`，检索层也不会识别这些授权主体。

正式支持群聊或项目群权限前，需要定义当前会话的群组 Principal 证据、用途边界和撤权策略，再扩展 SQL；不得直接把群成员关系等价为个人永久权限。

## 正式导入硬门禁

1. 两个 P0 均有单元测试和回归测试。
2. 代码评审确认 ACL 错误路径无正文读取，空间权限只按 `wikispaceid` 展开。
3. 新版本部署到公司 QNAP 后，先运行小范围只读 Canary，不直接导入 1,222 个节点。
4. Canary 同时覆盖直接授权、空间继承、无空间继承、ACL 失败、正文可读但 ACL 失败、部门授权和撤权。
5. 有权员工 Evidence 命中；无权员工标题、摘要、正文和来源 URL 均为零泄露。
6. 撤权后重新同步，旧 Chunk 和 ACL 在约定 SLA 内失效；再做跨员工、跨部门和链接直猜负测。
7. 审计记录资源数、跳过原因和 Chunk 数，不记录 Token、成员 ID、正文或凭据。

## 当前状态判定

- Knowledge Connector 服务与数据库骨架：已部署。
- 单个显式资源 `1063004` fail-closed：已验证。
- 整库 ACL 安全性：未通过。
- 产品研究部知识库正式导入：禁止。
- 下一步：先修复 P0-1、P0-2，再处理 P1 映射和检索主体支持。
