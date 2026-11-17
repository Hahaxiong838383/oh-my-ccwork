# C机端侧历史数据与采集能力审计

结论：端侧缺口已分层定位，尚未实机修复。C上午仍自报 `371_mini_008`；该版确有普通使用时长采集门错误，且尚无 mini009 新增的 R1 业务流水生产者。旧档有独立的游戏台账、Analytics 有部分历史事件，不应把「R1为0」概括为「过去全部无数据」。星尘/家族币当前为 null 的直接源码原因可由 `source_mode=unknown` 解释，暂未发现货币 ID 漏接；实际余额是否仍在旧档须只读取得C原档后确认。

本审计只读本地代码、交付回执、共享记忆及主代理提供的生产聚合事实；未连接设备、未SSH、未安装/构包、未修改业务代码或生产数据，未运行新的业务测试。主代理实时事实见同目录 `LIVE-DATA.json`；下文计数为本轮快照，不作为长期常量。

## 1. 精确版本与能力

| 版本/源码 | 端侧真实能力 | 本轮边界 |
|---|---|---|
| mini008，构建 `f083b6e4066c8bbfda43f53e2bd8b8723a9810c0` | 使用片段算法、Telemetry持久队列、Ark当前状态投影、原有夜间Analytics | 使用门的MCU枚举错误；无R1业务流水 |
| mini009，构建 `006ac68a29447e8bc14fb655206d87bbf1f771a3` | 加入Rust原子业务日志→Godot交接→Native独立持久队列→R1上传 | 原开盖错误保留；原始凭据scope有续token问题；已出包不等于C安装 |
| 联合修复 `d56977517487cd6002ef16cf3ba266af24aac9ca` | 保留mini009能力，修正开盖4/0及稳定SN+binding_version scope | 已有主机验证；没有本修复签名APK、C安装和同事件闭环证据 |

mini008回执APK SHA256：`57ca06637aff8097997e6eb9ef11cd7ef9255c97a940883ddfbbaf975533bf23`，85,329,509字节。服务器自报版本只证明声明，仍需活动APK字节核同。

## 2. 使用时长为什么没有

- mini008/009精确 `P003TelemetryCoordinator.kt:575,625–626` 按原始 `workState/Hall1` 比较私有 `WORK_ACTIVE=1/HALL_OPEN=1`；同源权威枚举为工作4、开盖0、合盖1。正常4/0会被错判为不开盖，既影响快照 `lid_open`，也阻断使用计时。已有归档红→绿测试直接连接生产解码器到Tracker，不只是测试一个人为传入的true。
- mini008目标口径是开盖、摄像头权威有人、无配对/OTA阻塞、时钟可用；约每秒观察，约60秒生成 `focus_segment`，暂停/退出补尾，数据仅 `start_ms/end_ms`。它不依赖游戏focusActive、不读取GM倍率。
- 当前生产聚合：C有1,243条姿态与766条在位事件，`focus_segment=0`。这些离散事件不能重建连续开盖使用分钟；不能用对话跨度、在线时间、presence间隔、session TTL或game checkpoint补算。
- Godot日进度里的 `presence_accumulated_ms`、route的 `accumulated_seconds`、Analytics的 `progress_checkpoint` 是游戏逻辑进度，可能受补历史日/GM推进影响，且口径不同；当前301/600/902秒三个checkpoint不能求和，也不能当成902秒设备使用时长。
- 如果C本地队列仍有真实focus_segment可按原ID继续上传；已ACK事件会删正文，Telemetry只是有界传输队列，并非永久历史。未被生成或已无可靠原始证据的历史分钟保持未知；修复主要保障之后采集。

## 3. 钱包 null 是否是字段漏接

精确mini008的 `g1_ark_state.rs`、`g1_analytics_state_observer.gd`、`analytics_event_client.gd` 与本审计HEAD对应文件无差异。

- Ark读取真实 `snapshot.g1.formal.wallet`，家族币键 `C-FAMILY-001`、星尘键 `C-STARDUST-001`；`G1FormalState.normalize()`已将旧 `C-COIN-001`一次性归入家族币，保留星尘独立币种。
- `ark_wallet_is_known()`要求正式schema、合法钱包整数、可反序列化结构，以及原始来源标记normal或gm。**即使钱包里确实有非零余额，来源unknown也返回两个null**。测试 `unknown_provenance_never_becomes_known_wallet`用家族币7验证这一行为；`valid_legacy_currency_normalizes_once_without_double_credit`覆盖40旧币+7家族币得到47且不重复入账。
- 旧档缺来源标记时加载会保留unknown，不能被serde默认值升级成normal。成功GM事务会标记gm；移除GM开关不等于其财产变成normal。
- 当前服务端Ark：source unknown、逻辑日11/12、双币null、补勤卡1、可领取0、下一奖励128秒。卡有值而钱包null符合两类字段的不同投影条件，不证明钱包映射失败，也不证明实际币余额0。
- 小程序显示「暂无」可能正确反映可信资源缺口；应查原档中的钱包存在性/键/数值/schema/来源及加载路径，不能先改normal标签或用余额差制造收益。

