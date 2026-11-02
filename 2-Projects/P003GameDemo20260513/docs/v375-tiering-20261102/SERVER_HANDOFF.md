# P003 v375 分层埋点服务端交接

本包为服务端候选，发布/设备开关仅由主会话13执行。48没有部署、没有给真实设备写合成数据。
客户端合同：源码52b89ec9a4823eb62b424f094d613b4a09a10708，v375 / 1.2.2-canary.361；详见CLIENT_CONTRACT.md。APK版本不等于运行PCK具备分层能力，真机必须验证配置消费及实际桶生成。

## 实现边界

- 保持57类raw合同，新增analytics.periodic_aggregate与analytics.on_demand_sample。旧raw表形状、Ark事实及幂等不变；新载荷独立表，不能挤占Ark raw扫描预算、计算余额/奖励或写长期人格。
- 精确12种聚合来源/维度、14种样本来源；嵌套源事件继续按旧隐私合同验证。周期按Unix epoch对齐CST整日，固定配置7天；接收旧7～31天合法队列兼容。count限1～10亿。新聚合严格要求period_end_ms<=服务端receivedAt（零未来容差），等于边界才可收；未闭合仅该ID以invalid_properties拒收且不占seen，同批raw照常。已有ID重放先去重，服务器时钟回拨不导致二次结算。真机必须先核对设备时钟，不能将提前闭合的计数当完整周期。失败/奖励/钱包等仍raw。
- gzip是整请求压缩；wire/inflated分别2MiB，15秒读取解压界限，异步zlib；最多2个HTTP请求，单writer、无排队、8秒写入deadline，现有内存/磁盘/WAL保护保留。JSON413可拆批；错误/截断/CRC400；不支持编码415；超时/忙503带Retry-After，不能用400表达单条样本无授权。
- ACK仅在事务提交后发；accepted/duplicated/rejected覆盖且互斥。raw/gzip同义。新样本授权失败仅该ID rejected，混批raw正常结算。
- 聚合/样本已进Launcher的队列不因后续双开关关闭而自动消失；服务端仍接受合法聚合，样本需有效服务端请求。已接收样本即使请求撤销/到期，精确重放仍duplicated；同ID跨新请求只忽略context.request_id/session路由元数据，其余源内容变化仍冲突，不重占额度。

## 保留策略

|数据|云端保留|说明|
|---|---|---|
|raw payload、批次/逐条回执/传输明细|14天|原策略不变|
|aggregate payload|90天|按接收时间；不扩写raw|
|diagnostic payload|3天|按接收时间；与本地样本TTL独立|
|raw事实、日汇总、分层/传输日统计|90天|有界维护|
|event_seen、诊断请求元数据/额度|持续保留|无原始正文；避免无限期inflight重试重新accepted、限额重置|

新增表均CREATE IF NOT EXISTS，无旧表列变更/回灌。TTL每轮有界；上线前只读核数量，不能借本次发布大删历史。永久元数据会增长，现役容量模型保持保守，不据合成压缩比放大设备数。当前只读快照容量上限4台，仍仅038开通，不是20台容量通过。

## 后台及接口

路径：Worker → 数据埋点 → 分层与按需。按完整SN保存，默认四开关false；固定周期7。可配置本地队列大小/保留期，查看近7接收日的层记录数、代表次数、载荷字节、传输字节、最近10条及请求限额。保存后回读仅证明云端保存，不显示设备已应用。

所有外部管理API沿用管理后台admin认证，非admin拒绝。不要将admin凭据发给设备。
- GET `/api/admin/analytics/tiering/{SN}`：revision/analytics/requests/runtime/client_applied=false。
- PUT 同路径：`{"expected_revision":"取自GET","settings":{"request_gzip_enabled":true}}`，可在settings加入tiering_enabled、aggregate_upload_enabled、on_demand_capture_enabled与本地队列参数。CAS冲突409需重新读。
- POST `.../{SN}/requests`：`{"expected_revision":"取自GET","allowed_event_names":["settings.opened"],"ttl_seconds":3600,"max_events":100,"lookback_days":3}`。
- DELETE `.../{SN}/requests/{request_id}`：撤销该SN请求。ID只由服务端生成，禁止通用config接口绕开；最多1个有效请求，10个/24h/SN，60秒～24h、1～1000新样本、回溯1～14天。
- 创建请求要求双开关已保存且接收端就绪、设备已获准上传；自动capture=true/upload=true。关闭capture会同时撤销请求并明确下发upload=false/id空。
- 到期摄入立即拒收新样本；设备配置GET或管理GET会清upload/id并递增revision，等待设备下拉应用。入站在写入派发前取一次授权快照；已派发的最长8秒批次可以结算，不承诺撤销中断正在提交的事务。
- 内部只读 `/internal/analytics/tiering?sn={SN}` 仍仅loopback和专用secret，不对外开放。

