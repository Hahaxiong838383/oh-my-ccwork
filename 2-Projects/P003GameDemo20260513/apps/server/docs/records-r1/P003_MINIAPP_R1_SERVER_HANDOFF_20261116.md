# P003 小程序真实数据 R1｜开发与联调回执

**服务端候选开发与独立隔离验收已完成；尚未部署，真实设备与小程序联调未通过。**

本回执直接回传主会话13，不依赖左侧会话正文是否可见。原开发会话352，Grok独立评审356。固定运行候选 fe76919cda3a7df4491796844bbb344b0f09bd46；合同修正提交 a4a9ec823e83ad976c968ab3fd83de3d7034eaaf，均已推送。

目标设备：BJP00326081002000031（C机），public_id=dev_50b5415662259045。沿用现有账号、凭据、绑定和授权。

## 开发与自检结果
- 已实现真实业务记录的授权上下文、批量持久接收、逐ID ACK、幂等重放、原账号代际隔离、家长分页及dashboard记录区。
- 主实现固定归档127/127、schema59/59；Grok独立真实loopback HTTP/SQLite31/31、schema59/59，并测异常配置、慢body和钱包无副作用。不同套件不重复相加为新总数。
- 新链路不发币、不改余额，不用快照差值造收益；现有余额、补勤卡库存及使用时长继续原链路。
- 合同的item_references和容量文字已按实现补齐：每SN/全局默认各10,000条、32MiB，保留8GiB共享盘余量。不是50台容量承诺。
- Grok指出的dashboard故障隔离待补：记录库异常不应拖垮原资产/使用时长。主13下一阶段优先修复并回归，再推进受控发布。

## 后续并行配合
安卓可按以下合同实现业务记录/outbox/逐ID结算；小程序可并行实现分页、空态和账号切换缓存清理。开始真实上传前，以主13随后给出的部署回执和开窗结果为准，不把本地开发通过当服务器已开放。
昨日收益和最新物品两个摘要继续policy_pending；核心采集/分页开发不依赖其产品口径，不能自行把null渲染为0或按余额差计算收入。下一阶段不启动PRnas T3，也不修改五台ASR诊断窗口。

## 接口

|方法|路径|身份|行为|
|---|---|---|---|
|GET|`/v1/device/ark/records/context`|现有 Device Bearer|只读当前有效grant，返回原grant/epoch、not_before、服务器时间和实际limits|
|POST|`/v1/device/ark/records:batch`|现有 Device Bearer|50条／256KiB body／32KiB单记录；原子记录、逐ID ACK|
|GET|`/v1/parent/devices/{publicId}/ark/records`|现有家长Bearer|当前owner及当前grant/epoch；分页只读|
|GET|既有dashboard|现有家长Bearer|增加`data.records`，两个摘要policy_pending，原device/usage/ark不变|

新增响应与dashboard为 `Cache-Control:no-store`。新能力允许名单默认空；`ARK_RECORDS_SN_ALLOW` 必须同时是原Ark ceiling、有效grant的子集。部署和单C启用均归13，本包不改配置、不启动服务。

完整字段看 SERVER_CONTRACT_R1.md + DIFF_R1.md；可执行候选schema.mjs、synthetic样例examples.json已含实施细化。原协调目录schema/59例保留为主13此前审核版本，不静默替换。`node docs/records-r1/validate.mjs` 验本目录实施schema；实际服务器HTTP测试在 scripts/ark-records.test.ts。

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

`coverage.complete=false`恒定；范围只描述当前过滤集合已收到记录。无记录四个边界和updated_at_ms均null；不能把没收到当真实0。dashboard两个摘要保持不可用、policy_pending（未开则not_enabled）；家族币/星尘null，items=[]。不回退旧normal，gm/unknown在列表明确标记；正常余额和卡库存仍走旧Ark。

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

未验：Android/Rust业务与outbox同事务、强杀断电、Launcher durable ACK、真实SN/版本回读、手机页面、真实家长A/B公网token、真实focus/normal记录、真实峰值与长期负载。原mini008三方验收保留。旧Telemetry历史只有SN没有epoch，换绑后旧usage仍可能可见（已隔离复现）；本轮未改变或清理旧数据。该问题不影响新records按原归属隔离。

整树现存限制：ark-currency-http三个语音路由测试与listening-content.ts缺GeminiLlmClient.abort的类型错误，在未含R1基线同样失败。发布只涉及六个R1源文件，不能整树rsync。源码回流的现役daily/history/币种文件仅为准确本地基线，不在发布清单。

署名：codex(OpenAI) | 2026-11-16
