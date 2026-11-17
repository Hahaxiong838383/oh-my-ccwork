# P003 小程序真实数据 R1｜服务端开发与联调回执

## 坐姿提醒已贯通，R1 磁盘门槛已修复（2026-11-17 18:48，北京时间）

**服务端和 Worker 小程序 Dashboard 已上线，C 今日及已接收历史坐姿提醒均为7次。** 只计 `posture_reminder + outcome=played`，按设备/事件ID去重、原发生日（北京时间）归属；冷却、姿态轮次、心跳和批次ACK总数不算提醒。统一读 `data.posture_reminders`，旧 `today.posture_alert_count` 与其 today.played_count 同值；历史仅代表已接收部分。snapshot=null也可显示。18:48家长A和后台API均200、完整提醒DTO一致，18:49后台实页/参考H5均显示7次且刷新验证通过。

961–970批次的26条ACK实际为10条focus_segment和16条presence_transition，无提醒事件。18:26已接收历史是5次；18:27和18:32另有两条真实played入库，故发布时为7次，不将26当次数。

同时查明新增R1被默认8GiB磁盘预留挡住（当时仅6.05GiB可用），18:48只将 `ARK_RECORDS_MIN_FREE_BYTES` 设置为2GiB，保留10,000条/32MiB配额及写入余量，未改协议/ACK/授权。生产同盘隔离写入已通过；18:53尚未收到发布后的新流水，设备原ID退避重试后的真实ACK仍待核，不能将此前“上传就绪”理解为已完成这一轮补传。

代码 `a518001e08450aa722cef0fd4bc31daf1308118b`；Node22生产候选9组、前端118项和双构建通过。现役liveHomeView不在本树，参考构建完成不等于微信手机发布。详情与字段交接见[坐姿提醒回签](../../../../docs/posture-reminder-20261117/P003_POSTURE_REMINDER_DATAFLOW_20261117.md)。以下为历次快照，以本节和新回签为准。

---

## mini010 色温、游戏与实时奖励已贯通服务端（2026-11-17 15:39，北京时间）

**本轮已上线查询与后台修复；R1上传协议和ACK不变。** C原始库已有13条legacy（1基线、12业务提交），14:52–14:53回执的6条业务事实均在库，其中1条仅unknown→gm，不是奖励。当前上报家族币600、星尘0、补勤卡1、来源gm，过去因正常来源门被置空；现通过`ark.reported_state`保留实值与game进度，并独立注明GM。`records.recent_activity`直接查询即时R1，不再等待夜批Analytics。历史40条观测仍单独分页，避免重复合计。

色温838/840已按snapshot_id精确核库为warm/normal；`device.color_mode`原本已返回，现场小程序却写死暂无数据。端侧冷光/常规名称对调仍需其原代码修正，本服务不反向补偿。

家长A原权限公网dashboard与13条records逐项核库HTTP200；后台实页5个GET200，本仓H5真实响应8个GET200、13条即时记录+40条/2页历史；115项前端与生产Node22的13套回归通过。现役手机`liveHomeView`不在当前工作树，**本仓代码/构建已交付不等于手机已发布**，须按字段表接入并实机复测。最新回执及证据：[mini010数据全链路回签](../../../../docs/mini010-dataflow-20261117/P003_MINI010_DATAFLOW_SERVER_RECEIPT_20261117.md)。以下10:50及更早的余额缺测、baseline1、mini008等结论仅为当时快照。

---

## mini010 上传就绪复核（2026-11-17 10:50，北京时间）

**兼容已于11月16日23:11:30上线；本轮现网C仍返回 `cfg-182 / enabled=true / p003-ark-records-r1`，mini010保持原协议即可开始上传联调。** 端侧新回执所引`c906d5…`是22:34方案稿，其“服务端尚未实施/部署”已经过期；不得再按它人工关闭网络。保留端侧默认false，由真实有效配置启用，无需增加v1 context/origin或重做资源格式。

本轮还查得10:46:02收到1条兼容baseline（source_mode=unknown）；这不是正常奖励流水，也不是本轮探针写入。最新核验、原始报文HTTP/SQLite回归及下一版具体要求见 [mini010服务端就绪回签](mini010-readiness-20261117/P003_MINI010_SERVER_READY_20261117.md)。旧日期“新R1=0”保留为当时快照，现场领取/消费/激活仍需逐ID验收。

---

## 当前身份方案（2026-11-17，按用户最新决定）

**当前采用手机号短信验证码登录，以家长账号 ID 关联设备和数据；微信身份接入推迟至企业认证阶段。** 本节覆盖下方旧回执中的“下一步补 AppSecret 和真人微信授权”待办，当前无需为此补凭据。

