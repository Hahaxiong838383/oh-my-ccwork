# CONTRACT-45 — v375 精确客户端合同核验

结论：精确源码合同已取证，服务端尚未验收。48可据此实现；下述部署限制必须保留。不是仅凭附件同名事件放行。

## 证据锚
- 客户端源码：52b89ec9a4823eb62b424f094d613b4a09a10708。
- 交付提交：4f7cc36668be6f9c676825d3be929f72447e9c0b（docs(analytics): record v375 device validation）。
- 在独立私有裸仓 client-source.git 从原仓 Git 读取，未修改端侧工作树；原始文件及逐文件SHA256在协调目录 client-v375/SOURCE.json。
- 核读：docs/P003_G2_ANALYTICS_TIERING_SERVER_HANDOFF_20261102.md、docs/api/analytics-event-ingest.openapi.yaml、godot/scripts/analytics_event_policy.gd（下称Policy）、analytics_event_client.gd（下称Client）、Launcher P003Analytics{Client,Contracts,Coordinator,Store}.kt 和 DeviceRuntimeConfigPublisher.kt。
- OpenAPI仅描述通用事件信封，未定义新properties的详细schema；下面properties以精确生成代码为准，不能把宽泛 additionalProperties:true 当隐私放行依据。

## 1. 开关真值与配置传递
Policy:97-113：tiering_enabled && aggregate_upload_enabled 才启用分层。00/01/10 均全部raw，11才按事件分层。Client:319-332同样要求双真且周期闭合才交接聚合。**只开tiering不开aggregate_upload不会产新桶**；附件/完整handoff建议的“先单开捕获看桶”不能作为实际验证步骤。
- capture开启本身不让00/01/10产生样本。11时聚合事件可同时留代表样本；app.bridge_ready/g1.route_state_loaded 只有capture=true时转样本，否则仍raw。
- handled=false/缺失的g1.semantic_interaction及ok=false/缺失的g1.runtime_command_completed始终raw；其他未列聚合事件均raw。
- 旧样本的交接只检查 on_demand_upload_enabled && 非空request_id（Client:363），**不再次检查capture或双开关**。已进Launcher队列的数据更不会被双开关撤回；关闭双开关只影响后续产生/聚合交接。
- Launcher Coordinator:156起读取event_upload_enabled、daily_upload_hour_cst、request_gzip_enabled；字段缺失会保留本进程前值。发布配置须显式false撤回，不能靠删字段。
- DeviceRuntimeConfigPublisher 验schema=1、revision非空<=64、载荷<=64KiB；cache/publish将完整payload发送device.runtime_config_changed；本轮只核源码，未证明运行中PCK v180已包含该Godot分层实现。真机阶段需看实际配置接收/本地桶，不能仅APK版本推定。
- defaults：双开关false、capture/upload false、request_id空、gzipfalse。周期7（clamp7..31）；聚合保留90（14..180）、桶2048（128..4096）；样本保留3（1..14）、1000（100..2000）、2MiB（256KiB..4MiB）。request_id trim后截96。

## 2. analytics.periodic_aggregate 精确信封
Client:242-286,336-360；Policy:40-51,118-165。
- schema_version=1；client_event_id=g2agg- + bucket_key前32hex。
- bucket_key=SHA256(source_event_name + '|' + period_start_ms十进制 + 各按键排序的'|key='+Godot JSON.stringify(value))。不要用普通JSON.stringify(dimensions)替代该算法。ID未包含period_days，灰度期间固定周期，别中途切周期混桶。
- period_index=floor((timestamp_ms+28800000)/(period_days*86400000))；start=index*duration-28800000；end=start+duration。Unix epoch锚定CST整日，**不是周一自然周或首次开关时起算**。
- occurred_at_ms=end-1；session_id=aggregate- + bucket_key前16hex；sequence=桶首次事件sequence；priority=normal。
- context={analytics_tier:'periodic_aggregate',component:client_context.component或'godot_g1_demo'}。
- properties全部字段：source_event_name(string),period_start_ms(int),period_end_ms(int),period_days(int7..31),first_occurred_at_ms(int),last_occurred_at_ms(int),count(int次数),dimensions(object),measurements(object)。**没有bucket_key属性、没有schema_version属性、没有余额字段。**
- 每记录一次count+1；first保持首次插入时间，last=max；不是增量快照：闭合桶提交最终计数，重传同ID不再累加。
- 非checkpoint measurements={}；checkpoint仅4项max_elapsed_seconds/max_checkpoint_minutes/max_completed_slots/max_current_slot；merge取maxf，JSON可有1.0这类整数值浮点表示；不是求和或奖励进度权威。

固定维度白名单（字段可缺省，不能要求全部出现；类型与源事件保持兼容，且未知字段拒绝）：
|source_event_name|dimensions|
|---|---|
|app.lifecycle_changed|state|
|g1.screen_viewed|screen,source,previous|
|g1.semantic_interaction|intent,handled,phase,source,stage_id,tank_id,day_index,reward_kind,page,direction|
|g1.runtime_command_completed|command,ok,status,changed|
|g1.progress_checkpoint|logical_day|
|settings.opened|source,auto_preview|
|settings.closed|空|
|settings.page_viewed|page|
|settings.value_changed|setting,value,value_bucket,result,external_screen_connected|
|network.connectivity_changed|offline,source|
|network.provisioning_state_changed|state|
|voice.session_state_changed|state,interactive|

只有以上12类可聚合。奖励/钱包/库存/逻辑日/恢复/失败不能伪装source_event_name进入聚合。服务端须校period边界、时间次序、count正安全整数、结构与维度隐私，不能把原始自由文本放进新nested对象。现有原始字段类型/事件合法值不要凭猜测扩大。

