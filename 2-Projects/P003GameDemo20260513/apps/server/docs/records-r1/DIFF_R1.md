# R1 实施技术细化，交主13审查（未宣称安卓已接受）
C SN BJP00326081002000031。contract_version 仍 p003.ark.records.r1，未部署。

1. 单C预算默认每SN/全局各 10,000 条、32 MiB canonical payload；磁盘可用需至少8 GiB并预留单条写入余量。不是50台预算；共享盘实测见CAPACITY_AUDIT.json。配置为正安全整数，非法配置fail closed。context.limits新增容量/磁盘/游标TTL/未来时钟阈值；频率返回实际生效值，替代样例固定literal校验。
2. 父分页新增 item_references 数组：每个 activated 对应 {item_instance_id,acquired_record_id,status:pending|resolved}。原item_changes不可变；原合同要求“引用未齐暂标”但未定义字段，此处补齐。引用解析严格同save、owner、epoch、grant且获得sequence小于激活；按本次游标高水位解析。pending不是active库存证明。重复获得同一实例或已知不兼容引用返回item_reference_conflict。
3. SQLite BEGIN IMMEDIATE同时锁ark与ATTACH devices；只写ark，事务内复核凭据过期/撤销/绑定版本与grant身份。ACK在COMMIT之后。整批预检后每条再检查；中途权限变化返回503整批重放，已提交项仍去重。
4. 限流使用ark内小型固定时间桶计数（分钟/小时，持久化，和旧管道独立），不是队列；窗口边界最多相邻两窗突发。仍每SN6/min、120/h，全局12/min、240/h，context6/min，429 Retry-After60。客户端合批至少30秒。
5. 慢body读取到期统一503，无ACK；公开错误码遵守合同不新增408。无有效records授权时dashboard.records独立not_enabled，已有Ark/Telemetry照常。

供主13最终冻结/转发。仅服务端本地候选，客户端、手机、真机未验。
署名：codex(OpenAI) | 2026-11-16