- 后台保留 SN、小程序设备 ID、家长账号 ID、账号手机号、绑定状态和二次确认解绑。手机号默认脱敏；已有手机号可能来自预绑定，不据此标注“已短信验证”。
- “身份与接入”保留微信身份、微信登录配置、AppID、OpenID、UnionID、微信身份验证时间；尚未获取的身份显示“待企业认证后接入”，不再以缺 AppSecret 提示待修故障。已存的真实身份值、实际 AppID 和验证时间继续如实显示。
- 本次只调整后台展示，不修改短信鉴权、设备绑定关系或微信接口，不触发微信授权或短信发码。后续企业认证小程序接入另行联调。
- 本后台的历史对话标签、入口和摘要已暂时隐藏，历史数据及接口保留；历史使用、奖励、道具和业务流水继续展示。

---

## 最新修复上线结论（2026-11-17 09:33，北京时间）

**历史与使用时长已上线并完成生产对账；微信身份代码与AppID已上线，但AppSecret和真人授权仍缺，不能称三端全部验收。** 本节覆盖下方旧日期的“尚未接历史/不能使用进度或在位推算”结论；旧表只保留为当时证据。

| 项目 | 当前结果 |
|---|---|
| 使用时长 | C历史5003秒（83分23秒），今日24秒。按用户最新口径纳入奖励进度、在位和有效姿态，去重保守合并；本轮全部为补充计算，非完整focus直报 |
| 历史奖励/道具 | 11奖励、21库存变化、5补勤卡变化、3进度记录已接入小程序与admin；独立分页、时间/来源/覆盖明确 |
| 星尘/家族币 | 仍缺真实余额：0钱包变更、11奖励未含币种。不能据此补0或推断原档余额，页面明确未知 |
| 微信身份 | 实际AppID wx8b0ce82f18ab2f29已展示；可信code2Session、身份落库、原账号补齐已实现；生产缺AppSecret，尚无真实OpenID/UnionID授权回执 |
| 验证 | 生产Node22/24共25组回归、前端111项/类型检查/双构建通过；真实C两端DTO一致，公网admin浏览器4个详情GET200、0页面错误；冻结H5读取生产原始响应6个GET200，历史40条/2页无重复 |
| 上线范围 | 14源码/HTML+2环境增量，原设备绑定和个人站未动；历史旧事件仅C原授权scope。C自报仍mini008、新R1样本仍0，不冒充APK已安装 |
| 新包 | 两机Downloads交付P003_MINIAPP_HISTORY_IDENTITY_20261117.zip；必须使用新包才有新增历史界面，未自动更新旧微信包或向微信平台发布 |

时长：301→600→902只计902；已定位区间先去重，再与同日累计进度取max，避免重叠相加。估算窗口在位最多300秒、姿态回看60秒；原始奖励历史保留14天，覆盖不完整。合法0与未采集分开。

新包SHA256：`6dd8a234b4bf31e26c5bb06257de71258550b69fe2724942bb792a59106d14fd`（4,791,518字节）。完整回执及证据：仓库`docs/history-identity-fix-20261117/RELEASE.md`。下一步补凭据、真实微信授权与C新增上报验证；短信登录保持可用。

署名：codex（OpenAI）| 2026-11-17 09:33 北京时间

---

**历史结论（2026-11-16 23:11）：mini009兼容服务已上线，C上传配置已恢复为cfg-182/enabled=true，Node22接口集成199/199通过；历史对话当前186条。服务器已能接收旧格式及授权历史；C最后自报仍mini008，修复签名APK/实际R1补传、使用时长和微信手机验收留11月17日现场，不能声称实机全链通过。**

本次实施/验证/交付/回滚详见[11月17日联调交接](compat-20261116/HANDOFF.md)。下文带21:04、21:43等时间的数字是历史核查快照；最新生产证据在`compat-20261116/`。

摘要发布：北京时间 **2026-11-16 20:57:01**；历史接口发布：**21:32:37—21:32:41**；生产数据页面验证：**21:34:25**。
服务：`https://kidshub-ai.hahaxiong.cc`。仅 C 机 **BJP00326081002000031**，public_id **dev_50b5415662259045**。

## 1. 当前到底完成到哪一层

| 层次 | 当前结果 | 证据与限制 |
|---|---|---|
| 后台历史对话 | **已上线，仅 C 当前绑定** | 最新186条，H5共10页无重复；21:32的184条历史样本曾与数据库逐字段一致 |
| 小程序真实数据页 | **已开发、双构建、生产数据页面验证** | 状态、usage、资产、两个摘要、业务分页、对话分页均接入；101测试、TypeScript、微信/H5构建通过 |
| 历史页面 | **真实数据验证通过** | H5读取生产原始GET响应，23:16显示186条/10页，刷新恢复首20条，退出清空；不是微信手机登录验收 |
| 使用时长 | **精确源码缺陷已修复，C现场待验证** | 精确mini008源错误把开盖判为1/1，权威协议为4/0；mini009基线联合修复后JVM1889/1889、Release Kotlin通过；云端仍无focus_segment |
| 两个业务摘要 | **已上线** | 昨日已上报收益、最新整组物品计算具备；现C新流水0条，摘要为no_records，不能补0 |
| 安卓新增R1流水 | **服务端兼容已上线，单C上传配置已开；实机待验** | cfg-182精确旧格式enabled=true；服务端199/199，Native稳定scope与4/0修复已推d569775、JVM1889/1889。C最近自报008，尚无真实R1样本 |
| 微信手机端与C新时长 | **未验** | 当前环境没有C所在Windows/ADB可用入口，未执行C安装或微信版本发布；不得用构建或签名探针代替 |

