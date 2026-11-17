# 历史数据链只读审计 · 2026-11-17

**结论：已定位主要缺口：旧 Analytics 原始事实确实存在，却没有接入 Dashboard。主执行者08:45只读证据确认21条库存变化、11条奖励事件、5条补勤卡变化、3条301/600/902秒进度观测；现行Dashboard只看新流水与normal当前快照，所以这些旧事实全被遗漏。有效使用focus片段和钱包变化原始事件确为0；不能把进度秒数当总使用时间，也不能把钱包未知当余额0。建议当前摘要语义不动，新增独立“历史观测记录”API/UI，保留原时间、原逻辑日、未验证模式/原发生归属。**

审计基线：`4d784c8f`；项目相对路径下文以 `2-Projects/P003GameDemo20260513/apps/` 为根。仅阅读源码和既有回执；没有 SSH、生产查询、代码修改、依赖安装或服务重启。C 的身份以本轮主执行者复核为准；这里只复用题定 SN `BJP00326081002000031` / public_id `dev_50b5415662259045` 定位，不打印手机号、儿童正文或凭据。

## 1. 已证实的数据路径

| 域 | 实际生产者/存储与消费者 | 空态原因及历史边界 | 准确位置 |
|---|---|---|---|
| 使用时长 | Telemetry `focus_segment.data.start_ms/end_ms` → `device_telemetry_event` → `usageRange` | Dashboard 固定今日及前6天；必须有合法片段才 available。姿态日聚合中的 focus_ms=0 不证明测得0。没有全历史时长读取入口 | `server/src/miniapp-dashboard.ts:64-75,86-87`；`server/src/telemetry-store.ts:255-315` |
| 当前资产 | `/v1/device/ark/state` → `ark_current` → `dashboardArk` | 单 SN 只保留一个当前快照。非 normal 返回全部 null，连 source_mode/snapshot_id/时间也清空；无 analytics/history 回退 | `server/src/ark/store.ts:15,48-69`；`server/src/ark/dashboard.ts:3-36` |
| 历史资产观测 | Analytics `g1.wallet_balance_changed/inventory_changed/makeup_card_balance_changed` → `analytics_event` → `readArkHistory` | 现成函数存在，但只有 ArkRuntime 内部语音上下文调用；Dashboard 未调用。该函数也仅取两币和 M-CARD-001，其他道具不投影 | `server/src/ark/history.ts:5-52`；`server/src/ark/runtime.ts:26-40`；`server/src/miniapp-dashboard.ts:76-87` |
| 业务流水 | 原 v1 → `ark_record`；精确 mini009 legacy → `ark_record_legacy` | 列表不读取 Analytics/Telemetry/快照。无日期筛选时不是固定近7日，但仍按当前 owner/account/epoch/grant 或明确 legacy scope 限定 | `server/src/ark/records-store.ts:29-61,75-109,185-223` |
| 收益 | 上述两表 → `recordsDashboard` | 仅北京时间昨天的 normal、reported、合格正向收益；不是“历史累计收益”。baseline、消费、unknown/GM 不算；无符合条件金额为 null | `server/src/ark/records-store.ts:226-283`；`server/src/ark/records-contract.ts:54-57` |
| 道具 | 新流水的 acquired 或兼容库存差异 → latest_items | 只返回各存档最新获得中的最新整组，不是完整库存/全历史。unknown 时钟会让整体 latest 不可确认，最新 GM/unknown 不回退旧 normal。baseline 仅在流水中可见，不算新获得 | `server/src/ark/records-store.ts:239-318`；`server/src/ark/records-legacy.ts:175-182,196-208` |
| 对话 | `conversation` 按设备 Brain account 读历史 | 既有单 C 明确授权，冻结 public_id/SN/parent/account/binding_version/epoch，读前后校验唯一归属；不受7日窗口影响，日期过滤只在主动传入时加 | `server/src/parent-conversations.ts:13-18,28-35,61-91` |
| 页面 | admin 使用同源 DTO；小程序 snakeToCamel 后按 available 和 normal 展示 | 本地未发现蛇形/驼峰导致全部数字丢失。两端忠实显示服务端收窄结果；“暂无数据”不能区分原始无记录和 non_normal 被遮蔽 | `miniapp/src/services/api.ts:24-39`；`miniapp/src/services/real-details.ts:7-23`；`web/public/admin/index.html:1302,1310-1312,1333` |

