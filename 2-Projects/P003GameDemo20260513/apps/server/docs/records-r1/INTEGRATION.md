# R1 本地联调交接

**摘要修订（2026-11-16 20:57:01 已发布）：两个摘要已按已同步记录实现，不再恒定 policy_pending；当前C新记录仍0条，真实端到端待端侧接入与手机对账。最新回执以 P003_MINIAPP_R1_SERVER_HANDOFF_20261116.md 为准。**

C SN **BJP00326081002000031**，public_id **dev_50b5415662259045**。服务端已于北京时间2026-11-16 20:01:50部署，records仅C机开放；原 owner／凭据／存档／队列不动。安卓和小程序按本说明并行开发/联调；这里没有“安卓已接受”或真机通过结论。

## 接口

|方法|路径|身份|行为|
|---|---|---|---|
|GET|`/v1/device/ark/records/context`|现有 Device Bearer|只读当前有效grant，返回原grant/epoch、not_before、服务器时间和实际limits|
|POST|`/v1/device/ark/records:batch`|现有 Device Bearer|50条／256KiB body／32KiB单记录；原子记录、逐ID ACK|
|GET|`/v1/parent/devices/{publicId}/ark/records`|现有家长Bearer|当前owner及当前grant/epoch；分页只读|
|GET|既有dashboard|现有家长Bearer|增加`data.records`，两个摘要按已同步记录计算（口径见下文），原device/usage/ark不变|

新增响应与dashboard为 `Cache-Control:no-store`。新能力允许名单默认空；`ARK_RECORDS_SN_ALLOW` 必须同时是原Ark ceiling、有效grant的子集。本次主13已完成部署，显式允许名单仅C；原Ark授权不变，不自动扩容。

完整字段看 SERVER_CONTRACT_R1.md + DIFF_R1.md；可执行schema.mjs、synthetic样例examples.json已含实施细化。原协调目录schema/59例保留为主13此前审核版本，不静默替换。`node docs/records-r1/validate.mjs` 验本目录实施schema；实际服务器HTTP测试在 scripts/ark-records.test.ts。

## 安卓

context是原授权上下文，不是新凭据。首次成功且版本匹配后，真实业务事务一次性持久化save_id、sequence、record_id、原context和outbox。旧记录重试不重写任何字段；换绑／撤销后隔离旧队列。无原context的接入前历史留本地unattributed；不能自动套当前owner。旧`/state`严格schema不变。

同ID同canonical内容duplicate；同ID异内容、save/sequence复用、真实business_source_id换ID均显式冲突。单笔多资源／物品整体提交；accepted/duplicate只表示云端持久接收，不代表收益摘要可展示。COMMIT之后形成ACK；503可能已有前条提交，整批原ID重放。客户端校验batch_id、互斥集合和请求内ID；仅结算明确accepted/duplicate。HTTP200不能清整个队列。

超过24h同grant历史可收；早于原grant的已知时间拒绝。unknown时间保留null；超过首次接收+5min持久标clock_suspect。首次接收和time_status不随重放变化。不要人为改时间“修复”被拒记录。

|结果|动作|
|---|---|
|400|修正信封，保留原记录；批内ID重复整批拒绝|
|401|沿现有凭据恢复，不新签或清应用|
|403|保留并退避至少15min；上下文改变隔离旧队列|
|413|缩小批次，禁止拆单笔业务；单笔超限保留dead-letter|
|429|读取Retry-After（默认60秒）；保留队列|
|503、断网、响应不完整|整批安全保留并原ID重试，指数退避30秒到15min|
|200 rejected容量|retryable=true，至少15min退避|
|200其他rejected|retryable=false，保留原文dead-letter，禁止换ID绕过|

## 小程序

`limit`默认20最大50；可选`save_id`、`resource_id`、`from_day/to_day`（真实发生的北京时间自然日）。unknown/clock_suspect不参加日期过滤。过滤命中仍返回整笔资源/物品，不能拆分为多笔收入。