**新客户端交付包已具备查询 C 当前绑定账号历史的能力，微信登录与手机显示待现场验收。旧小程序构建只接设备状态，不会因后台升级自动新增历史界面。**

## 1.1 重要澄清：C机有历史数据，不是全部为0

用户指出后台已有对话后，于北京时间 **2026-11-16 21:04:03** 重新核查生产数据库，并实查公网dashboard。前述“0条”**仅指新增R1业务流水ark_record**，不能概括旧遥测、对话或Ark快照。

| 数据类别 | 实际查得 | 对小程序的意义 |
|---|---|---|
| 设备状态快照 | 541条 | 当前dashboard.device已有实际亮度、色温档、像距、状态更新时间等 |
| 坐姿检测事件 | 1243条posture_round | 检测次数不是提醒播放次数；不能把全部检测都算坐姿守护提醒 |
| 在位变化事件 | 760条presence_transition | 证明已有在位变化上报，不自动换算成有效使用时长 |
| 对话消息 | 184条：用户92、小可92；11月16日有2条 | 21:04时后台已有；21:32起dashboard.conversations与历史分页已接入，新真实页可读取 |
| 使用时长片段 | 未收到focus_segment；旧daily.focus_ms合计为0 | 公网data.usage今日及近7日available=false、focus_minutes=null；应显示暂无数据，不是实测0分钟 |
| Ark资产快照 | 当前快照存在，source_mode=unknown；原始补勤卡为1，两个币余额null | 当前家长API按既有normal门限返回non_normal/null；不是没有快照，不能把原始unknown资产冒充已验证正常资产 |
| 新R1业务流水 | 0条 | 仅新的领取、消费、获得、激活记录尚无样本 |

对话消息时间不等于连续使用时长：当前RTC消息session_id统一为rtc，不能用其distinct数量算真实会话次数，也不能将最早到最晚消息之差算使用时长。device_session_log的ms是签发接口耗时，ttl_s是令牌有效期，同样不能冒充设备使用分钟。

**旧对话已接入；时长没有可恢复的focus_segment历史样本；新R1流水仍缺端侧接入证据。** 后台已有对话不能被“新流水0条”否定，不能靠旧today.focus_minutes默认0填充小程序。

21:04核查证据：`summary-20261116/LEGACY-DATA-AUDIT.json`、`LEGACY-API.json`，只读计数与状态，无儿童对话正文。该次核查未改服务；21:32的历史接口发布见下节。

## 1.2 历史对话接入：接口、归属与刷新

- 摘要：`GET /v1/parent/devices/{publicId}/dashboard` 的 `data.conversations`。返回 available/reason/source、消息总数、孩子/小可各自条数、首末消息毫秒时间；`history_complete=false`，不宣称数据库覆盖全部设备历史。
- 详情：`GET /v1/parent/devices/{publicId}/conversations?limit=20`；支持 `from_day/to_day`（北京时间自然日）和 `cursor`。默认20、最大50；从新到旧，排序`ts DESC,id DESC`。单条只含`id/role/text/ts`，不暴露账号、SN或session。
- `next_cursor/has_more`配合翻页；首屏固定高水位，新对话在设备正常写入同一账号后，点“刷新”或“查询 / 刷新”可见，不需要搬迁旧数据。游标30分钟失效，绑定筛选与归属；400/410清旧游标，刷新503不复用旧游标。
- 成功200、错误身份401、其他家长/已失效授权404、参数400、游标失效410、依赖故障503；`Cache-Control: no-store`。对话库故障只降级本域，原状态、usage、Ark、records独立返回。
- 旧conversation没有原家长/epoch字段，因此本次仅显式授权C当前完整元组（public_id、SN、家长账号、brain账号、binding_version=1、epoch=2），并校验active及brain账号唯一。换绑/换回、换brain、换epoch都会失效，不自动把历史给新家长。读取前后再次核验当前归属，已有真实双连接ABA/WAL回归。
- 公网/本机10页均184条、184个唯一ID，与只读数据库逐字段一致；当天筛选2条；其他真实家长404。消息内容仅在校验进程内比较，证据不存儿童原话。