## 2. 根因候选与证据强弱

1. **已确认：旧事实未接入。** `dashboardArk` 第12行明确 current-only / no analytics-history fallback；records 只合并 R1 两表。即使 Analytics 有大量旧资产/收益记录，现有六标签也不会读到它们。小程序 Dashboard 此次上线主要提供现有家长可读范围，并非完成旧数据迁移。
2. **已确认：真实快照可存在但 UI 全空。** 11月16日 `records-r1/summary-20261116/LEGACY-DATA-AUDIT.json` 记录 C 当时 `ark_current.source_mode=unknown`、M-CARD-001=1、两币=null；`dashboardArk:31` 使三个资产全部不可用。这个历史证据仅证明当时，不能替代11月17日当前查询。unknown 的卡1可在管理诊断中显示为“未验证来源观测”，不能改标 normal 或冒充当前正常余额。
3. **高可信但仍待本轮实机确认：时长采集门。** 11月16日历史审计 C 有541个状态快照、1243个姿态事件、760个presence事件，但没有 focus_segment；所有 lid_open=false，其中110次 present=true。精确 mini008/mini009 源曾将工作态/开盖常量错写1/1，权威为4/0，已有 decoder→Tracker 红绿验证与修复补丁。上午自报 mini008 与该路径一致，但自报不是活动 APK 字节证明。不能把“无 focus_segment”泛化成“从未使用”，也不能用对话/在线/姿态间隔回填分钟。
4. **高可信：R1生产者尚未运行。** 11月16日23:11兼容接收与 C 配置已开启；旧 mini008 并无 mini009 新增业务流水生产者。`effective_enabled=true` 只证明配置与服务端授权有效，不证明 APK 消费配置或业务ID上传。上午首屏0须核两张原始表；不能只查 v1 表漏掉 legacy。兼容已上线，不能再用旧“wire合同不兼容”描述当前服务器。
5. **待生产验证：授权/水位过滤。** 原 R1 查询绑定 owner/account/epoch/grant；legacy scope 还冻结 binding_version 并验证 account 唯一。若原表有行但不在当前范围，页空是授权结果。不能解绑重绑、回调旧 epoch 或后移/回拨 grant 来“找回”。对话授权与 R1 上传配置不是同一授权。
6. **待生产验证：Analytics旧历史门太窄。** 即使接上当前 `readArkHistory`，它仍要求 occurred 和 received 都不早于 grant.not_before_ms，且最近14天；有当日且早于事实的 `g1.logical_day_changed(gm_override=false, logical_day=CST日)` 正证；当日任何 GM/debug/test 证据排除整天；可疑钟/截断/大于14天晚到/早于发生2秒接收被排除；512行上限与同刻冲突保守降级（`history.ts:11-37,49-52`）。先逐门计数，不可把所有排除统称“无历史”。
7. **已确认：Analytics保存期限限制。** raw按received保留14天，事实/统计90天（`analytics/rollup.ts:92-100`）。`analytics/ingest.ts:51-55` 的90天事实只留部分语义与reward摘要哈希，已丢币余额、奖励数量和 elapsed_seconds；因此90天统计不能恢复金额或用时。早于raw留存的业务细节只能继续查已有备份/端侧存档，不能从计数重建。

## 3. 最小兼容修复建议

**第一步：暴露“有什么、为什么没进入摘要”。** 给 admin 的身份与接入/覆盖提示添加按域数量、首末时间与过滤原因计数；保留缺测 null。当前快照增加受限诊断元信息（原 source_mode、采样/接收时间、字段非空状况；需要数值时明确未验证来源），避免 non_normal 抹去所有存在证据。不让这部分成为正常资产或家长收益。

