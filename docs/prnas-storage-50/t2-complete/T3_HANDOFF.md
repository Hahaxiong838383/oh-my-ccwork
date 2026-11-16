# T3接续合同与后续门禁

T2提供不可变包、offset读取、NAS完整性校验与确认；尚不实现Ark历史业务规则。T3继续同分支/工作树，在T2固定验收提交上开始，不复制旧运行源码覆盖线上。

## T3应实现

1. 在现有Ark库同事务更新ark_current和按策略需要的待归档记录；沿用现有duplicate分支，不新增outbox；不能添加全局snapshot_id唯一约束，避免改变新boot下同ID的现有接受规则。300000ms间隔及关键变化的唯一谓词见下方定稿，噪声不刷新该间隔起点。
2. outbox记录内部序号、当前owner/grant/epoch、snapshot_id、source_mode、捕获/接收时间、schema及正文hash。normal/gm/unknown隔离；换绑旧epoch不得供新owner读取。原latest-only端侧重试合同保持，只承诺服务端accepted且策略要求留档的版本。
3. 后台导出器从已提交outbox生成有界批次（最多1000行或1MiB封套字节，先达到者）；持久保存batch→record映射和不可变manifest后才发布，发布状态另外写回。进程在任意提交点崩溃仍能重试同批，不用单时间戳高水位推断成功。
4. 仅复用Spool.publish_prepared及kind=ark_checkpoint，调用前持久保存不可变manifest；不可用每次生成新ID的Spool.publish作为可重试批次。扩展source_range格式为明确JSONL版本；NAS在现有SHA/字节之外补JSONL行数/schema核对。当前T2对Ark占位包只保证哈希/字节与声明计数一致，不冒称已校验Ark内容语义。
5. 导出/网络由独立任务执行；设备HTTP与语音查询只读本地最新状态，绝不等待NAS。达到缓冲预算时拒绝应留档的新快照并返回可重试503，旧最新行不变，不能accepted后丢历史。
6. 只有精确ID/SHA/bytes/record_count确认且映射覆盖完整，才清outbox及云端已确认正文，保留轻量留档基线。T2日周备份轮换不会删除Ark包；Ark90天历史留存和已确认包有界GC在T3实现，清单规模须实测，必要时再最小扩展兼容分页。

## T2接口

- Manifest v1：schema_version、内部32位hex archive_id、kind、created_at_ms、record_count、bytes、sha256、source_range；≤8192字节，不接受任意路径。
- SSH：list；meta ID；read ID OFFSET；ack ID SHA BYTES COUNT。ACK重复幂等，不能确认未知包。
- 发布：完整包fsync→同卷rename→目录fsync；NAS完整校验后原子落地→ACK。
- 备份状态：backup-status.json的state/pending_bytes/oldest_pending_ms/last_offsite_backup_ms/offsite_age_ms；NAS的cycle-status.json与retention-status.json。unknown保持null，连接成功不等于业务设备已归档。

## T3验收

同ID/乱序、5分钟边界、关键变化、GM/owner/epoch隔离；提交前/后、发布前/后终止进程；未确认不清理、满缓冲503；服务器accepted版本全部可核对。用合成50身份进行隔离，真实设备范围不自动扩大。

T4再做90天/180天滚动容量、实际副本与公式同步、维护净吞吐；T5再做50台集中日批、Ark/备份/维护混合和≥50轮语音对照；T6才统一部署并逐步开设备。T2大库备份通过不能冒称50台接收或语音压测通过。完整游戏存档恢复仍需端侧导出/导入合同，快照不能替代。

## 已核对的源码入口与开发顺序

| 顺序 | 现有入口 | T3最小改动与放行用例 |
|---|---|---|
| 1 | src/ark/store.ts → accept()已BEGIN IMMEDIATE | 在同连接/事务增加outbox；先测299999/300000ms、首次快照、关键变化、倒数不刷、duplicate不增；当前grant/clock/stale/conflict规则不改 |
| 2 | src/ark/contracts.ts → snapshotSchema v1 | 直接使用wallets.family_coin、wallets.stardust、inventory[M-CARD-001]、progress.next_reward的status/kind/item_id/stage_id、claimable_count、config_revision/content_version/source_mode；remaining_seconds和捕获时刻不作为独立触发。logical_day切换应留档；null与0不同 |
| 3 | src/ark/routes.ts → /state | 缓冲准入在事务内，满额回滚current+outbox、503+有界重试提示；现有16KiB、12/min、403/409语义保持；read/preview不访问NAS |
| 4 | 新独立导出器 | 每包有界JSONL、确定批次映射、持久包ID、幂等发布；导出器进程重启不重新制造新包；并发设备写入不能被遗漏 |
| 5 | scripts/storage-nas-verify.mjs | kind=ark_checkpoint的版本/逐行schema/行数核对；错误不ACK；未来restore只供核对，不恢复旧owner授权 |
| 6 | src/storage/policy.ts、routes.ts | 当前policy强制archive_enabled=false、GET是not_implemented占位。T3补CAS开关及实际任务状态读取，保持默认false；归档布尔使用独立CAS入口，原规划数PUT合同保持；改后台规划数不得触发设备false→true或自动授权 |
| 7 | 已确认清理 | 只清精确receipt对应outbox与本任务正文，保必要重放凭证；list分页/有界批次；NAS Ark历史90天保留独立于日周整库 |