21:32只发布`src/parent-conversations.ts`及`src/routes/telemetry.ts`，新增单C范围配置，主Brain空房时重启一次；其他PM2未动，未写业务数据、未复制历史、未回灌数据库。紧邻发布前后原ark/records/usage/device/today/week内容SHA全部一致。

- `parent-conversations.ts` SHA256：`33e17148525d71c7277ac34ce7104439caa096fc61b518d35da0a78dfa523ba5`
- `telemetry.ts` SHA256：`9bb9913ab2f6680ee209a0e15d202bdab83fa0f27382ca73a117761a2fba8759`
- 历史发布清单SHA256：`6996e550347eee5a65f820bb15c08b566dae7a4bf4f9f0d4b7d4aebc88b64a74`
- 生产Node22复核：历史15/15、摘要15/15、records32/32、原dashboard16/16、遥测37/37、schema60/60。首次隔离测试漏拷race-worker后补齐复跑全过，未修改生产逻辑绕测试。
- 21:53:21复核：health=ok、两源SHA匹配，p003-voice仍为PID2214587/restarts6，其他进程不变。
- 证据：`apps/server/docs/parent-history-20261116/` 的发布清单、RELEASE、POST-RELEASE-PROBE、STABILITY-PROBE、BROWSER-CHECK；服务器同名目录`/root/p003-parent-history-20261116/`。

## 1.3 使用时长缺失：已定位的错误与尚待实机确认的部分

精确安装回执对应源码为`f083b6e4066c8bbfda43f53e2bd8b8723a9810c0`（371_mini_008）。该版本TelemetryCoordinator私有常量错写`WORK_ACTIVE=1,HALL_OPEN=1`，同一源码WelcomePolicy按协议使用`WORK_ACTIVE=4,HALL_OPEN=0`。原版测试复现：真实4/0被判为关盖、1/1反被判为开盖。mini008已取消focusActive门，实际计时仍需开盖、摄像头在位、非配对/OTA阻断、可用时钟，开盖误判会直接挡住片段生成。

这与生产541条snapshot全部lid_open=false、其中110条present=true，以及focus_segment全历史0相符。现存日志范围内成功ACK遥测286批、非零拒绝0批，支持首先修采集门；不能据此排除所有历史网络/现场状态问题。当前仍未回读C实际安装APK字节和当前MCU原始值，不能把源码复现说成已完成现场硬件验证。

最初修复在精确f083独立工作树完成：删除两项错误私有常量，复用WelcomePolicy的权威4/0；保留60秒分段/合盖补尾、摄像头/配对OTA/时钟门和队列ACK逻辑。JVM遥测+欢迎88/88（含真实decoder→Tracker的60秒及5秒尾段）、Python26/26通过。未改原Android工作树，未安装、未OTA、未拿主线APK替代mini008。

- 最初mini008对照包（仅留证，不用于覆盖mini009）：Air Downloads `P003_C_USAGE_FIX_20261116.zip`（23,050字节），SHA256 `d1cdf663225a42cb87f0f5468d8bbb07abfa78584b54d1f340b0cb64278dab68`。含补丁、根因说明及测试证据，不是APK。
- 源补丁：`mini008-usage-hall-fix.patch`，SHA256 `f9f3e6b12a8eb06ca3b4bee8b264a490b121b47d4cc45e705f366dc9d381da58`。
- 修后Coordinator SHA256：`df00a9ed2f858cb2723035784dfa2e514ed52aeb7e487339e4ad59cdb50979f9`。
- 独立树：`/Users/fu-121/.codex/worktrees/p003-mini008-usage-fix-20261116`。

后续已将同一最小修复应用到 **mini009精确构建源006ac68a29447e8bc14fb655206d87bbf1f771a3** 的独立树，保留全部R1/Rust/Godot/MCU/BLE实现和默认网络off。该基线全量JVM **1883/1883、0跳过**、Python定向 **40/40**、Release Kotlin编译及MCU构建输入门通过。Release Kotlin不是完整签名APK；本树完整quick、Rust/Godot/base重建和最终签名审包尚未执行，**当前只交付源补丁，尚无修复APK、安装或OTA**。该轮用时修复归档在Air Downloads的`P003_C_USAGE_FIX_MINI009_BASE_20261116.zip`（32,676字节，SHA256 `aea287f1a9be0ab17d7a455bb9d0f7af70faeb3cb703e3e8dae7e0d8e52bdc64`），旧008包仅作根因对照。详见`MINI009_USAGE_FIX_HANDOFF.md`、`MINI010_BUILD_READINESS.md`。

**历史时长目前无法据实补回。** 没有focus_segment，不能用对话首末时间、presence间隔或token TTL造分钟。修复安装后只累计新片段；若Windows/设备另有原始有效片段，应先核原始ID与归属再按原上报链重放。小程序保持“暂无数据”，不是“0分钟”。