**第二步：将真实旧事件作为独立历史事实读出。** 若生产 Analytics 有可归属数据，为 C 增加明确历史授权的只读投影和分页，复用当前冻结身份/读前后校验模式；来源标 `analytics_event`、原事件ID、原发生/接收时间、来源可信度、`origin_verified=false`、覆盖起止与不完整说明。保留原事件原值；缺 save、原实例、原因时不硬塞 R1 的强字段。旧兼容 scope 只授权 legacy records，不能默认把其含义扩成任意 Analytics历史；应由主执行者核本轮用户授权后冻结明确范围。

- 旧 `wallet_balance_changed.after`/库存quantity可展示为“当时余额/库存观测”，不回填当前资产。
- 旧 reward_granted 只有在奖励ID去重、来源与真实日期可信、冲突排除后展示为“已观测历史奖励”；不要用 wallet delta 当收入。不能绕过 normal 证据，也不把进度计数当领取。
- 道具全历史读取应保留所有已知item_id、quantity、status与来源；当前 `readArkHistory` 只认补勤卡不足以满足“道具历史”。没有稳定实例时只称聚合库存变化，不假造获得实例。
- 先做独立历史字段/入口，不改变 `ark.available`、昨日摘要、最新获得现有语义；无需迁移或复制旧原始数据到新 R1表，也无需要求设备重发不存在的旧R1记录。
- 有真实 focus_segment 在7日外时，增加日期范围的使用历史读取即可；若全历史为0，应安装已修采集门的新候选并用真实事件验证，旧缺测不能补造。游戏 elapsed_seconds 可作为独立“奖励进度观测”显示，不能计入普通使用时长。

**第三步：继续未来数据链。** 原 mini009 R1 已有精确兼容接收，不要重新造一套上传合同。用保留 mini009能力且带4/0修复的候选包，验证活动APK、配置、真实业务提交、持久队列、逐ID ACK、两张原始表、家长读取、页面。具体构建/安装状态归主执行者实查，本报告不宣称已安装mini010。

## 4. 给主执行者的生产只读SQL

每个库使用 Node `new DatabaseSync(真实路径,{readOnly:true})`，设置 `PRAGMA query_only=ON`；只用已存在的实际文件。不要 import ArkStore/RecordsStore/AnalyticsStore 执行审计：构造器会做DDL/PRAGMA或迁移。跨库读取若用 ATTACH 必须 `file:...?...mode=ro`。按下列具名参数绑定值，禁止拼接输入；结果只输出计数、业务枚举、时间与合规资产字段，不选整行/正文/电话/密钥。

### A. Telemetry：先全历史计数，再看7日

```sql
SELECT type,COUNT(*) n,MIN(occurred_at_ms) first_occurred_ms,
 MAX(occurred_at_ms) last_occurred_ms,MIN(server_received_ms) first_received_ms,
 MAX(server_received_ms) last_received_ms
FROM device_telemetry_event WHERE sn=:sn GROUP BY type;

SELECT COUNT(*) n,MIN(captured_at_ms) first_captured_ms,
 MAX(captured_at_ms) last_captured_ms,MAX(server_received_ms) last_received_ms
FROM device_telemetry_snapshot WHERE sn=:sn;

SELECT json_extract(payload_json,'$.lid_open') lid_open,
 json_extract(payload_json,'$.present') present,COUNT(*) n
FROM device_telemetry_snapshot WHERE sn=:sn GROUP BY 1,2;

SELECT date,focus_ms,correct_rounds,deviated_rounds,no_person_rounds
FROM device_telemetry_daily WHERE sn=:sn ORDER BY date;

SELECT COUNT(*) n,MIN(json_extract(data_json,'$.start_ms')) first_start_ms,
 MAX(json_extract(data_json,'$.end_ms')) last_end_ms
FROM device_telemetry_event
WHERE sn=:sn AND type='focus_segment' AND json_valid(data_json);
```

