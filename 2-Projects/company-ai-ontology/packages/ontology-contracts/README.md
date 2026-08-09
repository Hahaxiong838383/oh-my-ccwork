# Ontology Contracts

公司 AI Ontology 的稳定定义和编译契约。该包不连接数据库、不执行写回，只负责读取定义、结构校验、内容寻址、兼容性分析、Event Envelope、Data/Logic/Action 工具契约，以及 Company Brain Operating Model 和 Capability Governance 契约校验。

`company-capability-governance-v1.json` 当前为 `contract_only`：Skill 正文继续以 Git 和 H 平台 L0 Store 为真源，Ontology Registry 只管理版本、Hash、绑定、审批和执行快照元数据，不改变生产 Schema `3.3.0`。

## 命令

```bash
npm test
npm run compile
```

默认定义目录为 `definitions/`。编译成功会输出 schema version、内容 hash、元素数量和兼容性摘要；校验失败返回非零退出码。