C下一轮验收：先核SN与修复版本/签名，开盖并摄像头在位持续至少65秒（不进入配对/OTA），核MCU4/0→snapshot.lid_open=true→focus_segment→逐ID ACK→云端同事件→dashboard.usage→小程序刷新；合盖检查尾段不重复、暂停门仍有效。保留绑定/存档/未ACK队列，禁止清应用或重绑。

## 1.4 当前客户端交付与测试边界

当前交付：两机Downloads的 `P003_MINIAPP_COMPAT_20261116.zip`（4,864,669字节），SHA256 `99867d8ff0d4b60d96bfc7458eac0b7d8152fb5a5cb304964bca4b9668d2afa9`。含独立源码、`dist/weapp`、`dist/h5`、README及逐文件SHA，无node_modules/env/token。微信开发者工具导入包内工程，`miniprogramRoot=dist/weapp`，API固定生产HTTPS。旧`P003_MINIAPP_C_HISTORY_20261116.zip`只作历史归档。

Android当前联合源补丁：`P003_C_USAGE_AND_R1_SCOPE_FIX_MINI009_BASE_20261116.zip`（8,616字节），SHA256 `77e6800ca399301a23c4d30eb3aa50955ec3a555a5b54b660aa7f4110325eb6a`；同时包含4/0用时和SN+binding_version稳定scope修复，独立分支提交`d56977517487cd6002ef16cf3ba266af24aac9ca`，不是APK。此前只含用时的补丁保留归档。

新真实页支持设备状态、今日/近7日有效使用时长、normal资产快照、昨日收益、最新物品、双格式业务流水及历史对话。缺测null显示暂无；真实0正常显示；兼容baseline只显示已有状态，不当作收入或新获得。

验证：101/101、TypeScript、微信与H5构建通过；23:16独立新H5读取生产GET原始响应（仅测试传输层补CORS头），实际显示186条/10页无重复，刷新首20条，空流水、缺测时长、退出清理均通过，无页面异常；新构建9个H5文件与交付ZIP逐字节一致。**服务端短效身份测试不是微信短信登录/发布/手机验收；C安装和手机显示待明天现场。** 证据见`compat-20261116/BROWSER-CHECK.json`。

## 2. 两个摘要现在如何计算、如何展示

读取现有接口：
`GET /v1/parent/devices/dev_50b5415662259045/dashboard?timezone=Asia/Shanghai`
身份沿现有手机号登录返回的家长 Bearer。新增内容在`data.records`，原`data.ark/usage/device/today/week`不变。

### 昨日已上报收益：`data.records.yesterday_income`

- 时间：按北京时间昨天的实际领取时间`occurred_at_ms`，不按上传到达日或游戏`logical_day`。昨天领取、今天补传的记录仍计昨天；今天领取历史补奖计今天。
- 来源：只统计`source_mode=normal`且`time_status=reported`的`reward_claim/tank_unlock`正向家族币、星尘；消费不抵扣、补勤卡不折算、GM/unknown/异常时钟不进入收益。
- 金额：`family_coin`和`stardust`分列。某币种没有符合条件的已收记录时保持`null`；不得补成0。累计是安全整数，可超过单笔1e9上限。
- 有数据：`available=true, reason=partial_history, source_mode=normal`。这是**已同步部分合计，不是昨天完整收益**。
- 无匹配数据：`available=false, reason=no_records`，两币为`null`。即使存在其他日期/来源记录也不能宣称昨天真实0。
- `occurred_from_ms/to_ms`是参与合计记录最早/最晚发生时间；`received_at_ms`是这些记录最近首次接收时间。

推荐标题：**“昨日已上报收益”**，说明“仅含已同步记录”。正常余额仍读`data.ark.wallets`，不能以余额差替代收益。

### 最近已同步获得物品：`data.records.latest_items`

- 范围：当前授权可见的**全部存档、全部缸**，包含生态缸组件、小可装饰、待激活物品；同一笔多件整组返回。不是当前缸库存、完整收藏或下一奖励。
- 顺序：同一`save_id`先按最大获得`sequence`确定业务最新，再跨存档比较可归日的设备上报发生时间（reported不代表时钟已校准）；设备时钟回拨不会把同存档旧笔选为最新。
- 不回退：最新候选为GM/unknown则`non_normal`；任一获得记录时间未知/异常，不能确认全体最新则`clock_unknown`。均不可跳过后显示旧normal冒充最新。
- 激活：只用同存档、原归属、同获得记录与实例、向后序号的normal/reported/item_activation记录投影成active，并填`activation_record_id`；不增加quantity、不新增收入、不修改原流水。
- 有数据：`available=true, reason=partial_history`，含`record_id/save_id/items[]`。`items[]`每项含`item_instance_id/item_id/item_kind/quantity/state/activation_record_id`。
- 没获得记录：`available=false, reason=no_records, items=[]`。显示“暂无已同步获得记录”，不要显示“没有物品”。
- `received_at_ms`是获得记录的接收时间；后续激活可改变顶层`data.records.updated_at_ms`。名称/缩略图仍由端侧资源语义映射，不从服务器编造。

