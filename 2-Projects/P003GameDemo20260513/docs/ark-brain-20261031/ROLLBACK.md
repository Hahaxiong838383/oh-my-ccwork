> 历史候选快照；当前整合、发布状态及新版管理API以 [埋点控制与方舟接入回执](../analytics-control-20261031/SERVER_RECEIPT.md) 为准。

# 方舟上下文回滚记录

状态：开发会话未部署、未写生产env、未重启、未改任何线上开关。发布责任：总调度会话13。候选分支 `codex/p003-ark-brain-context-20261031`；现役固化代码锚 `0708d768`，设计修订锚 `83cff28c`；KB独立修复锚 `e6f330ec`。实际发布前另记录现役各文件SHA、进程版本及本次备份位置；不能拿历史普通Brain基线覆盖更新后的P2。

主实现候选锚：`0e1f2cd4e7a900d8e2ab5b8736ddc0c3c5af5529`（无生产部署）。

## 优先关闭数据功能

已发布情况下，管理员向 `/v1/device/ark/admin/settings` PUT `{"enabled":false,"subjects":[]}`（现有admin Bearer，不能把token写进文档/命令历史）。此操作清本功能grants与当前快照，不改Analytics事件、原始对话、画像、搜索/倾听开关；无需整库回滚。返回后GET settings应enabled=false、subjects为空，preview为空，设备state403。已在途请求会重新核grant，不泄漏已撤授权事实。

注意：关闭数据门不会回退静态G1知识纠偏与动态记忆过滤；如这些代码需回退，按下面单文件处理。若接口本身不可用，交总调度按其进程/文件备份恢复，不在多会话中争抢重启。

## 本次文件范围（路径均相对 apps/server）

| 范围 | 新增/修改 | 回滚方式 |
|---|---|---|
| src/ark/*.ts、src/routes/ark.ts | 新增功能模块 | 关闭门控；撤销调用后可留文件，不影响旧业务 |
| src/routes/custom-llm.ts | 按需临时事实、动态历史过滤、跳过当前动态画像/onboarding抽取 | 只撤本次差分，保留现役搜索/天气/倾听和其他会话修改 |
| src/conversation-store.ts、src/extract-scheduler.ts | 新增动态审计memory_excluded标记及idle透传 | 撤本次调用差分；新增列可保留，原审计文本不动 |
| src/memory-extractor.ts | 动态窗口阻止长期抽取（含idle） | 撤本次入口过滤；不要回滚profile.db，不删除审计记录 |
| src/xiaoke-kb.ts | G1奖励与旧夜航分离 | 可保留纠偏；需要回退才撤e6f330ec差分 |
| src/index.ts | 挂载新API | 撤新import/route；不换整文件旧版本 |
| src/device-registry-store.ts | 安装可选epoch、严格身份读取 | 撤本次import/安装/方法；现有授权签票逻辑未改 |
| src/analytics/device-context.ts、src/analytics/index.ts | 内部有界历史摘要 | 撤本次新增方法/路由/类型；旧摄入协议保留 |
| src/analytics/store.ts | 新时间索引 | 可以保留，无需恢复旧库 |
| package.json、scripts/ark-*.test.ts | 专项测试入口与合成测试 | 不进入生产热路径 |

## 数据库和部署注意

- `ark.db` 是新独立库（默认 ./data/ark.db，可由ARK_DB_PATH指定），仅保存设置、最多32份授权与每SN一份当前快照；没有无限事件收据表。关门后可保留空库。保留库文件权限0600；使用独立绝对路径便于备份。
- devices.db新增 `ark_device_epoch` 与 `ark_identity_*`触发器，捕捉注册/删除/换绑/禁用/parent变化/撤销变更。默认关也会在候选进程启动时尝试此增量迁移；失败只关闭方舟严格身份能力，不阻断旧Brain。回退旧进程后可保留这些增量结构；**不要删除epoch后继续使用旧grant**，需要移除结构时先关门清grant，由总调度受控处理。
- conversation.db增量添加memory_excluded INTEGER DEFAULT 0，原行和原始文本保留。旧版本INSERT有显式列名，回退时可保留该列；不可因此整库恢复。新版本需同时发布conversation-store/extract-scheduler与memory-extractor，避免丢失idle标记。
- Analytics新增只读ark.db依赖：两进程设置同一ARK_DB_PATH绝对路径并核文件访问；关门/无匹配grant时内部摘要拒绝，缺依赖降级未知。它不会开启Analytics上传。
- analytics.db新增 `analytics_ark_device_received(device_key,received_at_ms DESC,occurred_at_ms DESC)`。首次创建可能需要扫描现有事件并占写锁，**未测生产索引耗时**；总调度发布前看规模、备份并规划Analytics单独重启，不能假定默认关就没有DDL成本。已有数据与结算协议不变，不恢复旧analytics整库。
- 生产回滚不自动关闭原Analytics上传、不改夜批23点，不修改Rust二进制、不撤RTC修复。
- 本功能同时涉及Brain和Analytics源码；不能只发Brain后声称历史查询可用。缺内部接口时语音降级未知，但须在发布记录明示历史未接通。

## 发布前和回滚后复验

总调度先将候选差分与**当时实际运行文件**逐项合并，避免回退此后并行修改。必要时把本功能差分移植到独立部署分支，不整树rsync。备份本次受影响文件、ark设置、devices schema和Analytics索引清单，配置默认关；核正式网关新device/admin路径、内部摘要只对loopback与内部token开放。两套Brain/P2源码不同，逐份合并验证，不能覆盖15份现役差分。

运行 `npm run test:ark` 及相关旧回归；目前全量tsc存在已证实基线12错，不得写成全量通过。回滚后验普通聊天、天气/搜索与RTC唤醒、倾听的原功能，另确认state403、预览无授权事实、无新增线上合成事件。

署名：codex（OpenAI）| 2026-10-31
