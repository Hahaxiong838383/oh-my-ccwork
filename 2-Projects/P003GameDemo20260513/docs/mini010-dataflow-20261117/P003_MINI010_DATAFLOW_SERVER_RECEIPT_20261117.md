# P003 mini010 数据全链路排查与服务端回执 · 2026-11-17

**结论：原始数据已落盘，未显示主要来自读取投影和页面接线缺失，并非 R1 上传仍不兼容。服务端与后台已于15:39上线，原家长A公网API、后台实页及本仓H5读取真实响应均通过。现役手机小程序的liveHomeView不在本工作树，其接入和端侧色温名称修正仍需下一轮实机确认。**

## 1. 本次证据范围

- 设备：C，SN 末 8 位 `02000031`，`public_id=dev_50b5415662259045`。
- 输入：`P003_MINI010_LIGHT_REWARDS_SERVER_RECEIPT_20261117.md/.zip`、`P003_mini010_小程序请求服务端排查回执_20261117.md`。端侧回执证明实装 `371_mini_010`，不是仅凭 OTA 自报判断。
- 服务端修复前读取：**2026-11-17 15:23:42.336 北京时间，HTTP 200**，使用已确认的家长 A 原账号及现有 `parent` 权限，绑定未变；服务器签发短时验证会话，不冒充手机登录日志。
- 路径：`GET /v1/parent/devices/dev_50b5415662259045/dashboard?timezone=Asia/Shanghai`；同时只读核对 SQLite。**业务写入 0**，没有补造奖励、清队列、改逻辑日或重新绑定。
- 精简对账证据：[PRE_FIX_RECONCILIATION.json](./PRE_FIX_RECONCILIATION.json)，SHA256 `f577edeed1d24fb3a20cde37e19fe9bbb314521c5e2c2d4b6cdbc9fcd3df081a`。文件保留必要记录 ID、原始 body 哈希和数据字段；不含凭据、完整家长账号、手机号或儿童对话。

## 2. 色温：已经落盘，另有端侧枚举问题和小程序未接线问题

下表均为 2026-11-17 北京时间，来自服务端保存的 `ingest_trace_id` 与相同 `snapshot_id` 的精确关联。三份原始快照均为 `led_enabled=true`、`brightness_level=3`、`focus_active=false`。

| Telemetry 请求/批次 ID | snapshot_id | 设备采样时间 | 服务端接收时间 | SQLite 原样保存的 color_mode |
|---|---|---|---|---|
| `tel_784a706289f341b1_837` | `snap_6b65f515-d694-4288-85ee-03a0f3b2ef46` | 14:49:51.484 | 14:49:54.392 | `cool` |
| `tel_784a706289f341b1_838` | `snap_1dad608b-344e-4476-b8de-662edae33534` | 14:50:13.655 | 14:50:24.474 | `warm` |
| `tel_784a706289f341b1_840` | `snap_367d5c36-5cde-4682-9d26-acf7dfd930bb` | 14:51:13.529 | 14:51:24.651 | `normal` |

端侧回执对应的 MCU 真实顺序为常规 raw=2、暖光 raw=3、冷光 raw=1。服务端所存字符串实际为 `cool / warm / normal`，与回执所指“冷光、常规名称对调”的代码问题一致。服务端未将其反向改写；旧 `ec-game` 通道的数值枚举和亮度 0–2 归一化值也未混入本接口。

修复前家长 dashboard 已返回 `data.device.color_mode="normal"`、亮度 3，接收时间 `1794900218607`；这属于 **15:23 读取时的最新快照**，不能冒称读取历史 840 时刻的 dashboard。现役小程序原先把色温固定显示“暂无数据”，适配层未接该字段，解释了“数据库有值、页面仍为空”。

本轮已将本仓参考小程序色温接到原有 `color_mode`，增加灯光、使用计时等已有遥测字段的只读投影。合法色温仍为 `cool / normal / warm`；未采集或未知为 `null`。**端侧冷光/常规枚举修正与下一轮实机三档复测仍需单独确认，服务器不制造补偿值。**

## 3. R1：13 条已落盘；本次窗口对应序号 8–13