### 共同规则

`coverage.complete=false`保持不变。`not_enabled`表示该能力未开放；`dependency_unavailable`表示新记录查询异常，原资产/时长/设备状态继续独立返回；空值不能转0。当前线上C两摘要为`no_records`，原因是没有新流水，**不是摘要代码仍待开发或口径仍policy_pending**。

## 3. 20:57 两个摘要发布的验证与范围（历史记录）

| 验证 | 本次结果 |
|---|---|
| 生产同版本Linux Node22.22.2隔离测试 | 摘要15/15、records HTTP/SQLite32/32、原dashboard16/16、Telemetry37/37、schema60/60 |
| 独立代码复审 | 找出的同存档时钟回拨问题已修；最终两源码SHA核同，未发现剩余发布阻断 |
| 容量查询样本 | 9001条、32件及1000次激活引用；Node22约148.77ms、JS堆增加181592字节；合成隔离数据，非真实峰值或长期语音负载验收 |
| 公网/本机 | dashboard、records分页200，错账号404，Cache-Control:no-store；空摘要no_records |
| 原字段兼容 | 紧邻发布前后ark/usage/device/today/week逐项内容SHA一致 |
| 发布操作 | 只替换2份摘要源码，主Brain受控重启1次；env/授权范围/凭据未改，其他PM2进程未变 |
| 生产业务数据 | 没有写入合成奖励、修改来源/时间或回灌数据库；C新流水仍0条 |

本次发布只涉及`src/ark/records-contract.ts`、`src/ark/records-store.ts`，基于原R1已部署版本增量替换；没有整树同步、扩设备、改Worker/OTA/PRnas。
源码定位（本轮未新增Git提交，以SHA和发布清单为准）：

- `records-contract.ts`：`f16556dc814f6f746f1b33b94e376afa95479952c21f1b7af92b2ed94731f123`
- `records-store.ts`：`896378873b0e2f43c14a8b56939d2181473adf190718b375fd30c4fe831773bd`
- 发布清单SHA256：`97b6e75cda74882a7e3102fc8efd9a4ea466cf89a349b0be124d7f7e9cf736e5`
- 证据目录：仓库`apps/server/docs/records-r1/summary-20261116/`；服务器`/root/p003-records-summary-20261116/`。

现存限制：全仓TypeScript仍有`listening-content.ts:29`缺`GeminiLlmClient.abort`，旧currency-http三项语音断言失败属于原回执已知基线，本轮没有修复或冒称整仓全绿。原Telemetry历史只按SN、未带epoch，换绑旧usage风险仍存在；新records按原归属隔离。

## 4. 真实上报对账：本轮查到了什么

1. 先前只找到Air Downloads的18:08需求回执（SHA256 `8561e02e041630c376a35201ffcd2f48efe4aa0714e6a33364027877823444b7`），其中“R1未开发”已被后来端侧回执替代。21:43后从既有Git远端取得21:22提交`75378716195bda8e7414af97ffd8dbd0b109212b`，其正式出包回执明确mini009已开发/签名构建，但未上机、未访问服务器，真实验收PENDING。
2. Air及Studio本轮ADB设备清单均为空。历史安装回执把C指向另一台Windows开发电脑；没有找到该电脑的既有远程入口。
3. 旧mini008的versionCode371、旧Telemetry成功/Ark403是11月11日历史证据，不能替代今天R1的实际APK回读、context、records ACK或手机展示。
4. 本轮服务器实时读取C新记录数为0。没有已接收record_id可与端侧和手机对齐，不能以HTTP200、旧pending0或测试样例补足真实验收。

### 21:43后新增证据：mini009已出包，但不能直接接通线上R1

mini009构建源`006ac68a29447e8bc14fb655206d87bbf1f771a3`；包名`371_mini_009`/code371；Windows交付路径`D:/P003交付/小程序BLE配网/371_mini_009/371_mini_009.apk`；85,378,834字节，SHA256 `bde6b3eff817b10f3abd6e1f0b8f514ef17d44e0283829f9f0c608df9624d3db`。这些是已取到的端侧构建回执事实，尚未取得APK本体或C现装SHA。

其Runtime/Godot/原生持久日志已实现，网络默认关闭；所带TelemetryCoordinator与mini008相同，仍有开盖1/1错误。后续用时修复必须保留mini009新增R1能力，不能拿008修复包覆盖009当成新完整包。

