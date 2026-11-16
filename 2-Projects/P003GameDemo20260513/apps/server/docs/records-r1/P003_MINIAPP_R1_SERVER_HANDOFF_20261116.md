# P003 小程序真实数据 R1｜服务端开发与联调回执

**服务端开发、Grok独立复审和单C机部署已完成；安卓真实上报→小程序展示仍待双方执行。**

发布时间：北京时间 2026-11-16 20:01:50。服务：`https://kidshub-ai.hahaxiong.cc`。
目标：**BJP00326081002000031**（C机），public_id **dev_50b5415662259045**。只开放这台设备的新records接口；原账号、设备凭据、grant、epoch和旧快照链路保留。
运行源码：`997fe83243134407237e923ff632fd80edb562fd`。原工作树/分支 `codex/p003-mini008-realdata-20261111`；开发352、Grok356/359。回执直接交付主会话13，不依赖左侧正文显示。五台ASR诊断与PRnas T3均未变更。

## 本轮结果

| 验证 | 结果与边界 |
|---|---|
| 当前Linux Node22隔离 | 记录HTTP/SQLite32/32、原dashboard16/16、Telemetry37/37、schema59/59 |
| Grok固定归档独立复审 | 32/32、schema59/59、追加钱包/异常隔离8/8；不将重复套件相加成独立样本数 |
| 公网与本机接口 | context/家长分页/dashboard均200；错账号两读取404；非法空批次400且无ACK |
| 发布前后兼容 | 原ark、usage、device、today、week字段逐项相同；六文件SHA与固定候选相同 |
| 稳定性 | 主后台PID 2203104，发布后观察124.3秒同PID、无额外重启；其他PM2服务及Worker保持 |
| 真实业务记录 | 当前新表0条；没有伪造设备奖励。真实上传成功、设备outbox和手机页面仍待测 |

公网检查使用服务端短期签名测试令牌，只做读取及非法空批次；不是安卓实际凭据/手机登录A/B验收。新记录SQL故障已修复：dashboard原资产、时长、设备状态正常返回，新记录区单独dependency_unavailable；上传和分页503时不伪造ACK。原Ark故障仍保留原503行为。

## 安卓与小程序现在怎么配合

1. 安卓先用C机现有Device Bearer读取context，确认`contract_version=p003.ark.records.r1`并持久保存原context；旧余额与卡库存继续原`/state`，不要塞新字段。
2. 产生一笔**真实领取或道具使用**，保存不可变record_id/save_id/sequence和原context，与业务事务/outbox可靠交接；合批上传并按accepted/duplicated逐ID清队列。断网、503及不完整响应保留原ID重试。
3. 小程序用现有登录token及C的public_id读取records分页；同一record_id在安卓ACK、服务器持久记录和页面中对齐。刷新首屏才纳入后续补传；换账号清掉旧cursor及缓存。
4. 双方回传完整SN、APK/小程序版本、北京时间、batch_id/record_id、HTTP状态、ACK和pending变化；不要发送token或家长手机号。
5. 错账号404、重复重放不重复计入、离线恢复不丢记录、重启/强杀后outbox保留，由双方按下表完成真实联调。服务端已就绪，无需再次等待接口开发。

| 用例 | 期望 |
|---|---|
| C现有凭据context | 200，原授权上下文有效，读取limits；不重绑/重签 |
| 真实一笔领取及道具使用 | 逐ID accepted，云端记录与端侧完全对应，多资源同笔原子接收 |
| 原ID重复/断网恢复 | duplicated或首次accepted；不新增奖励、不篡改旧记录 |
| 改payload重用ID | 逐条冲突拒收，保留原记录，不能换ID绕过 |
| Launcher/Runtime重启与强杀 | 未ACK保留原ID，逐ID结算，不以HTTP200清整个队列 |
| 家长读取/翻页/补传 | 自己设备200，同一高水位不跳页；新补传刷新首屏可见 |
| A/B切账号 | 他人设备404，页面无旧账号缓存数据；需真人手机确认 |
| 空值与GM | 未知保持null，真实0才显示0；GM不作正常收益 |
| 旧链路回归 | 设备状态、使用时长、余额、补勤卡库存仍正常 |

**展示边界：** 昨日收益和最新物品两个摘要目前为policy_pending；可先展示已同步业务记录列表，不能把摘要null变成0，也不能自行按余额变化造收入。该两项口径不阻塞可靠采集和分页开发。

**开启范围：** records只C机，没有短时自动关窗，保持用于联调，后续按主13通知关闭；不是扩到ASR五台或全量设备。容量是单C内测预算，不是50台承诺。

## 回滚记录

原源码两文件/新增四文件逐SHA备份：`/root/p003-records-r1-20261116/six-source-backup`；配置及Ark/devices安全快照：`/root/p003-records-r1-20261116/before-production`。
回滚先停新records接收，保留端侧未ACK队列；只撤本次C允许项和六文件，保留其他配置/凭据。数据库新记录及去重证据保留，禁止整库回灌。发布/回滚/重复回滚及漂移拒绝已隔离验证，不冒充实际生产回滚。

## 接口

|方法|路径|身份|行为|
|---|---|---|---|
|GET|`/v1/device/ark/records/context`|现有 Device Bearer|只读当前有效grant，返回原grant/epoch、not_before、服务器时间和实际limits|
|POST|`/v1/device/ark/records:batch`|现有 Device Bearer|50条／256KiB body／32KiB单记录；原子记录、逐ID ACK|
|GET|`/v1/parent/devices/{publicId}/ark/records`|现有家长Bearer|当前owner及当前grant/epoch；分页只读|
|GET|既有dashboard|现有家长Bearer|增加`data.records`，两个摘要policy_pending，原device/usage/ark不变|

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

`coverage.complete=false`恒定；范围只描述当前过滤集合已收到记录。无记录四个边界和updated_at_ms均null；不能把没收到当真实0。dashboard两个摘要保持不可用、policy_pending（未开则not_enabled；新记录查询故障为dependency_unavailable且不影响原资产/时长/设备状态）；家族币/星尘null，items=[]。不回退旧normal，gm/unknown在列表明确标记；正常余额和卡库存仍走旧Ark。

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