修复前数据库同一 save 下已有 **13 条不可变 legacy 记录**：序号 1 是历史基线，2–13 是业务提交；8 条 `unknown`、5 条 `gm`、0 条 `normal`。各记录原文哈希、时间和变化在证据 JSON 中可复核。基线库存已有 7 个条目（含补勤卡 1 张），钱包原文为空对象；不能把空钱包补成 0，也不能把基线库存算作本轮新增收益。

完整 `record_id` 统一前缀为 `save-8da60f9a985d9f16addb154537a14186:`，以下用末尾序号简写。各行 `record_kind=business_commit`，顶层 `logical_day=2026-11-12`，实际提交/接收日期均为 **11 月 17 日**。

| 序号 | source_mode | 原始业务内容 | grant 的奖励日 | 服务端接收时间 |
|---|---|---|---|---|
| 8 | unknown | 每日礼包 `GIFT-TANK-001-DAY-03`：`E01-DEC-009 × 1`；库存无 → 1，待激活 | 2026-11-08 | 14:52:06.561 |
| 9 | gm | `previous_source_mode=unknown` → `gm`；奖励、钱包、库存及补勤数组均空，**只改变来源模式，不是一次奖励** | 无 grant | 14:52:36.655 |
| 10 | gm | `REGULAR-02`：补勤卡 `M-CARD-001 × 1`；库存 0 → 1 | 2026-11-08 | 14:53:06.755 |
| 11 | gm | `REGULAR-03`：家族币 +100，400 → 500 | 2026-11-08 | 14:53:06.760 |
| 12 | gm | `REGULAR-04`：家族币 +100，500 → 600 | 2026-11-08 | 14:53:06.768 |
| 13 | gm | `REGULAR-05`：`E01-DEC-010 × 1`；库存无 → 1，待激活 | 2026-11-08 | 14:53:36.885 |

这 6 条包含 5 个授予事实和 1 条模式切换；不是“6 件奖励”。卡类资源来自库存变更而非钱包字段。该窗口 `makeup_grants / makeup_uses` 均空；此前序号 6 另有补勤使用，已保留在历史查询。

### 四批 ACK 与落库证据的边界

| 端侧 batch_id | 请求 RID | 端侧合并结算条数 | 业务内容/接收窗口对应序号 |
|---|---|---:|---|
| `arb-ad592b75-31fc-41f4-a653-c50feab7e66c` | `arkrec-5e800ef1-150c-485e-a035-7110e018e6a8` | 1 | 8 |
| `arb-1444f8b2-85b6-4ec4-a3be-69dc2c5c904f` | `arkrec-3a6cdd2f-ed09-4c0a-9d50-aa1bf9d734cf` | 1 | 9 |
| `arb-8a4c92ed-7ccf-4028-9ad6-ce6c3341cb33` | `arkrec-b583e758-a6fe-401f-a6f5-2876a06b2167` | 3 | 10、11、12 |
| `arb-d928714a-4a0f-45d0-b8c0-2b616cf135e3` | `arkrec-5535f698-0a39-4e6d-88ad-b7ec76606469` | 1 | 13 |

端侧日志把 `accepted_record_ids` 和 `duplicated_record_ids` 合并为 accepted，回执合计 6 条结算、rejected=0。**服务器当时没有持久化逐批 ACK 响应及 batch/RID→record 的审计关联，现有数据库不能反推出该四次响应各自的 accepted/duplicated 数量，也不能写“新增 6、重复 0”。** 上表的批次对应依据为端侧操作内容、结算数量、记录序号及接收时间窗，是相互支持的对账对应；不同于 Telemetry 可凭持久化 trace 直接关联。设备与服务端钟有差异，不能仅按毫秒先后判拒收。

能确认的是：序号 8–13 六份原始记录全部存在、内容连贯、原 ID 与 body 哈希可查，且端侧确认有效逐 ID ACK、最后 R1 pending=0。此结论不等于夜批 Analytics 已上传或所有其他通道同时清空。

### 三种日期不得混用

- `record.occurred_at_ms`：11 月 17 日实际提交时间；服务端按它给流水定发生日。
- `record.logical_day`：上报的顶层游戏日 11 月 12 日，原样保存。
- `grant.logical_day`：本次奖励目标日 11 月 8 日，逐 grant 展示；补勤使用另有自己的目标日。

昨日收益查询 11 月 16 日，且仅正常来源。不能为了让它刷新而把 11 月 17 日的 GM 领取挪入昨天或把历史奖励日当实际收入日。