mini009候选wire不是当前线上合同，直接开启会失败；**但可以由服务端兼容，无需端侧全量改成新版协议。** 2026-11-16按用户“兼容模式、避免过度工程化”实施如下，**23:11:30已上线并对单C恢复上传配置**：

| 差异 | 直接启用的结果 | 必须处理 |
|---|---|---|
| 端侧含contract_id/save_id/coverage_from_ms/dropped_records，与现信封不同 | 整批400 invalid_envelope | 同POST按精确contract_id走独立mini009解析，保原字段与覆盖信息；原v1行为保持 |
| baseline/business_commit+data与现役origin/reason/实例结构不同 | 绕过信封仍逐条invalid_record | 一张原始表保事实，读时投影明细/摘要；单C明确历史授权且标原归属未验证，不伪造origin；基线不计收入 |
| 端侧把所有rejected当终态 | 临时容量失败可能失去自动重试资格 | 兼容分支临时故障/容量用整批503，限流429；只对永久错误rejected，无需先改客户端ACK |
| 无epoch claim时scope使用整枚token指纹 | 正常续凭据后同save可能save_identity_changed | Native仅改为已校验SN+binding_version稳定键；服务端另核Ark epoch，不混同二者 |

**此前off已被23:11发布取代：C配置cfg-182已下发enabled=true、contract_id=p003-ark-records-r1，公网回读通过。** 同服务、同鉴权、一张原始表和读取投影，保原record_id去重；明确授权的C历史可接收，基线/未知不冒收入。内外网配置、dashboard、流水/历史读取通过，空POST400、失效凭据401、错误家长404；无合成业务入生产。C最后自报mini008、v1/legacy仍0条，因此只是服务器接收和配置恢复，尚非设备实际补传。用时与scope联合源补丁已交付，签名APK/安装待现场。

**当前缺口：正式修复APK出包/安装，C真实时长与R1同ID对账，微信导入/发布和真人操作。兼容接收、legacy投影、接口验证与单C开关已完成；旧对话现186条，历史缺测时长仍null。**

## 5. 安卓、小程序、服务端下一步同一笔对账

### 服务端兼容mini009，安卓只补必要小修后真实上报

1. 保留C原绑定、凭据、grant/epoch、存档和未确认队列，不重绑、不清应用、不以GM造奖励。
2. 服务端精确legacy分支/单C授权已上线并验证；cfg-182已开。明天从Android已推送`d569775`沿正式流程出合格新包，确认实际活动APK/SHA后保数据安装；现役v1 context不是legacy前置条件。
3. 保留现有真实事务与`save_id/sequence/record_id/不可变Record/outbox`原子交接；Launcher durable ACK前不删Runtime副本，云端ACK前不删Launcher未确认队列。与开盖4/0修复合并到下一合格包，保原mini009新能力。
4. 在已有合格正常存档上执行一笔真实领取/获得，再执行真实道具使用或激活。没有合格业务条件时如实待测，不改normal或时间绕过。
5. 单C按既有`ark_records.enabled=true,contract_id=p003-ark-records-r1`开启后上传同POST，逐ID处理accepted/duplicated；HTTP200不能清整批。断网/503/截断保原ID重放，不换ID绕过。经明确兼容授权的C旧历史可补传，标原发生归属未验证；未获授权的范围保留原文，不自动重挂。

### 小程序：新包已接入，现场按以下口径验收

1. 原家长登录后读取dashboard与`GET /v1/parent/devices/{publicId}/ark/records`，严格按available/reason/null展示。
2. 分页limit默认20、最大50；支持save_id/resource_id/from_day/to_day。首屏固定接收高水位；后页原样带cursor、limit及过滤。补传刷新首屏可见；400无效或410过期cursor重取首屏。
3. 每个record返回整笔资源/物品；激活列表是原始事实，摘要才投影状态。切账号丢弃旧请求、设备缓存和cursor；B访问A设备必须404。
4. 当天新上传不能保证“昨日收益”有值：需真实发生于北京时间昨天、授权合格且有真实奖励证据的normal领取，或次日核验今天真实领取。兼容基线、GM/未知及缺口不充作完整收益，禁止改时间制造昨日样本。

### 双方回传这张表，服务器按同一ID核对

| 项目 | 必须提供的真实证据 | 当前 |
|---|---|---|
| 版本/身份 | 完整SN、实际APK版本/SHA、Runtime版本、小程序版本、北京时间 | 未现场回读 |
| 可靠交接 | record_id/save_id/sequence、Runtime记录、Launcher durable ACK、outbox/pending前后 | 未提供 |
| 云端到账 | batch_id、HTTP、逐ID accepted/duplicated/rejected、服务器同ID记录 | 兼容HTTP/SQLite隔离联调通过，cfg-182已开；生产v1/legacy0条，等设备真实样本 |
| 页面对应 | 家长API同record_id、金额/物品、页面值与时间 | 未验 |
| 去重/离线 | 原ID重放不重复计入、断网恢复保留原文、重启/强杀未ACK不丢 | 兼容重放、部分已写后503、续token主机回归已通过，实机未验 |
| 摘要 | 昨日真实领取归日、正常收益与GM隔离、最新整组及激活不重复计数 | 服务端计算已验，真实页面未验 |
| A/B隔离 | 真人A/B登录、B访问404、切账号无旧缓存 | 服务端负例404已验，手机未验 |

