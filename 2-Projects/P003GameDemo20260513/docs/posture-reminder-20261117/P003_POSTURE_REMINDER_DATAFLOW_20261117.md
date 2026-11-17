# P003 坐姿提醒次数贯通回执 · 2026-11-17

## 19:04 后台显示修复补充

用户反馈仍看不到次数后，核实18:48线上HTML与发布SHA一致，重新打开总览确有7次；同时确认上一版仅在“数据总览/使用时长”显示，设备列表和其他详情标签没有入口。不能据此断言用户一定用了旧缓存；已开页面的“刷新详情”只更新API，不会替换HTML模板。

19:03:57发布 `78c4bea653c0227b5fe7d3aa04481a77b5d7d7fa`，仅修改后台静态页面，无服务重启：

- 设备详情顶部常驻今日/历史提醒次数，切换任何标签仍显示。
- 列表每行增加“坐姿提醒”直达按钮，详情增加同名标签和“查看提醒明细”。
- 继续读取原 dashboard DTO；加载中、读取失败、缺测不保留旧数字，也不补0。

19:04真实后台从列表直接进入C机提醒，顶部今日7次/历史7次；资产、历史奖励、身份标签及刷新后均同源7次，5个业务GET全部200、页面错误0、业务写入0。22步/52请求的隔离浏览器回归通过。公网HTML SHA为 `fc509cedacd83b66bce0e59666fae2c862dbfcad1368357443fe31f929e0b98d`。

