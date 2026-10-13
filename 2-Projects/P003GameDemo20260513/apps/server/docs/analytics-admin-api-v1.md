# 产品事件后台只读 API v1

公开网关：`GET /api/admin/analytics/{overview,daily,batches,events,registry,health,collection-config}`。使用原运营台Bearer token，仅admin可读，editor/guest403，未登录401。仅GET，无原始JSON下载/写配置API；配置修改仍走现有 `/api/admin/device-config`。内部同名 `GET /internal/analytics/{kind}`，服务间 `X-Analytics-Internal-Token` 必需，只在127.0.0.1:3006，不应由nginx转发。网关timeout2000ms、最大响应512KiB、失败 `{ok:false,error:'analytics_unavailable'}`503；内部失败受控error_code，不能返回异常原文。

共同分页limit默认50，夹至1..100，offset默认0，夹至0..10000。overview/daily/batches/events支持from/to真实CST日期，区间最多90天；daily默认最近90天，其余默认14天；dimension=occurred(默认)/received，batches始终按received且回显dimension=received；device_alias可选，语法设备-12位小写hex，SQL绑定过滤。日期/维度/alias非法400 INVALID_QUERY。共同筛选响应回显from/to/device_alias，日与事件还回显dimension；以下新增字段也属于精确合同。下面所有字段精确来自实现；时戳毫秒，设备别名为`设备-<内部key前12位>`，不展示完整主体/SN。客户端筛选和标签请保持“上传端元数据”。

| 路由 | 查询参数 | 响应字段 |
|---|---|---|
| overview | 无 | `{ok:true,window_days:number,from:string,to:string,dimension:string,device_alias:string|null,batch_dimension:'received',devices:{device_alias:string}[],data_cutoff_ms:number|null,event_count:number,active_devices:number,last_received_at_ms:number|null,last_batch_received_at_ms:number|null,rollup:OverviewRollup,clock_suspicious_events:number,receiving_devices:number,batches:number,accepted:number,duplicated:number,rejected:number,client_pending_known:false,allowlist_count:number,receiving_allowlisted_devices:number,receiving_coverage:number|null}` |
| batches | request_id可选精确匹配，from/to/device_alias、limit/offset；dimension忽略于received语义 | `{ok:true,limit,offset,items:Batch[]}`，同request_id返回多个attempt |
| events | client_event_id必填，limit/offset | `{ok:true,id_digest:string,limit,offset,settlements:Settlement[],events:EventSummary[]}`；摘要跨主体对账，别名区分；不回显输入自由文本 |
| daily | dimension=occurred(默认)/received，from/to YYYY-MM-DD、device_alias可选，limit/offset | `{ok:true,dimension,limit,offset,items:Daily[]}`，日期倒序，仅已有汇总日；可疑发生日不建分区 |
| registry | 无 | `{ok:true,schema_version:1,event_count:57,items:{event_name:string,group:string,properties_schema:JSONSchema}[]}` |
| health | 无 | Health（下述），内部HTTP200包含ready布尔，不把alive当ready |
| collection-config | 无 | `{ok:true,server_gate:{enabled:boolean,valid:boolean},allowlist_count:number,global:{event_upload_enabled:boolean,daily_upload_hour_cst:number},device_defaults:{event_upload_enabled:false,daily_upload_hour_cst:23},items:{device_alias:string,active:boolean,event_upload_enabled:boolean,daily_upload_hour_cst:number}[]}`；global从只读config.db独立读当前全局有效值（空名单也真值）；device_defaults仅内置false/23；名单设备安全摘要，不返回SN或秘密 |

Batch：`{attempt_id:string,request_id:string,batch_id:string,received_at_ms:number,sent_at_ms:number,accepted:number,duplicated:number,rejected:number,http_status:200,processing_ms:number,device_alias:string,upload_client:{product?:string,component?:string,protocol_version?:string,content_version?:string},sent_received_skew_ms:number}`。摄入故障不会提前生成成功receipt；未入库的HTTP错误仅health计数，不冒充成功批次。

Settlement：`{attempt_id:string,outcome:'accepted'|'duplicated'|'rejected',reason:受控reason|null,request_id:string,received_at_ms:number,device_alias:string}`。

EventSummary：`{event_name:string,occurred_at_ms:number,received_at_ms:number,sequence:number,priority:'low'|'normal'|'critical',clock_suspicious:0|1,device_alias:string,session_digest:string}`；不返回raw properties/context/client_event_id/SN。

Daily：`{day:string,event_count:number,active_devices:number,sessions:number,event_counts:Record<event_name,number>,clock_suspicious_events:number,explicit_gm_events:number,unclassified_traffic_events:number,reward_grant_events:number,unique_reward_instances:number,groups:{activity:Record<string,number>,g1_flow:Record<string,number>,logical_day_ecotank:Record<string,number>,rewards_makeup:Record<string,number>,settings:Record<string,number>,voice_state:Record<string,number>,command_failures:{command:string,error_code:string,count:number}[]},data_cutoff_ms:number,updated_at_ms:number}`。奖励以g1.reward_granted与reward_instance摘要统计，不能以点击代替。会话只用app.session_started设备key+session摘要去重，不是孩子人数。groups是受控语义计数，无逐轮回复率/严格漏斗转化率。