如focus非0，再分 JSON类型/整数/0≤start<end/时长≤86400000、重叠和日期范围；SQL简单 SUM 不能替代 `usageRange` 的重叠剔除逻辑。

### B. Ark：当前存在、模式、授权，以及两表物理记录

```sql
SELECT enabled,revision FROM ark_settings WHERE id=1;
SELECT epoch,not_before_ms FROM ark_grant WHERE sn=:sn;
SELECT c.received_at_ms,json_extract(c.body,'$.captured_at_ms') captured_at_ms,
 json_extract(c.body,'$.source_mode') source_mode,
 json_extract(c.body,'$.wallets.family_coin') family_coin,
 json_extract(c.body,'$.wallets.stardust') stardust,
 json_extract(c.body,'$.inventory."M-CARD-001"') cards,
 (c.grant_id=g.grant_id) same_current_grant
FROM ark_current c LEFT JOIN ark_grant g ON g.sn=c.sn WHERE c.sn=:sn;

SELECT 'v1' format,COUNT(*) n,MIN(sort_ms) first_sort_ms,
 MAX(sort_ms) last_sort_ms,MAX(received_at_ms) last_received_ms
FROM ark_record WHERE sn=:sn
UNION ALL
SELECT 'legacy',COUNT(*),MIN(sort_ms),MAX(sort_ms),MAX(received_at_ms)
FROM ark_record_legacy WHERE sn=:sn;

SELECT reason,time_status,json_extract(body,'$.source_mode') source_mode,COUNT(*) n
FROM ark_record WHERE sn=:sn GROUP BY 1,2,3;
SELECT json_extract(body,'$.record_kind') record_kind,time_status,
 json_extract(body,'$.source_mode') source_mode,COUNT(*) n,
 MIN(coverage_from_ms) coverage_from_ms,MAX(dropped_records) max_dropped_per_group
FROM ark_record_legacy WHERE sn=:sn GROUP BY 1,2,3;
```

若有物理行，再把当前registry身份、grant与scope在进程内比较，输出匹配/不匹配计数（不输出scope原文或secret）：v1逐项核 `origin_parent_account_id/origin_device_account_id/origin_epoch/origin_grant_id`；legacy按 `sha256(canonical(scope))` 核scope_key与save范围。另按 occurred_day 分组，确认不是昨日日期/normal/时间可信度限制所致。未传过滤的records第一页0也应核API是否返回错误被前端误读。

### C. Analytics：旧原始资产/奖励证据是本轮重点

在Analytics实际运行环境按 `AnalyticsDeviceReader.arkDeviceKey` 的 HMAC算法计算C的完整key：`HMAC-SHA256(secret,'p003-analytics-v1\0'+SN)`；只在内存持有，不打印secret或完整key。不可用SN、public_id、截短key或device账户直接筛analytics_event。参数 `:grant_ms` 来自上述Ark授权；`:window_ms = now - 14*86400000`。