首屏固定ingest高水位；后页原样带cursor、limit和全部过滤条件。按可归日occurred_at DESC，save_id ASC，sequence DESC，record_id ASC；未知/异常时钟排后。补传只在刷新首屏出现。400 cursor无效或改了过滤，410过期刷新；换归属404。切账号需丢弃旧请求、设备缓存及cursor（客户端未验）。

ParentRecord不含origin_grant_id/epoch/SN/owner。`item_references`是实施细化：每个activated返回pending/resolved；resolved须同save/原归属/sequence，且目标在该分页高水位内。item_changes是原始事实，不修改成当前库存。activation不再次加数量或收入；尚无可靠当前save/tank指针。

`coverage.complete=false`恒定；范围只描述当前过滤集合已收到记录。无记录四个边界和updated_at_ms均null；不能把没收到当真实0。dashboard 两个摘要按 SERVER_CONTRACT_R1.md §7 计算：昨日已上报正向领取收入、最近已同步获得整组。符合条件时 available=true/reason=partial_history；没有数据 no_records/null/空数组；未开 not_enabled；新记录故障 dependency_unavailable，不影响原资产/时长/状态。未知时钟导致最新物品 clock_unknown；最新非normal不回退旧normal。正常余额和卡库存仍走旧Ark。不能将当前缸/完整库存/昨日全量收入作为摘要标题。

## 默认容量／配置

除协议大小外均可用 `ARK_RECORDS_` 前缀配置，值必须为正安全整数，非法值fail closed。context返回生效值。

|键后缀|默认|
|---|---|
|UPLOAD_PER_MINUTE / UPLOAD_PER_HOUR|6 / 120|
|GLOBAL_UPLOAD_PER_MINUTE / GLOBAL_UPLOAD_PER_HOUR|12 / 240|
|CONTEXT_PER_MINUTE|6|
|PER_SN_RECORDS / GLOBAL_RECORDS|10,000 / 10,000|
|PER_SN_PAYLOAD_BYTES / GLOBAL_PAYLOAD_BYTES|33,554,432 / 33,554,432|
|MIN_FREE_BYTES|8,589,934,592（8GiB共享盘余量）|
|CURSOR_TTL_MS|1,800,000|
|FUTURE_CLOCK_TOLERANCE_MS|300,000|

限流是SQLite持久固定分钟/小时桶，重启不清；边界可有相邻两窗突发。容量包含所有历史代际，保留去重，不自动TTL。payload额外还有表/索引/WAL，写前保留磁盘余量；不能按50台乘单台上限承诺当前Ali够用。当前预算审计见CAPACITY_AUDIT.json，后续增长/PRnas容量需另核。

## 验收边界

本地真实HTTP＋SQLite使用synthetic身份与临时数据库，无生产伪记录。已验证失败回滚、SQLITE_FULL、双连接撤销、body竞态、逐ID ACK、跨代际、稳定分页、容量限流及旧mini008回归。

公网已由服务端临时签名令牌核验context/分页/dashboard 200、错账号404、空批次400；未提交合成业务记录，也不代表手机登录与安卓实际凭据已通过。

未验：Android/Rust业务与outbox同事务、强杀断电、Launcher durable ACK、真实SN/版本回读、手机页面、真实家长A/B公网token、真实focus/normal记录、真实峰值与长期负载。原mini008三方验收保留。旧Telemetry历史只有SN没有epoch，换绑后旧usage仍可能可见（已隔离复现）；本轮未改变或清理旧数据。该问题不影响新records按原归属隔离。

整树现存限制：ark-currency-http三个语音路由测试与listening-content.ts缺GeminiLlmClient.abort的类型错误，在未含R1基线同样失败。发布只涉及六个R1源文件，不能整树rsync。源码回流的现役daily/history/币种文件仅为准确本地基线，不在发布清单。

署名：codex(OpenAI) | 2026-11-16
