# 产品事件服务端合同 v1

固定 producer：daf7c17 / v321；57 个事件及属性依据 `src/analytics/event-property-schema-v1.json`。样例是源码/既有 smoke fixture 推导，不是本次真机捕获。5 个尚无发送实例的 semantic_interaction 透传属性保留 `proposed_admission_type_unobserved` 标记，不能称类型全部经实际运行确认。

服务只绑定 127.0.0.1:3006，入口 `src/analytics/index.ts` 不导入业务写库单例、语音、人格或主服务入口。埋点专用Node24.19.0 / SQLite3.53.3，无新增依赖；原公司语音/个人站Node不变。共享analytics writer启动时拒绝未修复WAL-reset版本（门槛3.51.3，另允许官方backport3.50.7/3.44.6及同支后续版本），不能用旧系统Node22.22.2的SQLite3.51.2运行。

## 上传与结算

`POST /v1/device/analytics/events:batch` 使用既有 HS256 Device Bearer，kind=p003-device，稳定 sub 经撤销水位验证。不能从正文设置主体。JWT 无效401；只读依赖失败503，不能伪装为401。台账存在时 active准入/disabled拒绝；没有记录时回落 DEVICE_SN_ALLOW，但库不可用不作env回落。JWT core 在 `device-credential.ts`，原 device-session 导出/旧撤销失败兜底保持兼容。

外层仅 schema_version=1/batch_id/sent_at_ms/client/events，事件1..200。client仅 product/component/protocol_version/content_version，可缺省成员，成员为最多256字符的符号字符串；现 producer protocol_version=`1.0`，不是数字。未知外层/身份/敏感client键400。事件ID不能识别则整批400；事件内容不合法则该ID200终态拒绝。优先级仅low/normal/critical，事件含原 occurred_at_ms 与独立 received_at_ms。context仅 screen/phase/external_screen_connected。

冻结额度：事件UTF-8 JSON≤8192字节，HTTP正文≤2097152字节；超过正文JSON413。任意递归校验/规范化前迭代检查单事件结构：根深度0，最大深度8、最多4096节点；深度超限终态invalid_event，节点超限终态event_too_large。可识别ID的坏结构不阻断同批正常事件；同ID深结构比较迭代执行，仍保留唯一结算及冲突规则。nginx硬顶3MiB由部署文件提供。每主体60rpm；进程全局默认600rpm，可配1..60000；处理并发2。429/503使用数字秒Retry-After；内存RSS超过512MiB停止新接收；磁盘可用<8GiB警告、<4GiB停止接收503/60。

X-Request-Id必需，长度1..96，技术符号语法 `[A-Za-z0-9_.:-]+`，合法输入原样回显；禁止trim/截断。batch_id/client_event_id/session_id沿用技术标识语法与96/128/64上限。完整SN、JWT形状、手机号、控制字符拒绝。该符号收窄用于杜绝自由文本，覆盖固定producer现有ID形状。客户端时钟偏差不拒收。

所有成功回执 `{ok:true,request_id,accepted_event_ids:string[],duplicated_event_ids:string[],rejected:{client_event_id,reason}[],retry_after_ms:0}`。每个输入去重ID精确一次且仅在三类之一。同批同ID同内容合并一次；内容冲突整个ID拒绝。库内已见同规范化事件摘要duplicated，不同摘要client_event_id_conflict；hash不含request_id/batch_id/client/sent_at/received_at，属性键序规范化。accepted只有整批事务COMMIT成功后返回。失败事务503/30。

受控拒绝码：event_not_allowed、event_too_large、invalid_event、invalid_context、invalid_properties、client_event_id_conflict。properties额外键、嵌套敏感键/坏类型不保存；仅保存ID的SHA256摘要、受控原因和计数。端侧超限退化properties=`{truncated:true}`作为明确分支保留，避免误拒现役合法输出。

## 开关与只读隔离

完整配置快照仍有 schema_version/revision/posture，新添 analytics.event_upload_enabled=false、analytics.daily_upload_hour_cst=23（0..23整数，单位小时）。SN覆盖>global>内置，tombstone/revision保持旧规则。