## 4. 哪些旧历史实际保留

| 层 | 实际落盘内容 | 可用范围与缺口 |
|---|---|---|
| Rust/Godot原档 | `user://p003_runtime_state.json`中的钱包、库存、逐日进度、route day_records、RewardLedger、礼物/宝箱/演出、非活动缸 `ecotank_route_archives` | 原RewardGrant含奖励实例ID、来源、目标逻辑日、resolved_rewards、config_revision、granted_at_ms；库存有quantity/status/tank/layer/acquired_at_ms。可审计残存事实，但不是完整收支账；来源通常是整档标记，缺逐笔normal证明；清档或早期迁移可有损失 |
| Telemetry | `p003_telemetry_v1.db`，queue/dead_letter/dead_batch/snapshot/meta；`usage_last_segment_v1`及冻结请求 | ACK/duplicate后删除queue正文；未冻结事件7天/10,000条保留上限；最后水位不是全部历史 |
| Ark状态 | SharedPreferences `p003_ark_state_v1.xml`，latest_semantic、pending_envelope、boot/sequence | 只留最新语义和待发快照，ACK删除pending；仅两币、补勤卡与当前进度，不传完整物品清单/历史收益；不能对快照做差算收入 |
| Godot Analytics交接 | `user://analytics/event_queue.ndjson`，最多2,000条 | 原ID交给Native后移除，不是全量游戏历史档 |
| Native Analytics | `p003_analytics_v1.db`，analytics_event_queue/dead_letter/meta | ACK后删除；未冻结事件14天/10,000条/8MB上限；按既有日批上传，不承诺实时；旧终态拒绝不能无审查重放 |
| mini009新增R1 | 原档business_journal＋`p003_ark_records_v1.db` | mini008无生产者。首次接入旧档生成baseline而非追溯流水；baseline只带当前wallet/inventory，`history_complete_before_baseline=false`。之后事务生成不可变业务记录，coverage/dropped显式暴露缺口 |

Godot业务观察器在首次加载时只记录runtime_state_restored/恢复状态，不把整个旧RewardLedger重放成新reward_granted。它比较运行中快照发出 `g1.reward_granted`、`g1.wallet_balance_changed`、`g1.inventory_changed`、`g1.makeup_card_balance_changed`和路线消耗等语义事件。

主代理本轮已核生产C旧Analytics有21条inventory_changed、11条reward_granted、5条补勤卡相关事件、3条progress_checkpoint，wallet_balance_changed为0，R1及legacy原始表均0。**已有事件可以保留并查询其原事实，不能把“有11条奖励事件”简化为“11次正常收入”**：奖励可含多物品、可能为库存状态改变，事件不含逐笔source_mode，且无正常存档/无GM的完整证明。零wallet变更事件也不证明从未赚过币，可能已有余额、未覆盖区间或事件缺口。

## 5. 最小兼容策略

1. 已在后台的对话与Analytics原事实保留原ID、发生时间、来源和授权范围，按现有隔离规则只读投影；必要时把旧事件标成「历史事件/来源未核实」，不要塞进可信normal收益或覆盖新R1原始表。单C历史授权不补造当时owner/epoch。
2. 设备使用时长只接受真实focus片段；旧历史缺测明确显示未知。优先交付已修4/0的后继包、保档升级并做两个60秒片段及尾段的同event_id闭环。开启R1无法修复旧版Telemetry门。
3. 当前币/物品先做C原档只读核验。若确有来源可追溯的正常记录，可提出独立、幂等且保留原事实的窄导入方案；在证据不足前保持unknown。不要用现有余额当历史收入，也不要为了变normal清掉旧档。
4. R1沿已冻结兼容通道，升级后从真实baseline继续采集；baseline不得记为获得收入，新记录分别按source_mode、存档、coverage/dropped核对。正常收益用正常事务正向钱包delta并标覆盖范围，物品获得与启用状态分开。
5. 本轮不需要恢复生产旧库、全量重写历史模型、删队列、换绑定、批量迁移旧scope或重构所有Analytics；最小差异是补可信读取与明确缺测，并完成端侧交付/安装/真实闭环。