## 单机真实联调顺序与用例

目标仅BJP00326070803800006；先由13核可信注册/Device Bearer sub、当前上传总闸/范围/hour=23及现役BLE绑定状态，不能只凭末8位。

1. **发布但保持新开关关闭**：raw上传/ACK/后台可查，普通语音、倾听、搜索、Ark问答冒烟。核最近实际部署SHA，保留搜索/微信/BLE最新增量。
2. **仅gzip=true**：设备下拉明确revision，核Launcher真正应用；产生一个真实事件，记录RID/ID/时间/批数。服务器传输明细encoding=gzip，wire/inflated可查；raw入库/精确ACK与重放一致。检查公网代理413仍JSON，不调其他设备。
3. **tiering=true + aggregate_upload=true同时打开**：只有11才生成新桶；00/01/10均raw。先核运行PCK实际收到配置、本地12类桶计数，关键失败/奖励/余额事件仍raw。不要用单开tiering声称本地分层通过。
4. **闭合周期**：按客户端当前周期起止记录实际时间，闭合后在23点策略中上传，按同一RID/ID核count/维度/最大值与云端一条记录。7天窗口未完成前标待验，不改设备时钟制造“真实7天”。
5. **短期按需**：建议22:50～22:55由后台限定来源创建60分钟、100条、回溯3天请求，覆盖23点日批及重试；端侧核完整ID/config revision。产生/上传真实样本后核source_context/source_properties、数量和额度。重放只dup，不再次增加。后台撤销，后续新样本应逐条rejected、混批raw仍accepted。
注意：v375的on_demand是Godot样本交接控制，不是即时HTTP通道。Launcher普通append不触发网络，onRuntimeConfig仅event_upload_enabled从false→true才forceResume；单改request ID/gzip/tiering仍走日批/历史补传。若当天日批已完成，新请求需等待下一次日批且TTL覆盖实际上传，否则到期样本会按合同被拒收。不要为验收擅自翻总上传开关、改23点或承诺“创建后立即到账”。客户端只需按原日批联调；超出24h/即时诊断需求另行评估端侧调度支持。

6. **恢复**：显式false关capture/tiering/aggregate/gzip并回读；capture关闭同时清upload/id。确认设备新revision已应用，旧队列按合同继续结算。保留原上传单038/23点和其他功能配置。

测试对账表至少记录：SN、客户端/APK/PCK版本、配置revision、服务端SHA、CST时间、RID、event ID、请求ID（不同于RID）、accepted/dup/rejected原因、实际各层数据库数量、后台结果。禁止正文/令牌进入回执。

## 验收证据与未验项

针对性自动测试：`npm run test:analytics-v375`（真实本地socket/admin/SQLite writer、gzip/CRC/膨胀/慢体并发保护、精确ACK、请求越权/额度/撤销/到期、跨请求/重启去重、TTL隔离、统计、BLE绑定版本）。旧回归：test:analytics、test:analytics-capacity、test:analytics-control、test:ark；device-config与7项倾听回归另有日志。
后台：`node apps/web/scripts/test-analytics-admin-ui.cjs`，生产Vue模板/真实WebKit、合成API，44项，包括默认不开启、保存回读、创建撤销、接收端不可达、迟到响应不污染退出后的会话。截图是本地合成数据，不能充当线上验收。
全仓tsc仍有12项基线已有错误（listening-content 1项、amap-weather 11项）；独立9e7aab98归档复现且候选错误集合相同，不能写全仓typecheck通过。
独立45复核另附REVIEW；真机/PCK、公网代理、生产负载/真实语音和7天节省率均待13部署后联调，不能据本地测试宣布通过。

署名：codex（OpenAI）| 2026-11-02 CST
