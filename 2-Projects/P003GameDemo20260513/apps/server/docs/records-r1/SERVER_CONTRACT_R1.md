# P003 真实业务记录：服务端合同 R1

版本：`p003.ark.records.r1`，2026-11-16。状态：**技术合同候选已定稿，供主13复核后冻结和转发；新增接口未实现、未部署，不能开始生产上报。** 附件方向成立，但不能直接以附件当上线合同。本文与 `schema.mjs`、`examples.json` 为同一候选；修改须出修订，不能各端原地漂移。

对象：C机 **BJP00326081002000031**，`public_id=dev_50b5415662259045`，保留原owner、凭据、存档、队列。沿现有 Device Bearer / 家长 Bearer，绝不新建 Children、第二钱包、云端发币或远程兑换。

## 1. 已有能力与新增边界

|能力|确定入口/字段|状态|
|---|---|---|
|状态上报|POST `/v1/device/telemetry`，schema_version=1|已上线；每批最多50事件，每SN 240次/小时；不要改原ACK|
|状态读取|GET `/v1/parent/devices/{publicId}/dashboard?timezone=Asia/Shanghai` → `data.device`|已上线；`color_mode`已提供，cool/normal/warm由端侧约定；不是Kelvin|
|使用时长|`data.usage.today` / `data.usage.daily[]`|已上线；真实focus_segment去重、跨日、重叠规则；null不补0，不使用旧`data.today.focus_minutes`回填|
|姿态|`data.today.posture_alert_count`、`weekly-report.posture_alert_count`|已上线，只计outcome=played；异常轮和冷却抑制不计提醒；该旧计数缺测可返回0，不能据此证明完整覆盖|
|资产|POST `/v1/device/ark/state`；GET dashboard → `data.ark.wallets.{family_coin,stardust}`、`inventory["M-CARD-001"]`|已上线，严格schema v1；当前normal可读，unknown/gm返回不可用/null，不回退旧normal|
|新增记录|本合同以下四个接口/增量|**待实现**；不往旧Ark snapshot塞字段，不借Analytics日批做实时流水|

完整基础URL：`https://kidshub-ai.hahaxiong.cc`。所有新增响应 `Cache-Control: no-store`。旧mini008忽略新增字段、继续旧接口，完全无需重绑。新端必须先GET context成功且包含本合同版本，才开启records发送；404/不支持版本保留本地outbox，不能降级塞进旧state。

## 2. 最终技术路径（候选冻结值）

|方法/路径|认证|请求/响应|
|---|---|---|
|GET `/v1/device/ark/records/context`|原Device Bearer|`{ok:true,data:{schema_version:1,contract_version:"p003.ark.records.r1",origin_grant_id,origin_epoch,not_before_ms,server_time_ms,limits}}`；只读当前已有grant，不创建/续期/修改绑定|
|POST `/v1/device/ark/records:batch`|原Device Bearer|严格批次信封＋逐记录校验；见§3、§5|
|GET `/v1/parent/devices/{publicId}/ark/records`|原家长Bearer|分页只读；见§6|
|GET 既有 `/v1/parent/devices/{publicId}/dashboard`|原家长Bearer|仅新增 `data.records`，旧device/usage/ark语义不改；见§7|

新records准入为既有Ark有效授权范围的子集：实现计划增加独立records允许名单（默认空=拒绝，首轮仅BJP00326081002000031），不因既有Ark17台已开而自动开放全部设备，不新增管理台或另一grant体系。本轮未创建/修改任何线上开关；部署和启用由主13另行核验。

context不返回SN、家长账号、手机号或token。`origin_grant_id`就是既有grant的UUID，作为上下文标识而不是另一凭据；还必须校验Bearer、scope、active、当前epoch与grant。刷新context只影响之后新产生的记录；不得重标旧记录。正常重启/同一授权下离线可以沿用已持久化context；撤销/换绑/新grant不能沿用旧context。

