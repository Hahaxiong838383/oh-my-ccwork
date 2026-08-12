# Goal 7 Foundation 独立授权卡

日期：2026-08-12（Asia/Shanghai）

状态：`READY_FOR_SEPARATE_OWNER_AUTHORIZATION / NOT_AUTHORIZED`

## 1. 本次固定发布身份

- 公司 QNAP：`PRNas / TS-X65 / 192.168.61.18`；
- Foundation Root：`/share/CACHEDEV1_DATA/ai-ontology/foundation`；
- Runtime Workflow：`31607792883` Attempt `1`；
- Runtime Artifact：`9145915628`；
- Ontology Commit：`b504f1295bf98b018479556c06e1072516966562`；
- H-Lite Commit：`fab8be3f1467289400d0d63ffe378b63ad1a6957`；
- Agent Core：`2026-08-12.3`；
- Knowledge Connector：`2026-08-11.1`；
- H-Lite：`2026-08-12.1`；
- Collector Image：`sha256:59eadd7a3b95caa2a7a09604abb981b18f4ce8ec730408efd5f7d0f4efdfe39d`；
- Candidate Ontology：Schema `3.7.0` / Hash `c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860`；
- 发布开关：`publish=false`；
- 当前生产 active Schema：`3.3.0`，本次不得切换 active Schema。

任一发布身份变化，本授权卡自动失效，必须重新生成。

## 2. 当前只读基线

`2026-08-12 22:48 CST` 公网只读复核：

- Foundation `13/13 running`；
- unhealthy `0`；
- restart total `0`；
- 唯一宿主绑定 `192.168.61.18:19080`；
- Registry `in_sync`；
- 战略情报 Schema、表、容器、网络、发布端口均为 `0`；
- 正式 P2、员工投递、ERP 写回、社媒写回、因果激活均为 `0`；
- 候选 Artifact 尚未上传公司 QNAP。

## 3. 影响与时间

- 总维护窗口预计：`8～20 分钟`；
- 员工可感知间歇中断累计：`15～120 秒`；
- 飞书长连接会短暂重连，新消息由恢复型 H-Lite 先持久化；
- 公司 Bot 推理与知识检索会短暂暂停；
- 自动失败恢复预计：`2～6 分钟`；
- 不重启 Postgres、Redis、Qdrant、Ontology Registry、Action Gateway、Domain Connector、Gateway；
- 不运行 Collector，不启动七日 Shadow，不产生正式 P2、员工投递或业务写回。

## 4. 五项独立授权

以下五项互不继承。只授权其中一项，不代表授权其他项。

### A. Foundation 发布准备与 Artifact 入场

动作：把 Artifact `9145915628` 上传到公司 QNAP 受控 staging 目录，验证完整 Hash，备份现有 Compose、环境配置和三个旧镜像，构建三个候选镜像；不迁移数据库、不切换服务、不运行模型。

精确授权回复：

> 授权 Artifact 9145915628 进入公司 QNAP Goal 7 发布 staging，允许执行 Hash 校验、配置与旧镜像备份、三个候选镜像构建；不授权数据库迁移、服务重建、Worker 读回、Collector、Shadow 或真实回滚演练。

### B. 候选迁移 012

动作：执行 additive migration `012-goal7-authority-runtime.sql`，建立四张 Goal 7 表并验证 4/4 强制 RLS、真实 `ontology_app` 读写和无 DELETE；不切换 active Schema，不重建服务。

精确授权回复：

> 授权在公司 QNAP 执行 Goal 7 候选迁移 012，并完成 4/4 RLS 与 ontology_app 验证；不授权服务重建、Worker 读回、Collector、Shadow 或数据库逆向回滚。

### C. 三组件服务重建

动作：按恢复型 H-Lite → Agent Core → Knowledge Connector → H-Lite 恢复接单的顺序，重建 `h-lite`、`agent-core`、`knowledge-connector`；使用 drain/resume、健康检查和自动失败恢复，不重启其他 Foundation 服务。

精确授权回复：

> 授权部署 Artifact 9145915628 对应的 Agent Core 2026-08-12.3、Knowledge Connector 2026-08-11.1、H-Lite 2026-08-12.1，仅重建这三个服务；允许发布失败时自动恢复旧服务，不授权真实回滚演练、Worker 读回、Collector 或 Shadow。

### D. 真实 H Worker 双源读回与 Authority Canary

动作：发布健康后执行一次固定合成请求，读取同一 request 的 Worker 响应和 usage ledger，验证 provider/model/token usage；执行私聊、群聊、多人艾特、Purpose、撤权和正文前 ACL Canary。不得读取或输出真实员工正文。

精确授权回复：

> 授权执行一次 Goal 7 真实 H Worker 双源读回和合成 Authority Canary，仅使用固定测试请求，不读取真实员工正文，不运行 Collector，不创建 P2，不投递员工任务，不写回业务系统。

### E. 真实回滚恢复演练

动作：在三组件发布及验收后，把三个服务恢复到发布前旧镜像并验证，再恢复到新版本；012 additive migration 保留，不执行 DROP。该动作会产生第二次短暂中断。

精确授权回复：

> 授权执行 Goal 7 三组件真实回滚恢复演练：旧版本验证后恢复到 Artifact 9145915628 新版本；保留迁移 012，不执行数据库 DROP，不运行 Collector 或 Shadow。

## 5. 自动停止条件

出现任一情况立即停止后续动作并进入安全恢复：

- 发布身份、Hash 或双仓 Commit 不一致；
- active Schema 发生变化或 Registry 不再 `in_sync`；
- 任一非目标 Foundation 服务被重启；
- 新增宿主端口；
- drain 超时、待送达回复无法归零；
- 三个目标服务健康检查超时；
- 出现正式 P2、员工投递、ERP/社媒写回或因果激活；
- Worker 无法真实读回 provider/model/usage；
- 权限撤销或正文前 ACL 未失败关闭。

## 6. 当前建议

建议先在同一条回复中分别明确授权 `A`、`B`、`C`，三项仍按独立门禁逐项校验和执行；发布健康后再单独授权 `D`。`E` 作为真实演练继续单独拍板。正式七日 `PUBLISH=false` Shadow 不属于本授权卡，仍需来源/P003/四角色 UAT、Goal 7 Owner Acceptance 和新的独立授权。