```sql
SELECT event_name,COUNT(*) n,MIN(occurred_at_ms) first_occurred_ms,
 MAX(occurred_at_ms) last_occurred_ms,MIN(received_at_ms) first_received_ms,
 MAX(received_at_ms) last_received_ms,SUM(clock_suspicious) suspicious
FROM analytics_event WHERE device_key=:device_key GROUP BY event_name;

SELECT event_name,
 SUM(occurred_at_ms<:grant_ms) before_grant_occurred,
 SUM(received_at_ms<:grant_ms) before_grant_received,
 SUM(occurred_at_ms<:window_ms) before_window_occurred,
 SUM(json_extract(properties_json,'$.truncated')=1) truncated,
 MIN(json_extract(properties_json,'$.item_id')) sample_item_id,COUNT(*) n
FROM analytics_event
WHERE device_key=:device_key AND event_name IN
 ('g1.wallet_balance_changed','g1.inventory_changed','g1.makeup_card_balance_changed',
  'g1.reward_granted','g1.logical_day_changed','g1.progress_checkpoint')
GROUP BY event_name;

SELECT occurred_day,event_name,
 json_extract(properties_json,'$.gm_override') gm_override,
 json_extract(properties_json,'$.source_mode') source_mode,COUNT(*) n
FROM analytics_event
WHERE device_key=:device_key AND event_name IN
 ('g1.logical_day_changed','g1.command_failed','g1.runtime_command_completed',
  'g1.gift_became_available','g1.gift_claimed','g1.reward_granted')
GROUP BY 1,2,3,4 ORDER BY occurred_day;

SELECT event_name,json_extract(properties_json,'$.item_id') item_id,
 COUNT(*) n,MIN(occurred_at_ms) first_ms,MAX(occurred_at_ms) last_ms
FROM analytics_event
WHERE device_key=:device_key AND event_name IN
 ('g1.wallet_balance_changed','g1.inventory_changed','g1.makeup_card_balance_changed')
GROUP BY 1,2;

SELECT tier,source_event_name,COUNT(*) records,SUM(source_event_count) source_events,
 MIN(received_at_ms) first_received_ms,MAX(received_at_ms) last_received_ms
FROM analytics_tier_event WHERE device_key=:device_key GROUP BY 1,2;

SELECT dimension,COUNT(*) days,MIN(day) first_day,MAX(day) last_day,
 SUM(event_count) event_count FROM analytics_device_day
WHERE device_key=:device_key GROUP BY dimension;
```

raw有行后可在进程内运行只读、纯查询版 `readArkHistory` 并计每个排除门（授权水位、14天、normal正证、GM、时钟、截断、限量、冲突），不要为调用该函数实例化写入型 AnalyticsStore。原函数的输出只是有限资产观测/今日进度奖励，不能直接当全历史接口。`analytics_tier_event` 的aggregate/diagnostic 另列覆盖，不能将聚合次数变成业务资产。

## 5. 验证与交付边界

- 已逐条核对现行源码及 `docs/miniapp-admin-20261117/HANDOFF.md`、`server/docs/records-r1/`、`server/docs/parent-history-20261116/` 交付记录。
- 既有上午回执为274条对话、usage null、当前授权流水首屏0、mini008自报、上传有效true；这是当时API事实，不是本报告新做的生产证据。
- 本报告未运行实现测试，因为没有改实现；本子代理未连接生产。主执行者提供的08:45 `LIVE-DATA.json` 已只读核阅，更新结论见下一节；未将主执行者查询冒称本代理执行。
- 任何“历史已找回”应至少列原始表数量/覆盖、授权范围、API同ID字段对账、客户端真实显示；任何“确实缺测”须基于该数据域全历史原始事实，不能由一个摘要available=false推定。

## 6. 08:45生产证据更新与可直接实施的最小合同

来源：[LIVE-DATA.json](/Users/fu-121/.local/state/p003-history-identity-audit-20261117/LIVE-DATA.json)，采样北京时间2026-11-17 08:45:18.625，主执行者生产只读采集，本文只读该脱敏回执。