## 3. 请求schema与业务语义

所有对象严格拒绝未知字段；整数必须JSON安全整数，不能字符串/小数/NaN。通用ID为ASCII `[A-Za-z0-9_.:-]`，1–80字符；日期为实际存在的YYYY-MM-DD；时间为1至8e12毫秒或明确null。`schema.mjs`为可执行结构与跨字段约束，下面为语义要求。

批次：`{schema_version:1,batch_id:string,records:Record[]}`；batch_id为此次信封标识，拆批可变，record永不变。每条Record必含下表全部键，nullable字段也显式传null。

|字段|类型/枚举|语义|
|---|---|---|
|record_id|ID|设备内全局稳定唯一业务事务ID；随机UUID等持久生成一次；不是上传ID|
|save_id|ID|真实存档标识，新档独立；重启/版本/授权改变不能伪装新档|
|sequence|安全整数≥1|同一save持久单调递增业务序号；提交业务与分配序号/outbox同一事务；换授权继续原save序号，不复用|
|origin_grant_id|UUID|业务产生时已持久化的原授权上下文，不从补传时的当前owner推断|
|origin_epoch|安全整数≥1|由context取得；不能自己编造或升级旧记录|
|occurred_at_ms|毫秒或null|真实业务提交时间，重试不变；未知时间null|
|time_quality|reported / unknown|reported必须有时间；unknown必须null；reported仅设备报告，不代表时钟已校准|
|logical_day|有效日期或null|游戏逻辑日；不拿HTTP到达日/自然日替代|
|source_mode|normal / gm / unknown|原真实来源；旧档不可自动升级normal；gm/unknown可保存，禁止进入正常收入/物品摘要|
|reason|reward_claim / tank_unlock / makeup_card_use / resource_spend / item_activation / gm_adjustment / unknown|真实提交类型；无可靠映射用unknown，不增加虚构业务。退款/冲正本轮不定义|
|business_source_id|ID或null|稳定奖励实例/解锁事务/消费事务来源ID；reward_claim、tank_unlock、makeup_card_use、resource_spend、item_activation必须有值|
|tank_id、stage_id|ID或null|真实语义关联；不可得填null|
|resource_changes|数组|每种资源至多一行；最多3行；对象`{resource_id,delta,before,after}`|
|item_changes|数组|0–32行；见下文；同笔事务完整入库、完整ACK|

resource_id只允许 `family_coin`、`stardust`、`M-CARD-001`；前两项与Ark钱包键一一对应；现役Analytics物料C-FAMILY-001→family_coin、C-STARDUST-001→stardust，卡仍为M-CARD-001。只做显式映射，不新造资源。delta为非0有符号整数（建议绝对值≤1e9）；before/after为0–1e9整数或null；二者都知道时 `after-before=delta`，只知道一个时不反推另一个。源业务如果真实值超出边界，保留原记录报错，不能截断/钳位后改报。服务端不累计成可写余额、不覆盖Ark。币、星尘、卡互不换算。

item_changes是discriminated union：
- acquired：`{operation:"acquired",item_instance_id,item_id,item_kind,quantity,state}`。item_instance_id是存档内稳定获得实例ID，item_id走端侧资源语义；item_kind=`tank_component|avatar_decoration|unknown`；quantity为正整数；state=`pending_activation|active|unknown`。
- activated：`{operation:"activated",item_instance_id,acquired_record_id,state:"active"}`。仅记录已获得物品状态变更，不含quantity，不产生再次获得或收入。先到激活、后到获得时保留记录，查询暂标引用未齐；引用到达后按同save/原归属/sequence归并。不同save/owner的引用永远不能相连。

resource_changes和item_changes不能同时为空。reward_claim/tank_unlock只允许正资源变化和acquired；makeup_card_use必须且只含M-CARD-001负变化；resource_spend只含币/星尘负变化且可带实际获得物品；item_activation必须仅含activated；gm_adjustment必须source_mode=gm。normal+reason=unknown仍不进入正式收益分类。本轮没有基于动画、余额差或展示采样伪造记录。

