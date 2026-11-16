# mini009 兼容修订 · 2026-11-16

本修订实现旧客户端 `p003-ark-records-r1`，与原 `p003.ark.records.r1` 并存。同 POST、原 Device Bearer；原 v1 请求/ACK 不变，未知合同拒绝。实际上线、开关与实机状态以本目录 `RELEASE.json`、`POST-RELEASE-PROBE.json` 及总联调回执为准。

- 请求沿用[原客户端合同](../../parent-history-20261116/P003_ARK_RECORDS_CLIENT_R1_20261116.md)：完整信封及 baseline/business_commit，16条/64KiB、单条32KiB、ID最长96，安全整数/层深/已知字段严格校验。`schema.mjs`继续描述原v1；兼容执行schema见`src/ark/records-legacy.ts`，真实Runtime序列化夹具见`scripts/fixtures/ark-records-mini009-runtime.json`。
- 原ID、save、sequence及规范化原文/hash存`ark_record_legacy`；跨格式ID/序号冲突不覆盖。同内容重放duplicated，只有耐久写入才accepted；永久错误保原ID rejected。容量/依赖暂时错误整批503，限流429，Retry-After保旧端pending；部分先入库后503，下次原ID重放即可。
- 私有`ARK_RECORDS_LEGACY_SCOPE_JSON`冻结完整C授权元组及允许save范围。原发生归属未验证；页面标`authorization_source=legacy_explicit_scope,origin_verified=false`，不补造origin。换绑/换回/Ark重授失效，读事务释放后复核，其他设备默认无兼容授权。
- `ark_records.enabled`仅允许per-SN明确设置，未设置设备不新增快照字段；实际GET配置还核当前授权。旧客户端精确对象为`{"enabled":true,"contract_id":"p003-ark-records-r1"}`，服务端恢复不等于旧mini008已具备流水生产者。
- 现家长分页合并两来源，双水位固定窗口；save过滤支持96字符，其他原过滤保持。返回原核心字段，兼容记录附`format/record_kind/authorization_source`；baseline单独附`baseline.wallets/items`，不塞入收入delta。状态变化附`inventory_state_changes`，不伪造实例引用。
- 补勤卡以真实inventory为准，映射`M-CARD-001`资源增减；钱包/库存同ID冲突保未知，不双算，不作为最新部件。币种只显式映射已知ID。
- 收益按**Runtime真实提交墙钟** `record.occurred_at_ms` 的北京时间日期，合格normal grant与钱包对账后计入。动作开始时间`granted_at_ms`和逻辑日保留原文，不决定归日。同save/reward原实例去重，最早sequence决定原日及证据；任何原事实/模式冲突剔除该奖励，不按补传顺序改日期。
- 最新获得先在每save跨格式取最大sequence，再跨save比真实时间；GM/unknown/未知时间不回退旧normal。legacy按库存差异生成标注派生的展示键，激活仅更新legacy获得；v1仍需精确实例引用。baseline不算收入/新获得，coverage永远不冒完整历史，dropped最大值不因重试归零。

验证为隔离HTTP/SQLite、真实格式夹具、页面映射/渲染与构建；生产探针只GET和无业务空POST，绝不向生产造奖励。本轮实际设备/手机证据另记，不把服务端签名探针当设备上报。

署名：codex（OpenAI）| 2026-11-16