Health：`{ok:true,alive:true,ready:boolean,dependencies_ready:boolean,storage_ready:boolean,gate_enabled:boolean,control_valid:boolean,allowlist_count:number,in_flight:number,requests:number,storage_failures:number,sql_busy:number,rss_bytes:number,wal_bytes:number,wal_max_bytes:number,wal_pressure:boolean,sqlite_version:string,sqlite_version_safe:true,sqlite_synchronous:2,sqlite_wal_autocheckpoint:0,checkpoint:Checkpoint|null,disk_free_bytes:number|null,disk_warning:boolean,processing_p95_ms:number|null,processing_p99_ms:number|null,last_rollup_success_ms:number|null,last_rollup_attempt_ms:number|null,last_rollup_partial_ms:number|null,rollup_status:'partial'|'complete'|null,rollup_failed_days:number,rollup_remaining_dirty_days:number,last_backup_success_ms:number|null}`。P95/P99仅最近1024次进程内处理耗时，进程重启清零，不能代替生产验收。rollup_success仅全部dirty完成才推进，partial成功的日取自己的updated_at_ms；失败日期数/剩余dirty为最后一次记账的状态，不能把旧成功水位冒称本次全成功。last_backup_success_ms读取analytics_meta，备份脚本无自动写回时为null，应由调度验收写入受控成功状态。`/health`仅`{ok:true,alive:true}`200；`/ready`返回Health，ready=false时503。关闭总闸依赖/存储正常仍ready=true。

数据截止=data_cutoff_ms/last_received_at_ms：所选维度与筛选下已完成日/设备日聚合的最大事件接收时刻；dirty期间可落后于新事件。last_batch_received_at_ms 独立来自所选接收日批次最大接收时刻，包括全拒收/重放批次，最近批次标签必须使用此字段。没有到达不等于不活跃。overview覆盖率分母是当前独立灰度名单，分子只计该名单内14天有成功批次到达的主体；pending必须端侧本地审计补充。overview与daily均读独立maintenance生成的日/设备日聚合，不同步扫描逐事件fact。

按device_alias查询daily时读analytics_device_day的完整七组摘要，全局读analytics_day；overview.devices是所选日期/维度可供筛选的别名清单（不受当前别名筛选再次缩窄），最多1000。批次/settlement计数与覆盖率始终按所选接收日窗口；clock_suspicious_events也按接收日单列。daily数据保留90天，receipt/raw只有14天，旧日期不存在批次不表示无历史聚合贡献。

Checkpoint：`{enabled:boolean,running:boolean,worker_pid:number|null,interval_ms:number,timeout_ms:number,stale_after_ms:number,last_attempt_ms:number|null,last_completed_ms:number|null,last_success_ms:number|null,last_result:{ok:true,sqlite_version:string,busy:number,log_frames:number,checkpointed_frames:number,duration_ms:number,reclaimed:boolean,reclaim_busy:boolean}|null,last_error:'ANALYTICS_CHECKPOINT_TIMEOUT'|'ANALYTICS_CHECKPOINT_FAILED'|null,failures:number,timeouts:number,stale:boolean,stalled:boolean}`。state仅supervisor内存，重启清零；last_success只有PASSIVE全帧完成且必要TRUNCATE不忙才更新，部分帧/长reader不冒称全成功。生产readiness检查enabled且success≤stale_after_ms（timeout_ms+3×interval_ms，生产60秒）；WAL硬闸独立于ready。checkpoint为null仅库函数无supervisor的隔离测试调用，生产entry始终启用。物理WAL高水位不表示未落盘；wal_pressure只表达新的收件应503/10背压，不能称已收事件丢失。


OverviewRollup：`{complete:boolean,dirty_days:number,clock_dirty_days:number,summary_days:number,clock_summary_days:number,updated_at_ms:number|null,data_cutoff_ms:number|null,clock_data_cutoff_ms:number|null}`。dirty_days 为所选维度/日期的待重建日期数，clock_dirty_days 为同窗口 received 维度日期数；任一非零 complete=false，设备筛选也保守使用整日 dirty。summary_days/clock_summary_days 是实际读取的不同日期数，不是窗口预期天数（没有事件的空日可没有汇总行）；updated_at_ms 是所选汇总最近完成时刻，不代表整个窗口的新事件全部覆盖。cutoff 是已聚合数据最大接收时刻，clock cutoff 与 selected cutoff分别报告。global事件/clock计数求和day摘要，alias求和device_day；active_devices跨日从device_day去重，候选设备同窗口去重且不受当前alias缩窄。成功批次计数与覆盖率继续独立读received batch。精确events查询由(client_event_id,received_at_ms)索引保护命中/缺失及occurred/received两维度，不返回原始正文。


overview所有摘要、dirty、batch/coverage读取使用同一个WAL读snapshot；并发rollup提交后新摘要/dirty在下一请求一起可见，旧摘要仍配该snapshot的dirty状态。读取不取得writer锁；异常释放reader，不改变ACK写事务。