同笔多件以一个Record返回，前端可以显示整组；不拆成多笔收入。物品名称/缩略图由现有语义资源映射提供，不上报图片、Figma节点或任意文案。

## 4. 稳定身份、历史和原子性

1. Runtime业务变更、save_id、sequence、不可变Record和durable outbox必须同一可靠提交。bridge buffered仅表示内存接收；Launcher durable ACK之后Runtime才能移除交接副本，云端ACK之前Launcher不能删未确认记录。两个阶段都按record_id幂等。
2. 服务端只从Bearer sub取设备，再解析原owner、device account、epoch、grant。服务端入库固化 `sn, origin_parent_account_id, origin_device_account_id, origin_epoch, origin_grant_id`；body禁止SN/account/parent/public_id字段。
3. 唯一键 `(sn,record_id)` 和 `(sn,save_id,sequence)`，不把epoch加入ID唯一键来掩盖重标。同ID规范化内容完全一致→duplicate；同ID不同内容→record_id_conflict；同save/序号异记录→sequence_conflict。对五类已知业务原因（reward_claim/tank_unlock/makeup_card_use/resource_spend/item_activation），另唯一约束`(sn,save_id,reason,business_source_id)`：同来源换新record_id→business_source_conflict，防止生产端错误重造ID造成重复收入；business_source_id必须是该次真实提交/奖励实例，不是可重复使用的关卡ID。对象键顺序无意义、数组顺序有意义；canonical JSON比较，保存首次received_at_ms不变。去重前不能跳过当前权限检查。
4. 一条Record的头、所有资源/物品行、去重标记同一个SQLite事务；ACK只在COMMIT成功后形成。失败全部回滚。整批可部分成功，但每条绝不能半成功；没有钱包写入或外部发奖副作用。计划在现有ark.db增加记录表和索引，按当前部署源码增量实现。
5. 锁住权限检查和写入窗口：专用连接ATTACH devices.db，对涉及库BEGIN IMMEDIATE，在同一连接/事务内重读registry/epoch/revocation和Ark grant/master，校验后只写ark.db；不修改devices.db。请求体读取/异步鉴权后再次校验凭据。各记录事务短且有界；SQLITE_BUSY/磁盘错误无ACK→503。实现阶段必须以双连接撤销竞态测试验证，不把当前函数两次读当跨库原子性已成立。
6. 接受**同原grant/epoch**下超过24小时的离线记录，无按当前时间倒推的最老接收窗口；R1不沿用state的24h/stale规则，乱序sequence可收，缺口保留。已知occurred_at早于原grant.not_before_ms→before_origin_grant，隔离待核，不能自动套新授权。未知时钟可以保存且标不可归日；已知远未来时间保存但服务器标clock_suspect，禁止进入日期统计，不能修改重传原文。
7. grant/owner/epoch不一致或取消授权：整批403，原记录保留，至少15分钟退避。刷新context看到变化后旧队列转本地隔离队列；不能重签旧Record、换ID、换save、迁入新owner。没有原context的接入前记录保留本地unattributed待核，不自动回填。R1不提供历史归属重建/旧owner补传特权。
8. 家长只能读当前绑定、active、有效grant且同原owner/epoch/grant的记录。换绑后新owner看不到旧记录；旧owner也失去该设备入口。服务器保留历史原归属数据，不自动删、不自动迁移。原owner再次绑定也不自动恢复旧代际可见性。此为最小安全边界，不引入新账户体系。
9. 存档切换不改记录的save_id；分页可按save区分。当前save无法从旧Ark快照证明，R1不自动把最后到达save称当前存档；dashboard跨save最新语义未定义时返回不可用，不拿旧save覆盖新save。

## 5. ACK与失败矩阵