## 3. analytics.on_demand_sample 精确信封
Client:289-317,363-390。
- sample_key=SHA256(CST日整数+'|'+源事件名+'|'+JSON.stringify(dimensions)+'|'+capture_source)。一天/事件/维度/来源最多1条。
- client_event_id=g2diag- + sample_key前32hex；**不包含request ID**。同一样本跨请求仍同ID，不应按request重新计数/结算。
- occurred_at_ms=captured_at_ms；session_id=diagnostic- + SHA256(request_id)前12hex；sequence=原事件sequence；priority=normal。
- context={analytics_tier:'on_demand_diagnostic',request_id:string}。**request_id在context，不在properties或HTTP RID！**
- properties全部字段：source_event_name(string),source_occurred_at_ms(int),source_context(object),source_properties(object),capture_source('aggregate_sample'|'on_demand')。
- aggregate_sample只能对应12个聚合候选；on_demand只能app.bridge_ready/g1.route_state_loaded。嵌套源字段需按源事件合同验证/脱敏，不允许任意JSON穿透；尤其深度限制会将过深值变为[depth_limited]，非法应明确逐条拒收。
- Godot源样本保留默认3天；**进入Launcher后是普通队列，不再按3天过滤**。request_id在Godot交接时盖入信封，之后持久化不随新配置改写。
- 服务端须自己创建request绑定可信完整SN或其HMAC键、允许源事件、创建时间/到期/撤销/max_events，校当前有效性及捕获时效；非空ID不等于授权。请求允许回溯3天样本，应将lookback与request起止分开，不能要求所有source_occurred>=request创建（否则无法按需取历史）。
- 超期/撤销/越权/超限的新样本按事件terminal rejected，混批raw仍可accepted；使用200完整精确ACK。已接受的重复只能回duplicated且不再次占额度；已过期/撤销时重放已接受ID的策略须明确且不泄露异设备存在性。

## 4. ACK与HTTP错误的实际删队列行为
- Godot→Launcher bridge：ok且accepted_event_ids或rejected列表非空才结算；Godot这里不识别duplicated列表。Launcher durable enqueue已有ID也回accepted（Store:98），因此兼容。
- Launcher→服务器：Contracts:42-78/Store:148-173。200..299需ok=true且至少一项ID；accepted+duplicated从本batch删除；rejected按ID进deadletter；未列ID仍留同batch重试。parse不核request_id回显，也不检查三集合互斥，**服务端必须独立保证回显/覆盖/互斥，不依赖客户端兜底**。
- 401恢复凭据且保留队列；403与503/ANALYTICS_UPLOAD_DISABLED停用/延后保留；429/503/5xx重试；JSON413拆批；**HTML413整批deadletter**；400及其他4xx整批deadletter。不能用批级400表达单样本授权失败，误伤混批raw。
- 请求连接3s/读8s；每批<=200、每次最多30批、批间2s；15s指数退避（failures最多8，实际本地最高1920s，声明max1h）；服务端Retry-After可更长；5min调度/继续，40130min，禁用至少15min。
- 单事件8KiB；Godot交接50条/128KiB。Launcher统一JSON再可选GZIPOutputStream（UTF8），不按事件压缩、无额外gzip字节上限。服务端建议wire和inflated各2MiB、有界异步、并发2，必须返回JSON413，截断/CRC/多重编码/膨胀需测试。

## 5. TTL与去重：不能宣称客户端14天是绝对重试上限
- Godot raw仅2000数量界，无按年龄TTL；聚合默认90天从period_end计龄，可延迟交接；样本默认3天从captured_at计龄。
- Launcher按created_at_ms（入队时刻）14天，10k/8,000,000字节；但Store:283-299 **只删除batch_id IS NULL**。已inflight的批次不受TTL/容量驱逐，loadBatch优先恢复它。也没有累计重试天数上限。
- 因此“保留14天去重即可覆盖客户端窗口”不成立。建议本轮内测 **默认不清理幂等墓碑**，与payload分层TTL分离；或在合同明确最大接收年龄并证明过老重放不重新accepted后另行收敛。不能为省容量把旧raw payload删除连带去重一起删。
- 样本payload TTL可短于墓碑，但额度消耗/已接受ID不得随payload过期重置；新请求不能把旧ID再accepted。
- TTL任务先只读dry-run，禁止本轮擅自线上大删。未有数据不能填0。

## 6. 方舟消费审查要求
- 只以48固定候选为测试对象。raw关键事件仍入原事实源；聚合count/checkpoint-max及样本不能贡献余额、收益、奖励次数，也不能挤占raw扫描上限导致原已知资产变unknown。
- 核full identity+epoch授权水位、GM逻辑日排除、快照时效/双时钟、unknown不变0、动态回答不进长期记忆、普通闲聊不查埋点。
- 本树旧Ark readArkHistory会扫描analytics_event全部事件再限513；若48把聚合/样本放同事实表，需检查是否污染bounded history预算。独立测试要插入>512条非raw旁证确认。
- 普通问答与HTTP健康并发有界解压只能给本机隔离证据，不能冒充HK真机语音或生产P95。

## 状态与后续
合同核读完成；客户端运行Godot烟测、真实v375/PCK能力、48固定候选HTTP/TTL/重启/越权尚未验。准备独立矩阵与工具，候选到达后固定SHA运行。主13唯一部署/开关，不改任何现役范围。

署名：codex（OpenAI）| 2026-11-02
