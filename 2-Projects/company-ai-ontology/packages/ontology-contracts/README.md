# Ontology Contracts

公司 AI Ontology 的稳定定义和编译契约。该包不连接数据库、不执行写回，只负责读取定义、结构校验、内容寻址、兼容性分析、Event Envelope、Data/Logic/Action 工具契约，以及 Company Brain Operating Model 和 Capability Governance 契约校验。

`company-capability-governance-v1.json` 当前为 `contract_only`：Skill 正文继续以 Git 和 H 平台 L0 Store 为真源，Ontology Registry 只管理版本、Hash、绑定、审批和执行快照元数据，不改变生产 Schema `3.3.0`。

`pestim-strategic-intelligence-v1.json` 是 P1-SI-A 候选定义：以生产 Schema `3.3.0` 为基线编译出 additive-compatible 的候选 `3.4.0`，但保持 `contract_only / deploymentAllowed=false`。它不会进入 active `definitions/manifest.json`，也不会触发 Registry 部署或数据库迁移。

`pestim-source-registry-v1.json` 是 P1-SI-B 候选定义：以 P1-SI-A `3.4.0` 为基线编译出 additive-compatible 的候选 `3.5.0`。首批来源目录保持 `candidate`，所有条目在公司合规 DRI 审批前均为 `paused`，采集判定默认 `deny`。

`pestim-data-foundation-v1.json` 是 P1-SI-D 候选定义：以 P1-SI-B `3.5.0` 为基线生成 `3.6.0`，固定 Postgres 为唯一结构化真源、Qdrant 为可重建派生层，并提供 Raw Snapshot、External Observation、Strategic Signal、双时间和 Replay 契约。

`pestim-reporting-v1.json` 是 P1-SI-E 候选定义：以 P1-SI-D `3.6.0` 为基线生成 `3.7.0`，定义上海时区的日/周/月/季/半年/年窗口、Alert/公司/P003 报告、非递归结构化输入、完整 ReportRun 谱系和飞书/H 只读投影。

`p003-impact-review-v1.json` 是 P1-SI-G 审核包契约：从真实 4644 条飞书 draft 中选取 36 条 P003 候选，六类各 6 条。所有候选继续保持 `generated_draft / unverified / inactive`，必须由实名 DRI 重写模板化逻辑、补齐正反证据、方向、强度、滞后和验证指标后，才允许进入独立激活提案。

## 命令

```bash
npm test
npm run compile
npm run compile:pestim
npm run compile:source-registry
npm run compile:data-foundation
npm run compile:reporting
npm run compile:p003-review
```

PESTIM 候选定义通过 `compilePestimStrategicIntelligenceProposal()` 单独编译和兼容性比较；Source Registry 再通过 `compilePestimSourceRegistryProposal()` 叠加到 `3.4.0`，不得改写 P1-SI-A Hash。只有 Ontology Change Proposal、Goal 7、Source Registry 审批、P003 DRI 审核、QNAP Shadow 和 Registry 对账全部通过后，才允许另行提出生产激活。

默认定义目录为 `definitions/`。编译成功会输出 schema version、内容 hash、元素数量和兼容性摘要；校验失败返回非零退出码。