非200统一JSON错误信封`{ok:false,error:<下表错误码>}`，不会夹带成功ACK；Retry-After在HTTP头。

HTTP200：`{ok:true,data:{schema_version:1,batch_id,accepted_record_ids:[],duplicated_record_ids:[],rejected:[{record_id,reason,retryable}],server_received_ms}}`。

每个合法请求ID必须且只能出现在三个集合之一；ACK集合严格互斥、不得出现请求外ID。同批重复record_id为400整批拒绝。客户端校验batch_id和集合合法性；只结算明确accepted/duplicate的原ID，缺失项继续保留；响应截断/不合法保留整批安全重试。accepted表示已持久接收，不代表正常收益/当前物品可展示。父查询保留首次接收时间，ACK server_received_ms仅本次响应时间。

|返回|原因/动作|
|---|---|
|400|invalid_json / invalid_envelope / duplicate_record_id_in_batch；整批零写入，修复编码/信封后用原Record重试，不自动销毁|
|401|invalid_device_credential；沿现有凭据恢复，不新增签发、清应用或绕过撤销|
|403|not_enabled_or_authorized / origin_context_mismatch；整批零写入，保留≥15分钟退避；上下文改变转隔离|
|409|reserved用于整请求冲突（R1无常规触发）；一旦收到全批保留/隔离并上报，不能当duplicate。常规同ID冲突在200逐条返回|
|413|batch_too_large / record_too_large；整批零写入，减小批次但不能拆业务Record；单Record仍超限进dead-letter并保留原文|
|429|rate_limited，Retry-After秒；整批保留，按该值退避，缺失/非法回退60秒|
|503/5xx/超时/断网|暂时不可用；同ID重试，指数退避30/60/120秒至15分钟上限，带抖动；超时可能已提交，靠duplicate闭环|
|200 rejected|invalid_record / record_id_conflict / sequence_conflict / business_source_conflict / before_origin_grant / item_reference_conflict：retryable=false，durable dead-letter，不换ID绕过；capacity_exceeded：retryable=true，保留并至少15分钟退避|

结构无法取到合法record_id的输入在envelope阶段400，避免无法关联拒绝。其余单条schema错误进入invalid_record；其他合法记录可独立成功。授权整批预检在任何写入之前；中途撤销发生在某条COMMIT之后时已提交项保留，后续停止，返回503且客户端全批安全重放，绝不虚构未提交ACK。

## 6. 分页读取

允许参数：`limit`默认20/最大50、`cursor`（不透明）、`save_id`、`resource_id`（上述三资源）、`from_day/to_day`（Asia/Shanghai自然发生日，含两端）。不支持客户端传owner、epoch、SN或任意SQL排序。日期过滤不收未知/异常时钟记录；无日期过滤可显示这些记录并标未知。多个条件AND；resource过滤匹配后仍返回完整事务，避免多行事务被截断。

`{ok:true,data:{schema_version:1,items:[ParentRecord],next_cursor:null|string,has_more:boolean,coverage:{kind:"received_records",complete:false,reason:"partial_history",min_occurred_at_ms:null,max_occurred_at_ms:null,first_received_at_ms:null,last_received_at_ms:null},updated_at_ms:null|integer}}`。
coverage四个时间字段表示当前授权可见且符合过滤/高水位的**已收到**记录范围；发生时间仅取可归日记录的min/max，接收时间取首次接收min/max；无对应记录则null。这些边界不是采集开始/历史完整证明。

ParentRecord为原Record去掉origin_grant_id/origin_epoch，加`received_at_ms`、`time_status:"reported|unknown|clock_suspect"`；保留source_mode，gm/unknown可显示为明确异常/测试来源，不能混入normal总计。item_changes仅是发生当时事实；R1列表不声称完整当前物品库存。