ANALYTICS_CONTROL_PATH指向绝对路径普通文件，内容精确 `{"enabled":false}` 或true；只许enabled键、boolean，≤4096字节、权限0600、非symlink。每请求热读并在事务前再次读。不存在即安全关闭且健康；格式/权限错误关闭且readiness不通过。总闸关闭/设备配置false均503、error_code=ANALYTICS_UPLOAD_DISABLED、Retry-After=900。独立allowlist空则全拒，非灰度403。后台只返回名单数量和短别名，不能输出SN/secret。

台账/config数据库每次读取用 DatabaseSync readOnly:true重开，读取实时WAL，不用immutable、不留旧文件句柄。analytics库独立WAL+FULL+busy_timeout250ms，所有共享库writer及checkpointer关闭wal_autocheckpoint；版本门在journal变更/DDL/DML前执行。备份Python只读共享源库、只写独占隔离目标；成功水位writer同样过版本门及FULL/auto0。HMAC device_key 使用独立稳定密钥和固定命名空间p003-analytics-v1，续签不改变设备key。服务间认证使用另一密钥。

## 保留与聚合

analytics_event、analytics_batch及其受控settlement记录按received_at保留14天。analytics_event_seen保留整个内测期，不由自动TTL清理。request_id建索引不唯一，每次成功接收有独立attempt_id。拒收原始正文不存库、不进异常日志。

analytics_day/analytics_device_day和最小 analytics_rollup_fact保留90天。fact仅含日维度、device_key、事件ID/session摘要、事件名、接收时间和有限业务符号（command/error_code/logical_day/tank_id/stage_id/state/kind/source_kind/status/gm_override/used_makeup_card/interactive，奖励instance仅摘要），不保留context/properties原文。该事实表保证raw14天过期后第20天迟到重建旧分析日仍保留先前贡献。dirty日每次从fact重算/upsert，不做累加重放。

发生日与接收日并列（CST）；发生时间早于接收31天或晚于接收2天标可疑，不创建发生日分区，仅入接收日指标。不修正时钟，不把没上传当没活跃，不推断pending=0。不计孩子人数、不声称精确发生版本或逐轮语音回复率。设备别名是稳定内部key前12位。流量仅gm_override=true明确标GM，其余unclassified，不推断真实用户。

七组提供语义事件计数、活跃设备/会话、Runtime奖励事件与奖励instance去重、失败command/error_code排行。G1流程统计是事件计数，不能称严格序列转化率；没有有序漏斗推断。上传元数据来自batch当前client，不能当发生版本。

独立 `npm run analytics:rollup`，建议每5分钟调度：最多16个dirty日、每日事务最多100万fact/30秒计算预算，每次TTL每张目标表≤1000行；不VACUUM、不在ingest进程启动重算。逐日事务隔离，超预算保留dirty并继续其他候选日；analytics_rollup_retry仅存维度/日期/末次失败时间，失败日排到未尝试日后且同样保留90天，防止有限名额饥饿。raw14天/receipt14天/fact与summary90天TTL先独立尝试并提交一次有界chunk，再执行耗时rollup；不在finally重复清理。聚合或水位写入失败、聚合期间外部timeout/kill不能跳过此前已提交的TTL；TTL本身失败仍继续尝试rollup，但最终exit1，不冒称维护成功。外部kill发生在TTL提交前仍可能中断该次清理，保留周期由后续调度继续推进。

CLI JSON为 `{ok:boolean,partial:boolean,rebuilt_days:number,rollup?:{attempted_days,rebuilt_days,failed_days:{dimension,day,reason:'budget_exceeded'|'storage_unavailable'}[],remaining_dirty_days,partial},pruned?:{events,batches},rollup_error?:string,prune_error?:string}`。部分失败或尚余dirty：exit0、ok=false、partial=true；全量完成：exit0、ok=true、partial=false；存储/元数据/TTL致命错误：exit1、受控error字段，不能冒称成功。wrapper保留相同ok/partial语义。每次记last_rollup_attempt_ms；partial只推进last_rollup_partial_ms，全部dirty完成才推进last_rollup_success_ms。每日及设备每日摘要updated_at_ms取该日真实完成时刻。

维护共用文件锁：rollup碰锁exit0且JSON明确skipped=true/reason=maintenance_lock_busy；backup最多等待20秒，超时exit1且ok=false/skipped=true/reason=maintenance_lock_timeout。backup oneshot总预算120秒（等锁≤20秒+Python备份≤90秒），失败60秒后重试，600秒内最多5次启动；避免00:30与较长rollup争锁后整日假成功漏备份。仍需Linux真实flock与systemd运行验收，超预算聚合容量需后续分片，不能声称无限容量。