访问 [更新后的后台](https://kidshub-ai.hahaxiong.cc/admin/?v=posture-20261117b)，路径“Worker 管理 → 小程序 Dashboard → C机 → 坐姿提醒”。已打开旧页面须重新加载整页，不能只点刷新详情。

[真实页面截图（仅提醒卡，无身份信息）](./visibility/LIVE-POSTURE-SUMMARY.png) · [公网页面验证](./visibility/PUBLIC-BROWSER.json) · [回归结果](./visibility/UI-VERIFICATION.json) · [静态页发布](./visibility/RELEASE.json)。以下18:48数据与容量回执继续保留为当时证据。

---

结论：18:48 已发布服务端与 Worker 小程序 Dashboard，家长 A 和后台接口、真实后台页面及本仓参考 H5 均读取到 C 机今日/已接收历史提醒 **7 次**，刷新一致。当前仓小程序已完成读取和双构建；现场 liveHomeView 不在本树，微信手机发布仍待同事接入本次字段。另修复发现的新 R1 写入磁盘门槛问题，上传协议和 ACK 不变。

## 统计口径

只统计设备鉴权关联的 `type=posture_reminder` 且原值 `data.outcome === "played"` 的去重事件；键为 `(sn,event_id)`。played表示端侧开始播放调整坐姿语音，不证明播放完成、声音可听见或孩子已坐正。focus_id允许null。

`suppressed_cooldown`、未知outcome、姿态deviated轮次、心跳、使用时间和混合批次事件数均不计为提醒。按 `occurred_at_ms` 的北京时间自然日归属，发生与接收时间分别保留，补传不全部计到到达当天。无可信提醒记录显示缺测，不拿聚合表的默认0作完整零次证明。覆盖仅限已接收事件。

## 生产只读对账（18:26:36.703，北京时间）

设备C：SN末8位 `02000031`，public_id `dev_50b5415662259045`。核实原绑定家长A及parent权限，绑定未变；使用服务端短时验证会话，不是iPhone登录凭据。未发送短信、未注入提醒、未操作设备或修改绑定。

`GET /v1/parent/devices/dev_50b5415662259045/dashboard?timezone=Asia/Shanghai` HTTP200，原字段 `data.today.posture_alert_count=5`。当时原库保留的已接收历史为5条posture_reminder，均为played、focus_id=null、发生日2026-11-17；当前今日与已接收历史总数都是5。没有收到suppressed_cooldown或未知outcome，不代表设备永远没有发生过这些情况。未将17次deviated姿态检测计成提醒。

| event_id | 首次入库 trace | 发生时间（北京） | 接收时间（北京） | outcome | focus_id |
|---|---|---|---|---|---|
| `evt_6b216b5c-5b35-4b5d-9bc8-6a317d20bd24` | `tel_784a706289f341b1_677` | 2026-11-17 11:22:05.714 | 2026-11-17 11:22:08.477 | played | null |
| `evt_d20522d0-b79a-44c4-9d51-b3894b506de8` | `tel_784a706289f341b1_701` | 2026-11-17 11:40:00.551 | 2026-11-17 11:40:03.355 | played | null |
| `evt_70777226-ef01-4dff-8efa-805c5a86736d` | `tel_784a706289f341b1_727` | 2026-11-17 12:39:14.164 | 2026-11-17 12:39:41.156 | played | null |
| `evt_b48f9af0-feea-42f9-978b-78d4cdac80e3` | `tel_784a706289f341b1_935` | 2026-11-17 16:59:31.556 | 2026-11-17 16:59:59.220 | played | null |
| `evt_bf7f42bf-2659-4a8a-8f1c-4ec4499a4f4b` | `tel_784a706289f341b1_941` | 2026-11-17 17:02:40.913 | 2026-11-17 17:03:06.811 | played | null |

以上5条均早于回执17:31–17:37复测窗口，不是该窗口产生的26次提醒。发生至接收的秒级延迟和batch clock_skew不能直接说明发生时钟错误；两个时间保持原样。

## 指定批次961–970

范围为 `tel_784a706289f341b1_961` 至 `_970`。精确查询原库 `ingest_trace_id`：共26条事件（10条focus_segment、16条presence_transition），**无posture_reminder**；9份snapshot，968为纯事件批次无snapshot。结论是“本轮批次未包含提醒事件”，不推断功能不存在，也不把本轮没看到等同当天0次。

原库只保存首次插入的trace关联，已存在事件重试不会覆盖该字段；端侧回执给出duplicate=0/rejected=0，原始逐批ACK响应未在服务器永久保存，不从原库独立倒推响应分类。相应首次入库事件数与端侧26条ACK数一致。详见[脱敏原始对账](./PRE-RELEASE-RECONCILIATION.json)。

## 实施与验证

代码提交：`a518001e08450aa722cef0fd4bc31daf1308118b`。18:48:30–18:48:32 发布两份服务端源码、后台 HTML 和一项容量配置；只重启 p003-voice，其他服务与绑定保持不变，无 DB 迁移。上传接口仍为原 `/v1/device/telemetry`，不新增累计次数字段，不导入附件示例充当真实数据。

新增 `data.posture_reminders`，统一提供 source、timezone、today、history、daily 和 coverage，按原始已去重事件统计；旧 `data.today.posture_alert_count` 与 today.played_count 一致。原始入库与日计数改为同一事务，重试不会因先入库、后聚合失败而漏计。未知 outcome 仅保留原始事实，不再误计为冷却。snapshot=null 仍能读取提醒；其他摘要故障不连带清空提醒。

按日合法时间但存在疑点的记录仍按上报日统计并标注，无法归日的时间单独标 invalid_time_count。无记录或只有未知 outcome 时保持 available=false/count=null；只有支持的有效观测才返回数字，包括合法0。历史仅代表已接收记录，coverage.complete=false。

### 已有真实数据自动更新至 7 次

排查过程中另收到以下两条真实上报，均发生于发布之前。它们不是人工测试事件，也不属于961–970窗口：

| event_id | 首次入库 trace | 发生时间（北京） | 接收时间（北京） |
|---|---|---|---|
| `evt_04dbd5a0-304e-4953-a76d-44d2ce170425` | `tel_784a706289f341b1_1041` | 18:27:20.888 | 18:27:23.915 |
| `evt_fe9dd56b-caea-41e7-90ad-ce585c34c5da` | `tel_784a706289f341b1_1050` | 18:32:57.023 | 18:33:27.050 |

两条均为 played、generic_deviation、focus_id=null，日期2026-11-17。因此18:26查到5次，18:48查到7次，是有新原始事件的自然变化。

18:48:32.486 使用家长 A 现有权限读取公网 dashboard，HTTP **200**；后台对应 dashboard 也 **200**，两个接口的完整 posture_reminders 相同。脱敏要点：

```json
{
  "source": "telemetry.posture_reminder",
  "timezone": "Asia/Shanghai",
  "today": {
    "date": "2026-11-17",
    "available": true,
    "played_count": 7,
    "suppressed_count": 0,
    "updated_at_ms": 1794911607050
  },
  "history": { "available": true, "played_count": 7 },
  "coverage": { "complete": false, "reason": "received_events_only" }
}
```

18:49 实际后台页面：总览、使用时长页及刷新后的提醒均为7次，按日记录、更新时刻与同一次响应一致；5个业务GET均200，页面错误0。参考小程序已构建H5传输生产原始响应字节，仅补本地CORS头：8个GET均200，首次及刷新后7次，历史40条/2页、资产游戏与色温仍可显示，页面错误0。未发送短信、未触发微信授权、未解绑、未写测试业务。两份临时会话文件已删除。

| 验证 | 结果 |
|---|---|
| 当前生产基线 Node22 隔离回归 | 9组通过：dashboard/admin/unbind/2GiB容量写入/history-dashboard/gateway/scope/telemetry/legacy-http |
| 重复和口径边界 | 同事件重放3次只计1；冷却、未知结果、姿态轮次不混入；纯事件无snapshot可见；跨日补传归原日 |
| 耐久与异常 | 日表失败回滚原始插入、重试成功；历史日表缺失仍可读原始；非法时间raw保留ACK；非归属家长404 |
| 小程序 | 14组118项、tsc、最终渲染10项、H5和weapp构建通过 |
| 本地浏览器fixture | 后台20步/48请求；H5提醒2→3、历史10→11刷新通过。合成值仅测试，不进生产 |
| 公网与真实响应页面 | 两端API200且提醒DTO一致；真实后台5GET、参考H58GET，均200且展示7次 |

证据：[发布记录](./RELEASE.json)、[接口与原库逐条对账](./POST-RELEASE-PROBE.json)、[后台实页](./PUBLIC-BROWSER.json)、[H5真实响应](./LIVE-H5-PROBE.json)、[Node22](./NODE22-TESTS.json)、[前端构建](./FRONTEND-VERIFICATION.json)。小程序同事按[字段交接表](../../apps/miniapp/docs/posture-reminder-20261117.md)读取即可；不要求安卓更改现有上报。

## 同步解决：新增 R1 的磁盘预留门槛

回归暴露另一项真实运维阻塞：39.01GiB系统盘可用约6.05GiB，而R1默认要求至少8GiB可用，导致新增流水 `capacity_exceeded`；这是容量门槛，不是合同不兼容，重复ACK不受影响。实际只有13条、14,296B原始payload，10,000条/32MiB配额未满。

18:48 在现有配置中仅增加 `ARK_RECORDS_MIN_FREE_BYTES=2147483648`（2GiB），仍保留全局/单机10,000条和32MiB限制，以及每次4倍payload+64KiB写入余量。未清库、删流水、变更合同或放宽归属。发布后可用6,484,811,776B，已高于新底线和最大单条余量；同盘隔离数据库以2GiB门槛完成写入及70项回归。

18:53只读复核时R1仍13条，**尚未取得发布后端侧新一轮上传ACK**；不可把配置校验当实机补传成功。端侧保持原ID按既有503/Retry-After退避重试，后续以真实新入库与逐ID ACK核验，不需要升协议。补传观察：[18:53只读记录](./R1-RETRY-OBSERVATION.json)。容量证据：[发布前核查](./CAPACITY-BEFORE.json)及[发布后配置验证](./POST-RELEASE-PROBE.json)。

当前仓前端为RealDataHome，现场此前回执的liveHomeView未在本工作树找到；本仓实现/构建与微信平台发布分别记账。原家长权限及已授权历史范围保持，后台历史对话仍隐藏、短信登录和企业认证后接入微信身份的安排不变。

署名：codex（OpenAI）| 2026-11-17 18:49 北京时间