先把以上做成单库单导出器，不新增消息队列、数据库服务或设备OTA。提交顺序建议：同事务与门禁→导出/确认清理→后台状态→隔离故障回归。固定候选交Grok复验后才进入T4。

## T3最短故障矩阵

- 事务提交前SIGKILL：无accepted、current/outbox都未变化；提交后ACK丢失重试：同版本一条。
- outbox→批次映射之前/之后、文件fsync之前/之后、NAS确认响应丢失各一次：已接受且应归档版本最终可逐条核对。
- 50个独立身份，每个余额/补勤卡不同；换绑、旧epoch、grant失效、GM/unknown不串读；归档恢复不复活grant。
- 缓冲差1字节/正好足够/超过、NAS离线、NAS预算满：未确认不删、503不能同时更新latest；恢复后重试成功。
- 归档关闭时旧行为与旧返回值相同；开启仅影响服务端历史留存；查询断NAS仍走原本地路径。

本表是T3待执行标准，不是本次测试结果；T4/T5继续使用成熟夹具，但云端吞吐/语音/容量结论须在目标硬件单独测。

## Grok计划复核后的实施定稿

Grok 4.7在2183eb0c源码上给出T3_READY_AS_PLAN，以下收敛为唯一实施口径；本节仍是待实现设计，不代表T3通过。

- **事务与旧合同**：归档配置在进入Ark事务前读取，不在Ark持锁时反向获取配置事务。先走现有grant/clock/stale/conflict/duplicate判定，只有非duplicate且应留档的accepted分支，才同事务更新current与outbox。outbox使用内部递增序号，不以snapshot_id全局唯一；原设备返回码/正文不变。
- **留档谓词**：基线是同一grant上次已提交检查点的服务器received_at_ms和语义字段签名；首次、间隔达到300000ms，或下述严格变化时留档。字段仅为family_coin、stardust、M-CARD-001、next_reward的status/kind/item_id/stage_id、claimable_count、source_mode、content_version、config_revision、logical_day；null与0不同。timer_state、倒数、boot、sequence、采集时间不单独触发。不能用每次变化的current接收时间重置窗口。ACK清理正文后仍保留这份轻量基线，否则会退化成每条都归档；不要求永久保留完整历史正文。
- **缓冲与503**：只对本次需要新增留档且本地预算不足的请求回滚current+outbox，返回503 archive_buffer_full及Retry-After:60；等额预算接受，duplicate和不需留档的正常更新不误拒绝。授权名额的STORAGE_CAPACITY_LIMIT保持409。预算必须计入待确认正文、待发文件及生成中副本，不能仅统计已分配batch之外的行；本地实际磁盘预留也要守住。设备HTTP不读取NAS空间或网络状态，NAS故障由异步任务重试，最终通过本地预算背压。
- **归属与包格式**：插入时固定sn/account_id/epoch/grant_id/source_mode及接收时间，换绑不级联删除待确认记录。JSONL每行必须是版本化封套，包含内部序号、上述身份、body_hash和完整snapshot；不能只写裸snapshot丢失归属。body_hash覆盖canonicalJson(snapshot)的UTF-8字节；manifest.sha256覆盖封套JSONL的实际文件字节。NAS核封套、snapshot v1、逐行hash和行数，normal/gm/unknown保持原枚举语义，不新增GM鉴权或设备历史API。
- **有界批次**：先在短事务领取最多1000行或1MiB序列化封套（先达到者）并保存batch映射；库锁外写ark-work文件并fsync，然后持久化完整manifest，重复调用publish_prepared始终用同一archive_id。空批不发布；单行超上限须明确处理，不能无限停在首行。ACK丢失重试不换新包；只有四元组及完整映射核同后才删对应正文，清理幂等。
- **保留与旧包**：新包source_range为format=ark_jsonl、format_version=1、lines=N；旧无format的T2测试占位包只维持原哈希/字节合同，不冒充已验证JSONL。Ark不走SQLite恢复、日周备份轮换或授权恢复。只清已确认且超过90天的Ark历史；清单及元数据也要有界，优先源端已确认正文及时GC、数据库LIMIT和现有20包队列。若真实积压证明list响应仍会无限增长，再最小扩展分页并保留旧命令兼容，不预建新的索引服务。
- **开关**：默认false，原target_devices PUT仍只改规划数；归档布尔单独使用同revision CAS，不改verified profile、设备名单和授权。关闭后不新增历史，但已经accepted的待归档记录继续补送和确认清理；不能因为关闭把旧积压永久搁置或删除。后台明确关闭/积压状态，原字段和设备接口保持兼容，不把已实现但关闭的功能永久显示成not_implemented。

补充故障用例：清理上次outbox正文后下一条噪声不额外留档；关闭后仍能排完旧积压；新boot重用snapshot_id保持旧accept合同；封套错owner/hash/计数拒绝确认；设备请求期间NAS断网无需增加网络等待。T4再校准容量系数，T5再验50台混合负载；这些规划不挤入T2。