## 独立 checkpoint 与 WAL 背压

ingest启动独立child立即执行一次，之后每10秒执行一次PASSIVE checkpoint。同一supervisor单flight、不排队重叠；SQLite的WAL checkpoint互斥锁处理其他连接竞争，busy/部分帧不冒称完成。parent强制5秒deadline，超时SIGKILL并记录受控失败，下一周期再试；输出最多4096字节，无凭据/正文。checkpoint子进程与请求线程独立；FULL每次事务提交仍fsync，ACK仍在COMMIT后返回。SIGTERM/SIGINT关闭HTTP、停止timer并杀/回收child，再关闭store；关采集总闸时checkpoint继续推进已有WAL。

物理WAL达到默认256MiB后，新的收件在读正文前及事务前复核，HTTP503/ANALYTICS_WAL_PRESSURE，Retry-After=10（数字秒）；未accepted不得排空端侧pending。门槛是新事务准入硬闸，可越过至多一个同步有界200事件事务的增量，不是手工截断日志的物理文件绝对上限。后台有限维护写仍可推进保留；checkpoint停摆/长reader时不继续新增事件。file stat错误同样失败关闭。

物理WAL高水位不等于尚未持久化数据。普通PASSIVE不缩文件；仅物理文件达到门槛且本次PASSIVE busy=0/log=checkpointed，child以busy_timeout=0尝试SQLite TRUNCATE恢复物理空间。并发writer/reader使TRUNCATE忙则不等待，不删除WAL，继续背压直到下一周期成功；5秒parent deadline仍适用。SQLite3.51.3+/已修backport版本门先通过，避免旧版本并行writer/checkpointer WAL-reset缺陷。不能手工删WAL或降FULL/NORMAL来消除延迟。

health可读版本/FULL/auto0、物理WAL及门槛、checkpoint是否running/超时/失败/长reader部分进度/末次全帧完成。生产readiness要求checkpoint启用且末次全帧完成距今≤30秒；启动第一轮完成前或长期停摆为not ready。WAL在门槛下仍可接收，达到门槛则独立背压。库/seen不因回滚或checkpoint清理。

## 环境变量

全部路径绝对：ANALYTICS_DB_PATH、ANALYTICS_DEVICES_DB_PATH、ANALYTICS_CONFIG_DB_PATH、ANALYTICS_CONTROL_PATH。

必需秘密：AUTH_JWT_SECRET（既有JWT）、ANALYTICS_DEVICE_KEY_SECRET（独立、稳定、至少32随机字节建议）、ANALYTICS_INTERNAL_SECRET（另一独立秘密，3001网关同值）。生产不得把两新秘密设相同。

名单：ANALYTICS_SN_ALLOW（逗号SN，独立灰度，默认空，最多1000），DEVICE_SN_ALLOW（台账无记录env准入，默认空）。ANALYTICS_GLOBAL_RPM默认600。3001网关可配ANALYTICS_INTERNAL_URL，默认http://127.0.0.1:3006且只允许127.0.0.1 HTTP。

维护预算：ANALYTICS_ROLLUP_MAX_FACTS_PER_DAY默认1000000、整数1..1000000；ANALYTICS_ROLLUP_MAX_DAY_MS内置默认30000、整数1..30000，生产env helper下发8000；仅可收窄预算，非法值为受控rollup失败且仍先尝试TTL。

运行时：ANALYTICS_NODE_PATH绝对可执行路径，PM2生态及maintenance.sh从受控.env.analytics的JSON引号路径读取，显式进程env可覆盖；默认 `/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node`。standalone wrapper/tests使用当前process.execPath，rollup子命令和checkpoint可显式选ANALYTICS_NODE_PATH；任何共享writer都先验证实际SQLite版本。ANALYTICS_WAL_MAX_BYTES默认268435456，整数65536..268435456，只可收窄准入阈值，不能扩大256MiB；child使用同一阈值。生产checkpoint周期10秒/超时5秒冻结，不依赖5分钟rollup刷新WAL。

PM2 `deploy/analytics.ecosystem.cjs` 读 ANALYTICS_ENV_FILE（默认/opt/p003/server/.env.analytics，绝对），实例1，512M保护。脚本不读取真实env作为开发输入。部署/真实代理/真机/语音对照/备份异机验收由主控处理，本任务本地验证不能代替生产验收。