旧 Telemetry 状态/使用时长、Ark 正常余额与补勤卡仍须按11月12日三方联调手册回归，本轮不以新records测试替代旧链真机验收。

回传勿包含token、家长手机号或儿童原话。完整字段及错误矩阵见`SERVER_CONTRACT_R1.md`、`schema.mjs`与`INTEGRATION.md`；样例均标synthetic，不能上传到生产当作真实业务。

## 6. 当前容量和回滚

单C内测范围保持，无自动短时关窗。批次≤50条/256KiB，单条≤32KiB；单SN 6批/分钟、120批/小时，全局12批/分钟、240批/小时；默认单SN及全局各10000条/32MiB payload，磁盘余量8GiB。实际值读context.limits，不能当作50台或无限历史承诺。

本次两个摘要源码备份：`/root/p003-records-summary-20261116/source-backup/src/ark/`。若回滚本次摘要，先核当前文件SHA仍等于本回执候选，再恢复这两份备份并重启主Brain、验health和原dashboard；env/records允许范围不变，已收记录和去重证据保留。**禁止整库回灌或套用旧六文件全量回滚覆盖后续变更。**

原20:01 R1基础部署证据及六文件备份继续保留；本回执本次更新已在目标Downloads备份旧文档。

脱敏证据与端侧合同对比另交付Air Downloads：`P003_C_REALDATA_EVIDENCE_20261116.zip`（35,258字节，SHA256 `1cebed03190e8ec15ff07edf1e9ec75bc80e33875080656f01cb93e4b189c7bf`）。内含生产发布/历史对账/H5验证、mini009上游回执与兼容性核查；不含儿童原话或凭据。

历史接口回滚：仅核对并恢复`/root/p003-parent-history-20261116/source-backup`中的旧telemetry源码，移除本次新增parent-conversations源码及单条PARENT_CONVERSATION_SCOPE_JSON配置（先核并发漂移），受控重启主Brain并验health；保留既有摘要、数据库、grant和所有业务记录。

署名：codex（OpenAI）| 2026-11-16 21:54:57 北京时间

## 2026-11-17 08:25 · Worker 小程序 Dashboard 已上线

入口：`https://kidshub-ai.hahaxiong.cc/admin/` → Worker 管理 → 小程序 Dashboard。可按SN/public_id/家长账号/手机号搜索，查看与小程序同源的全部当前已接入数据。列表、详情和旧Brain家长解除入口均使用二次确认；按确认时绑定版本条件解绑，陈旧/ABA/重复请求409，不删除Brain或原始历史。

C机 `BJP00326081002000031` / `dev_50b5415662259045` 发布后只读验收：binding_version=1未变，当前历史消息**274条**（昨日186条仅为旧快照），对话首屏20条可继续翻页；当前授权流水首屏0条，今日用时仍缺测null，不能当作真实0。配置与实际上传开关均true；OTA最近自报仍`371_mini_008`。本轮未安装mini010、未补造数据、未真实解绑C，后续实机继续验新增流水/时长。

实现commit `677d519eb87267627fb1e3d702dbd7fd687a92ff`；10文件增量发布、公司Brain重启一次，其他进程、环境与所有绑定不变。后台/家长DTO与历史分页同ID同字段、真实公网页面三GET200/零页面错误均通过。独立审查问题已关闭；新增admin14、解绑70、原配对148、小程序101通过。完整范围和存量检查限制见 `docs/miniapp-admin-20261117/HANDOFF.md`，Downloads交付目录为 `P003_MINIAPP_ADMIN_20261117`。

署名：codex（OpenAI）| 2026-11-17

## 2026-11-17 08:49 · 历史完整性复核补充

用户指出历史不能只算聊天，复核确认：旧Analytics中C有21库存变更/11奖励/5补勤卡变化/3奖励进度，尚未接入小程序Dashboard；新R1表0不等于全部历史为0。家族币/星尘当前为unknown来源下的null，实际余额待C原档核实；focus_segment为0且mini008开盖枚举缺陷修复尚未安装。微信live仍短信登录，无code2Session/身份落库，生产微信AppID/Secret未配置；后台相关行是静态文案。上轮“验收通过”仅指新增后台功能与现有接口一致，不能代表这些历史数据和微信身份已补齐。此次仅核查未发布修复。完整报告见 `docs/history-identity-audit-20261117/AUDIT.md`。