| 项 | 本轮事实 | 产品应怎样说明 |
|---|---|---|
| 当前归属 | active、parent和Brain均存在、binding_version=1、epoch=2；grant有效 | 仍需完整tuple/唯一性检查，不凭“有绑定”直接开放其他设备历史 |
| 当前快照 | source_mode=unknown；家族币/星尘null；补勤卡1；逻辑日2026-11-12 | 当前合格normal资产仍暂无；管理员可看到“原始快照存在，模式未证实” |
| R1 | v1和legacy物理表均0 | 新业务流水暂无真实上传；不是旧历史不存在 |
| 使用 | Telemetry只有posture/presence类型，没有focus_segment | 已上报有效使用缺测；不能显示历史使用0分钟 |
| 旧游戏记录 | inventory_changed 21、reward_granted 11、makeup_card_balance_changed 5、progress_checkpoint 3 | 可读的旧事实共40条（四类型事件行数相加，不代表40次独立业务） |
| 游戏进度 | 11月6日三个检查点，elapsed_seconds=301/600/902 | 按条展示“当时奖励进度301/600/902秒”，绝不相加为1803秒或计入usage |
| 两币 | wallet_balance_changed事件0、当前余额null | “未采集到钱包余额变化；余额未知”。LIVE-DATA的11条奖励仅展示8条样例，另3条须全量按rewards.item_id聚合后才可断言币种奖励也为0 |
| 授权水位 | grant.not_before=11月12日08:09:16；全部11条logical_day_changed发生早于该水位 | 现成readArkHistory无任何合格normal日正证，直接接它仍会空；明确旧历史授权应使用独立读范围，不修改已有grant |
| 日期不一致 | 11月16日14:47的奖励仍带logical_day=11月12日；当前快照也是旧逻辑日 | 同时显示“报告发生日期”和“游戏逻辑日”，不能用逻辑日冒充真实领取日或把它自动纠正为normal |

### 最小API（新增读入口，不修改当前摘要）

1. 家长：`GET /v1/parent/devices/:publicId/observations?kind=all|rewards|inventory|progress&limit=20&cursor=...&from_day=...&to_day=...`。
2. admin：`GET /api/admin/devices/:sn/miniapp/observations`，沿用管理员身份并调用同一投影，返回语义与家长一致。
3. Analytics侧增加受已有内部token保护的只读接口，例如 `/internal/analytics/parent-observations`。实际Analytics进程自己计算HMAC device_key并查询原库，避免Brain跨进程写入/打开Analytics数据库，保持现有Node22/Node24职责。只允许四个确定类型：`g1.reward_granted`、`g1.inventory_changed`、`g1.makeup_card_balance_changed`、`g1.progress_checkpoint`；之后确有钱包记录再加 `g1.wallet_balance_changed` 分支也可。当前可在summary中明确该类型0。
4. 只读投影不写R1表、不改变Ark当前快照、不改grant、不导入正常收益汇总。旧事件缺save/稳定实例时不伪填；重复的补勤卡与库存事件不相加成业务总次数。

建议响应骨架：

```json
{
  "ok": true,
  "data": {
    "schema_version": 1,
    "source": "analytics_event",
    "authorization_source": "legacy_explicit_scope",
    "origin_verified": false,
    "coverage": {
      "complete": false,
      "reason": "retained_observations",
      "raw_retention_days": 14,
      "min_occurred_at_ms": null,
      "max_occurred_at_ms": null,
      "first_received_at_ms": null,
      "last_received_at_ms": null
    },
    "items": [],
    "next_cursor": null,
    "has_more": false
  }
}
```

items为严格白名单联合类型，公共字段 `event_id,event_name,kind,reported_occurred_at_ms,received_at_ms,time_status,logical_day,mode_status`：保留真实client_event_id用于幂等对账；time_status为reported/clock_suspect，不能将设备自报时间说成校准真时钟；逻辑日缺失原样null；原事件不带mode时用 `mode_status=unverified`，不要写一个假normal。

| kind | 只返回这些业务字段 | 展示语义 |
|---|---|---|
| rewards | source_kind、reward_instance_id（若实际存在）、rewards[item_id,kind,quantity,tank_id] | “设备历史奖励记录”；未证实正常业务模式，不进入昨日正常收入/当前资产 |
| inventory | item_id、before_quantity、quantity、delta、status、tank_id、layer；补勤卡变化对应before/after/delta | “当时库存变化”；不称当前库存，不虚构实例获得时间 |
| progress | elapsed_seconds、checkpoint_minutes、completed_slots、current_slot（只返回原有字段） | “当时奖励进度”；不称学习时长/普通使用时间，不跨检查点或会话相加 |

