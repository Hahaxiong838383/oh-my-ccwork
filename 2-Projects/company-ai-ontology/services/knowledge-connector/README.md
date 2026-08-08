# Company Knowledge Connector

公司飞书知识只读 Connector。它使用公司 App 身份发现可读资源，但只有在文档 ACL 可确定时才读取正文并写入知识块；ACL 不明时保持 fail-closed。

## 当前能力

- 自动发现公开团队知识空间；私有空间必须显式配置。
- 支持飞书新版文档、表格和妙记。
- 将文档协作者、知识空间成员、人员和部门映射为最小读取 ACL。
- 写入 `knowledge.resources`、`knowledge.acl_entries`、`knowledge.chunks` 和 `knowledge.sync_runs`。
- 显式资源通过 `FEISHU_KNOWLEDGE_RESOURCES_B64` 传递 Base64 JSON，避免 Compose 转义破坏配置。
- 同步结果只暴露数量、跳过原因和白名单错误码，不输出文档 Token、人员 ID、原始错误正文或知识正文。

## 安全边界

- App 可读不代表员工可读。
- ACL 未知时不读取正文、不生成向量、不进入 Agent Prompt。
- 文档 ACL 获取失败时立即写入 skipped；空间公开、空间成员可读或正文接口可读都不能覆盖该失败。
- 只有文档 ACL 明确包含 `wikispaceid` 才展开空间成员；节点位于知识空间不是权限继承证据。
- 撤权后的下一次同步会替换 ACL 和知识块；未完成同步前不得把缓存提升为权限真源。
- Connector 只读飞书，不持有 ERP、Git、报表或社媒写权限。

## 当前版本边界

- 本地候选版本 `2026-08-08.3` 已完成两个 ACL P0 修复并通过 Connector 14/14、Agent Core 14/14 回归。
- 公司 QNAP 当前仍运行 `2026-08-08.2`；本地通过不等于生产完成。
- 未经单独部署授权不得更新 QNAP；小范围 Canary 和撤权复测完成前不得正式导入知识空间。

## 飞书门禁

显式文档若返回 `1063004`，表示公司 App 对该文档没有分享权限。处理方式是由文档所有者或管理员把公司 App 加为文档协作者并授予可查看协作者/分享设置所需权限；不得绕过 ACL 直接抓正文。

## 本地验证

```bash
npm ci
npm test
```