家长分页另返回只读 `item_references` 数组，每个 activated 对应 `{item_instance_id,acquired_record_id,status:"pending|resolved"}`。该字段不得出现在设备上传体中，否则单条返回 `invalid_record`。resolved 要求获得记录与激活记录处于同一 save、原 owner / device account / epoch / grant，获得 sequence 小于激活 sequence，且获得记录在当前分页高水位内。pending 仅表示引用尚未对齐，既不代表库存，也不等于物品状态 pending_activation。引用解析不修改原 item_changes、不新增获得数或收入。

排序固定为可归日的occurred_at_ms DESC（未知/异常排后）、save_id ASC、sequence DESC、record_id ASC；同save的业务前后以sequence为准，不以到达时间改业务顺序。第一页固定服务端ingest高水位，cursor绑定public_id、原owner/epoch/grant、过滤条件和高水位及最后排序键，后页只读≤高水位；新补传不插入既有翻页集合，刷新第一页才纳入。游标不可篡改（现服务认证密钥签名或等价服务端游标），不创建新密钥体系。伪造/改变过滤条件400 invalid_cursor；归属变化先404，不泄露cursor内旧owner。过期cursor 410 cursor_expired，刷新第一页（候选TTL30分钟，非现役能力）。每页重查身份，未登录401，非本家长/禁用/无有效授权一律404。

## 7. dashboard新增与诚实覆盖

新增 `data.records`，独立于旧`data.ark`：
```
{
  "schema_version": 1,
  "coverage": {"kind":"received_records","complete":false,"reason":"partial_history","min_occurred_at_ms":null,"max_occurred_at_ms":null,"first_received_at_ms":null,"last_received_at_ms":null},
  "updated_at_ms": null,
  "yesterday_income": {
    "available":false,"reason":"policy_pending","date":"2026-11-15",
    "timezone":"Asia/Shanghai","source_mode":null,"family_coin":null,"stardust":null,
    "occurred_from_ms":null,"occurred_to_ms":null,"received_at_ms":null
  },
  "latest_items": {
    "available":false,"reason":"policy_pending","source_mode":null,"record_id":null,
    "save_id":null,"occurred_at_ms":null,"received_at_ms":null,"items":[]
  }
}
```
latest_items.items结构为`{item_instance_id,item_id,item_kind,quantity,state,activation_record_id}`，最后一项为可确认的后续激活记录ID或null；引用未齐/冲突不伪造active。两个摘要source_mode只能normal或null，available=true必须normal。

新摘要reason允许`policy_pending|no_records|non_normal|partial_history|clock_unknown|save_unknown|legacy_baseline_unknown|not_enabled|identity_mismatch|dependency_unavailable|null`。没有记录updated_at_ms=null；有记录为此可见集合最近首次接收时间。只有normal且已知可用时刻的数据可用于日期统计。覆盖仅表示已收到记录，`complete=false`为R1常量；不实现日闭合水位或完整历史基线。因此没有匹配收入记录返回null，不自动给“昨日真实0”；存在已收正向收入可给**已上报部分合计**，reason=partial_history，不能标昨日完整收入。三种资源不合并。

记录查询依赖异常时，两个摘要返回dependency_unavailable、available=false、金额null、物品空，updated_at_ms及覆盖时间为空；原device/usage/ark继续独立返回。新分页/上传接口仍返回503，绝不伪造ACK；原Ark依赖异常仍保持dashboard原有503行为。

产品口径确认前上述两个摘要保持policy_pending，不影响底层可靠采集、分页、现有余额/卡库存、色温/姿态映射并行开发。确认后收入建议按真实入账北京时间昨天统计reward_claim/tank_unlock的正向币/星尘行，消费不抵扣，历史补领按真实领取日、logical_day独立。此建议尚非产品批准。