## 6. root接续需要的C只读证据

先确认实际设备身份为C云身份末8位02000031，再定位活动包和数据目录。系统Launcher包预期 `com.futurus.p003.launcher`，但实际路径以当前 `pm path`及进程/包管理回读为准；Godot `user://`实际目录须现场解析，不照搬桌面Godot路径。

| 证据/文件 | 仅抽取的字段 |
|---|---|
| 活动APK、PCK描述符 | versionCode/name、APK SHA/签名、内容版本；和mini008精确回执对比 |
| `p003_runtime_state.json`及同目录 `.bak`、`.relaxed`、存在时`.tmp` | 文件SHA/mtime/大小、schema、formal.ark_source_mode、钱包键和值、库存物品/获得时间、RewardLedger数量/范围/实例ID、daily/route、ecotank_route_archives；读取原字节后离线解析，避免启动Runtime自动迁移 |
| `p003_telemetry_v1.db`及一致性WAL证据 | queue/dead_letter/dead_batch按type计数、focus片段原ID/起止、冻结批ID、usage_last_segment_v1；不重放、不删 |
| `p003_ark_state_v1.xml` | latest_semantic/pending中的来源、钱包、卡、logical_day、snapshot_id/sequence/captured_at；禁止混入凭据preferences |
| `user://analytics/event_queue.ndjson` | 各event_name数量/时段、奖励/物品/钱包语义字段、client_event_id、sequence；按原ID与服务器核对 |
| `p003_analytics_v1.db`及一致性WAL证据 | queue/dead-letter分事件与reason计数，业务事件的原ID/发生时间/属性；不导出儿童正文或凭据 |
| 若实际已经有mini009+：`p003_ark_records_v1.db`与business_journal | records/coverage/flight/retry状态、save_id、record_id、scope摘要、coverage/dropped、source_mode；未知旧scope先保留不重挂 |
| 有界诊断日志 | P003Telemetry/P003ArkState/P003Analytics/ArkRecords当前版本、入队、ACK、pending、退避；同窗workState/Hall1、摄像头权威在位、时钟/配对/OTA门 |

当前本地 `.local/state`与`Downloads`未找到文件名包含runtime_state的C导出；已查mini008/009回执并未取得C原档。不能据此宣称别处从未备份。

最新共享记忆与构建接续仍记C所连Windows/正式入口不可用。`skills/p003-launcher-canary/references/adb-debugging.md`只提供通用「解析现有ADB → devices -l → audit_second_p003_device.sh核MCU → pm path + 活动APK SHA」流程，没有当前C专属地址/USB映射。003/0010等旧USB示例不得当作C入口。本审计未执行任何ADB。

该参考明确系统包run-as可能失败，优先已有Bridge/status日志及安全Settings，不为检查私有文件擅自提权；可由已有授权的现场导出通道提供上述最小文件。SQLite须取得一致性只读备份或完整DB/WAL快照，不把运行中裸拷单DB作为完整事实。

## 7. 主要源码/证据入口

Android审计树：`/Users/fu-121/.codex/worktrees/p003-mini010-usage-fix-20261116`，HEAD d569775。

- `docs/miniapp-ble/P003_REAL_DATA_CLIENT_HANDOFF_20261110.md`
- `docs/miniapp-ble/P003_MINI371_008_PACKAGE_RECEIPT_20261110.md`
- `docs/miniapp-ble/P003_ARK_RECORDS_CLIENT_R1_20261116.md`
- `reports/mini010-usage-fix-20261116/HANDOFF.md`
- `reports/mini010-compat-scope-20261116/HANDOFF.md`
- `rust_runtime/src/g1_ark_state.rs`、`g1_ark_wallet_tests.rs`、`g1/model.rs`、`g1/route_state.rs`、`g1_business_records.rs`、`lib.rs`
- `godot/scripts/runtime_client.gd`、`g1_analytics_state_observer.gd`、`analytics_event_client.gd`、`ark_state_snapshot_client.gd`；`godot/main.gd:5651`通用Analytics context仅screen/phase/external_screen_connected，没有source_mode。
- Native `P003TelemetryCoordinator/Store`、`P003ArkStateStore`、`P003AnalyticsStore`、`ArkRecordsStore/Coordinator`。
- 共享记忆 `memory-items.md` 的P003-miniapp-usage-fix、mini009-compat-design、wait-real-device与2026-11-17 Dashboard条目；本轮实时生产事实以主代理 `LIVE-DATA.json` 为准。

署名：codex（OpenAI）| 2026-11-17（北京时间）