summary可以随首屏返回各event_name的**已保留事件行数**、首末时间、wallet_observation_count=0、focus_segment_count=0（若跨域混入summary应保各自source），但不能称完整历史总量。当前Dashboard是同步函数，避免为新增按需历史强制改其为跨服务同步等待；新增history按需读取，故障只降级历史区。

### 单C历史授权与分页

- 复用已授权单C历史scope的完整身份元组和读取守卫，实现时将“读取C游戏旧历史”的能力纳入本轮明确范围；不能用现任家长或 `records.enabled=true` 推导全部设备都允许。可抽取现有 `parent-conversations.ts:61-75` 的完整tuple/active/account_uses=1与双次核对逻辑，而不把对话正文权限一并扩大。
- Brain入口读取当前public_id/SN/parent/account/binding_version/epoch，核真实parent/device角色和Brain account唯一；发送内部只读请求前冻结，返回前释放所有旧事务后重新核完整元组，变化则404不返回旧响应。原事件归属不存在时继续标 origin_verified=false，不能补原owner。Ark grant.not_before用于现有正常域，不阻断此明确授权旧历史；绝不下调grant。
- 游标绑定scope指纹、kind/date/limit、高水位、最后排序键和到期时间，固定首屏窗口；推荐occurred_at DESC+client_event_id的稳定顺序，高水位用rowid并带锚ID核验，raw prune导致锚丢失返回410要求刷新。time_status可疑事件保留在“全部日期”并显示未知发生日期，按日期过滤不偷偷拿received作为发生日。
- 服务端和客户端都no-store，不在本地持久化原事件清单；全局/单设备有界查询、页面limit≤50；不选context_json、整段原properties或任意字段，防止从别的事件扩出设备密钥/儿童内容。

### 最小UI

- admin保留现有六标签，新增“历史观测”标签；小程序在 `pages/index/real-details.tsx:60` 最近获得卡下添加“查看历史奖励与库存”入口，再复用已有 HistoryController 分页状态机。或者使用单独历史卡，避免把21条变化误塞成“最新获得”。
- 首屏固定说明：“这里是设备已同步的历史观测，原发生归属和正常模式尚未证实；不计入当前资产、正常收益或使用时长。” 各行仍可读具体物品与数量，不再全用“暂无数据”遮蔽存在事实。
- 奖励/库存/进度三个筛选；按北京时间显示发生时间，另显示原游戏逻辑日。11月16日/逻辑日11月12日必须原样可见。
- 三个进度样本显示 `11月6日10:38 当时奖励进度301秒`、`10:53 600秒`、`11:02 902秒`，顶部不生成“累计时长”。
- 家族币/星尘仍显示“余额未知；尚无钱包变化记录”，normal收益卡继续保持null；不要拿已有物品奖励数量折成币。
- UI改动点：`miniapp/src/services/history-api.ts`新增 DTO/reader，`pages/index/real-details.tsx`新增观察行/按需入口；admin新增独立ma分页状态。不要复用BusinessItem必须有saveId/itemInstanceId的接口硬塞旧Analytics。

### 最小验收用例

1. 使用脱敏真实事件fixture，21库存/11奖励/5卡变化/3进度完整分页按原ID对账，前三种的同一业务信号不做总和；当前DTO仍相等。
2. 301/600/902三个检查点原样显示，usage仍null；0钱包变化不会显示余额0。
3. grant前正常日证据、11月16日事件/11月12日逻辑日、原文无mode均可作为未验证历史查看，不能进入normal摘要。
4. 错家长/错public_id/错SN/account重复/角色异常/解绑重绑/ABA/读中换绑均不泄露；真第二连接触发，不能仅mock。
5. 首屏→后页→scope变化/锚被清理→400/410→首屏503→禁止旧cursor续页；刷新成功才恢复；切设备/退出时迟到响应作废。
6. 部署后原始只读计数→API每ID白名单字段→真实admin页面→小程序构建/真人页面分层留证，不产生生产合成奖励。

署名：codex（OpenAI）| 2026-11-17（北京时间）