## 4. 根因与本次最小修复

| 数据域 | 真实断点 | 已实现修复 |
|---|---|---|
| 色温、灯光 | 色温已落库且旧 dashboard 有值；小程序未适配。灯光等原始字段未完整投影 | 使用原有枚举，补只读字段与页面；不改变端侧上传合同 |
| 资产与游戏 | `dashboardArk` 遇 gm/unknown 返回空资产与元信息；原本也未输出 progress | 新增 `ark.reported_state`，保留真实余额、卡数、进度、来源及时间；正常来源摘要继续独立 |
| 实时奖励与道具 | Dashboard 只给正常收益摘要；历史观测只读夜间 Analytics，未读取已 ACK 的即时 R1 | 新增 `records.recent_activity`，同授权事务复用原 records 查询前 20 条；继续分页沿用旧接口 |
| 奖励具体内容 | legacy 查询原投影丢弃 grants 及部分补勤/库存原始字段 | 保留 `grants / inventory_changes / makeup_grants / makeup_uses` 白名单字段；不改原记录 |

历史 Analytics 在修复前已同步奖励 11 条、库存 21 条、补勤卡 5 条、进度 3 条，钱包变化 0 条。端侧本次埋点仍按既定夜间调度积压；不能因此宣称本轮实时奖励没有上传。页面将“实时业务记录”和“夜间历史观测”独立列示，不将两条链路相加计算奖励总量，避免同一行为重复计数。

修复保持 `p003-ark-records-r1` 上传合同、原 ID、ACK、鉴权、绑定代次、原始事实和来源模式；未引入新上传协议。`normal / gm / unknown` 原样保留。`reported_state` 是设备已上传事实，不是将 GM 数据认定为正常收益。

## 5. 家长接口只读字段与示例口径

以下是本轮已实现的响应形状，示例数值取自 **修复前 15:23 生产原始记录**，用于核对投影；**并非本稿已取得的上线后返回证据**。

| JSON 路径 | 示例/规则 |
|---|---|
| `data.device.color_mode` | `normal`；合法值 cool/normal/warm，缺测 null，忠实于端侧原值 |
| `data.device.led_enabled / brightness_level / focus_active` | 开灯、亮度档位 1–3、设备计时布尔；缺测 null，不从其他值猜测 |
| `data.device.captured_at_ms / updated_at_ms` | 设备采样时间、服务器接收时间；原 snapshot_id 供服务端证据对账，不要求设备 DTO 新增该字段 |
| `data.ark.available / reason` | 此 GM 样本仍为 false / non_normal，指正常来源摘要不可用 |
| `data.ark.reported_state.source / source_mode` | `device.ark.state / gm`；无授权或无当前快照时整个 reported_state 为 null |
| `data.ark.reported_state.logical_day` | `2026-11-12` |
| `data.ark.reported_state.wallets` | family_coin=600、stardust=0；0 是有效值，null 表示缺测 |
| `data.ark.reported_state.inventory["M-CARD-001"]` | 1 |
| `data.ark.reported_state.progress` | timer_state=paused、claimable_count=0、next_reward.status=day_complete、remaining_seconds=null |
| `data.ark.reported_state.captured_at_ms / received_at_ms` | `1794900202836 / 1794900213819`；展示最近上报时间，不在页面自行递减倒计时 |
| `data.records.recent_activity` | source=ark_records、limit=20、items 为原 records 读取投影；新入库在刷新首屏后出现 |
| `data.records.recent_activity.items[*]` | record_id、record_kind、source_mode、发生/接收时间、logical_day、钱包变更；legacy 另有 grants、库存与补勤明细 |
| `data.records.recent_activity.next_cursor / has_more` | 使用原 `/ark/records?limit=20&cursor=…` 继续；游标冻结旧查询，新上报先刷新首屏 |
| `data.records.recent_activity.coverage` | complete=false；只说明已收到的部分历史，baseline 不算新增收入 |

例如序号 11 的 item 会同时含 `source_mode=gm`、`logical_day=2026-11-12`、`grants[0].logical_day=2026-11-08`、家族币变更 400→500。序号 9 没有 grants 与资源变化，页面不得增加一个奖励计数。当前余额、钱包增量及 grant 数量是同一业务的不同视角，不相加。

## 6. 已发布与验证（北京时间）