最新物品不复用next_reward；激活只更新已获实例状态，不增加获得数。R1没有旧物品完整投影，也没有当前save/当前tank可靠指针，故当前缸/全历史“最新”不得冒充已确定。产品如果选择严格“当前缸最新、含旧档”，该摘要必须继续unavailable/legacy_baseline_unknown，补最小基线方案另出R1.1再实现，不静默扩展旧state。可选最小展示为“已同步获得记录”的最新整组；scope确定后再计算；最新候选若为unknown/gm，不得跳过它回退旧normal冒充当前最新，应返回non_normal。

## 8. 限流、容量与保留（全部为本轮建议实现值，非现役能力）

|项|R1候选实现值|理由/满额行为|
|---|---|---|
|批次/单条|50 Record；UTF-8原始body≤256KiB；单Record规范化JSON≤32KiB|先检查完整信封大小，超过413整批不写；事务不拆碎|
|资源/物品行|3资源行、32物品行|符合本轮三资源及小批物品；32并非已测真实最大，端侧真实峰值超出须修订|
|上传频率|每SN 6批/分钟、120批/小时，至少30秒合批；context 6次/分钟|全局records另限12批/分钟、240批/小时；均独立于Telemetry/Ark配额，429 Retry-After60；10,000积压至少200批约100分钟且受小时窗限制，不能承诺瞬间清空|
|本地待确认＋隔离记录|10,000条或64MiB先到者告警（两层副本分别计量）|90%高水位加速有节制补传/告警；容量满停止成功接纳新outbox交接，Runtime保留原业务记录，不能删除最旧/合并latest-only|
|磁盘无法可靠提交|新资源业务事务失败并回滚，已有存档/记录不动|不能先改余额再丢流水；仅影响该业务提交，IO在后台，不卡住语音/设置/OTA；失败提示沿现有事务失败通道|
|云端每SN及全局|默认分别10,000条或32MiB规范化记录payload，任一上限先到者拒新记录|单C内测预算，不是50台预算；已知duplicate仍可ACK；capacity_exceeded可重试，不自动驱逐老记录。索引/SQLite额外开销另监控|
|云端共享盘余量|默认至少8GiB，并预留本条写入余量|与条数/payload预算共同限制准入；不把共享盘全部容量承诺给本功能|
|云端保留|R1单C内测不自动TTL删除记录/去重键|达到容量先拒新并告警，不能无限增长；后续保留策略另审，删除须保幂等证据且另获授权|
|客户端已ACK副本|可清理已ACK的传输副本，Runtime正常业务历史遵循原存档规则|未ACK/隔离/dead-letter无自动TTL，保留原ID与原因|
|时钟未来阈值|received_at+5分钟以上clock_suspect|仅异常检测建议，不改原occurred_at；统计排除；无24小时回溯限制|

上述服务端默认值已在固定候选 fe76919c 的隔离测试中核实，尚非生产/真实设备容量验收。context.limits 返回实际生效值；频率、条数、payload、磁盘余量、游标TTL及未来时钟阈值可由服务端配置，非法配置返回503 records_configuration_invalid。协议硬上限50条/256KiB/32KiB保持不变。客户端不得自行调大或按旧文档的10万条/256MiB假定容量。端侧本地队列预算与云端预算分别计量。首轮范围仍只C机；不启用PRnas T3、不换存储系统、不部署新服务。

## 9. 仅两项产品待定

1. **昨日收益口径**：是否采用“北京时间昨天实际领取的奖励正收入，家族币/星尘分列；补领计领取日；只称已上报收入，缺测不补0”。世界观已确定金币=家族币、星尘独立、家长兑现约定；不再追问这些既有裁定。缺少全日覆盖时不能保证真实总收入。
2. **最新物品范围**：当前缸或全部缸；是否包含小可装饰/pending_activation；同笔多件默认整组。若必须含旧档/当前缸，需要真实当前save/tank与旧物品基线，R1此摘要不假装可用。

坐姿“实际提醒=played”、余额不是收入、补勤卡使用后奖励仍需真实领取、无云端发币均已有依据，技术上直接采用，不增设第三项产品阻塞。

署名：codex（OpenAI）| 2026-11-16
