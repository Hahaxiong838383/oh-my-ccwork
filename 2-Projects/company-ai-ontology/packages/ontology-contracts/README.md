# Ontology Contracts

公司 AI Ontology 的稳定定义和编译契约。该包不连接数据库、不执行写回，只负责读取定义、结构校验、内容寻址、兼容性分析、Event Envelope、Data/Logic/Action 工具契约，以及 Company Brain Operating Model 和 Capability Governance 契约校验。

`company-capability-governance-v1.json` 当前为 `contract_only`：Skill 正文继续以 Git 和 H 平台 L0 Store 为真源，Ontology Registry 只管理版本、Hash、绑定、审批和执行快照元数据，不改变生产 Schema `3.3.0`。

`pestim-strategic-intelligence-v1.json` 是 P1-SI-A 候选定义：以生产 Schema `3.3.0` 为基线编译出 additive-compatible 的候选 `3.4.0`，但保持 `contract_only / deploymentAllowed=false`。它不会进入 active `definitions/manifest.json`，也不会触发 Registry 部署或数据库迁移。

## 命令

```bash
npm test
npm run compile
npm run compile:pestim
```

PESTIM 候选定义通过 `compilePestimStrategicIntelligenceProposal()` 单独编译和兼容性比较；只有 Ontology Change Proposal、Goal 7、Source Registry、HUD DRI 审核、QNAP Shadow 和 Registry 对账全部通过后，才允许另行提出生产激活。

默认定义目录为 `definitions/`。编译成功会输出 schema version、内容 hash、元素数量和兼容性摘要；校验失败返回非零退出码。