代码提交：`f4c885e2287a3c5ebdcc759dec6bb69daa5689aa`。15:39:02–15:39:06 发布5个服务端源文件及1个后台HTML；`p003-voice`重启12→13，健康200，Analytics及其他服务未动。绑定、环境、数据库结构和上传合同均未修改。备份 `/root/p003-mini010-dataflow-20261117/source-backup/`，按[MANIFEST.json](./MANIFEST.json)逐文件源回滚，不恢复业务数据库。

| 验证 | 实际结果 |
|---|---|
| 生产 Node 22.22.2 候选 | 13套相关回归全部通过，见[NODE22-TESTS.json](./NODE22-TESTS.json)；全部使用隔离SQLite。发布前另一任务更新语音模块，保留其8个新/修改文件并在最新基线上重跑通过。初次隔离环境漏拷文档schema；补齐后旧strict响应校验暴露新增字段不识别，已更新只读schema再通过，未更改上传schema。 |
| 小程序本仓 | Node24共115项通过、类型检查通过，H5与weapp构建通过；合成浏览器刷新回归通过。见[FRONTEND-VERIFICATION.json](./FRONTEND-VERIFICATION.json)。 |
| 后台隔离UI | 18组通过，44次读取；解绑3次仅合成夹具，真实C没有解绑；隐藏对话及短信身份阶段保留。 |
| 家长A公网 dashboard | **15:39:06.457，HTTP200**。设备色温normal、开灯false；reported_state为gm，家族币600/星尘0/补勤卡1，游戏日11/12，stopped/day_complete/claimable_count=0；recent_activity含13条。见[PARENT-DASHBOARD-AFTER.json](./PARENT-DASHBOARD-AFTER.json)。 |
| 家长A公网 records | **15:41:21.583，HTTP200**。13条记录ID、source_mode、logical_day、occurred_at及grants/inventory_changes/makeup数组与SQLite逐条一致，包含序号8–13。见[PARENT-RECORDS-RECONCILIATION.json](./PARENT-RECORDS-RECONCILIATION.json)。原13份body哈希与发布前一致。 |
| 公网后台实页 | **15:40:11–15:40:24**，5个详情GET全部200；资产/game/色温与当次DTO逐项匹配；13条R1与夜批列表分开，点击刷新同时更新dashboard与observations。页面错误0、真实业务写入0、对话请求0。见[PUBLIC-BROWSER.json](./PUBLIC-BROWSER.json)。公开HTML字节SHA与提交候选相同。 |
| 本仓构建H5读真实生产 | **15:40:11–15:40:16**，8个GET全部200；生产原字节响应仅补CORS，未mock业务。两次dashboard刷新、13条R1/5条11月8日授予/GM标签/星尘0/game状态显示一致，夜批40条分2页无重复，退出后清空。见[LIVE-H5-PROBE.json](./LIVE-H5-PROBE.json)。 |

公开家长验证使用原账号原权限的短时服务端验证会话，不是iPhone登录证据；未发短信、未发起微信授权，临时凭据已删除。后台仍保留微信字段并提示待企业认证后接入。

## 7. 小程序交付与下一轮边界

本仓 `RealDataHome` 已实现并构建；现场回执所称 `liveHomeView` 不在本工作树，不能说部署服务端就自动更新手机页面。交付包 `P003_MINI010_DATAFLOW_SERVER_20261117.zip` 提供字段说明、源码补丁和参考H5/weapp构建；请现役前端按字段映射保留现有页面，只补数据读取。接口映射见[小程序接入说明](../../apps/miniapp/docs/mini010-light-rewards-20261117.md)。本轮未向微信平台上传/发布。

下一轮只需确认两项：

1. 现役小程序接入已有color_mode及新只读reported_state/recent_activity后，刷新能看到本回执已验证的实际数据。上传协议、ACK、原记录ID无需调整。
2. Android原代码修正MCU冷光/常规名称映射，再实测三档物理色温；服务端不反向补偿错误枚举。当前返回normal只是忠实显示端侧已上传值，不代表物理冷光已修正。

baseline、钱包余额、钱包增量、grant奖励和夜批观测分别展示，不相加。GM/unknown可以查实值，仍不能称正常收益；昨日正常收益没有11月16日记录时继续缺测，不补0。

署名：codex（OpenAI）| 2026-11-17 15:42 北京时间
