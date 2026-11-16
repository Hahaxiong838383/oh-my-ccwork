# T3接续合同与后续门禁

T2提供不可变包、offset读取、NAS完整性校验与确认；尚不实现Ark历史业务规则。T3继续同分支/工作树，在T2固定验收提交上开始，不复制旧运行源码覆盖线上。

## T3应实现

1. 在现有Ark库同事务更新ark_current和待归档表；同snapshot_id重放不新增。留档间隔300000ms，余额/星尘/M-CARD-001/领取状态/source_mode/content_version变化立即留档；时间戳、倒数、boot等噪声不单独刷历史。
2. outbox记录内部序号、当前owner/grant/epoch、snapshot_id、source_mode、捕获/接收时间、schema及正文hash。normal/gm/unknown隔离；换绑旧epoch不得供新owner读取。原latest-only端侧重试合同保持，只承诺服务端accepted且策略要求留档的版本。
3. 后台导出器从已提交outbox生成有界批次（按正文/行数）；持久保存batch→record映射，发布后将包ID写回。进程在任意提交点崩溃仍能重试同批，不用单时间戳高水位推断成功。
4. 复用Spool.publish或publish_prepared及kind=ark_checkpoint。扩展source_range格式为明确JSONL版本；NAS在现有SHA/字节之外补JSONL行数/schema核对。当前T2对Ark占位包只保证哈希/字节与声明计数一致，不冒称已校验Ark内容语义。
5. 导出/网络由独立任务执行；设备HTTP与语音查询只读本地最新状态，绝不等待NAS。达到缓冲预算时拒绝应留档的新快照并返回可重试503，旧最新行不变，不能accepted后丢历史。
6. 只有精确ID/SHA/bytes/record_count确认且映射覆盖完整，才清outbox及云端已确认正文。T2日周备份轮换不会删除Ark包；Ark90天历史留存和已确认包分页/GC在T3实现，避免无限list。

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
| 6 | src/storage/policy.ts、routes.ts | 当前policy强制archive_enabled=false、GET是not_implemented占位。T3补CAS开关及实际任务状态读取，保持默认false；改后台规划数不得触发设备false→true或自动授权 |
| 7 | 已确认清理 | 只清精确receipt对应outbox与本任务正文，保必要重放凭证；list分页/有界批次；NAS Ark历史90天保留独立于日周整库 |

先把以上做成单库单导出器，不新增消息队列、数据库服务或设备OTA。提交顺序建议：同事务与门禁→导出/确认清理→后台状态→隔离故障回归。固定候选交Grok复验后才进入T4。

## T3最短故障矩阵

- 事务提交前SIGKILL：无accepted、current/outbox都未变化；提交后ACK丢失重试：同版本一条。
- outbox→批次映射之前/之后、文件fsync之前/之后、NAS确认响应丢失各一次：已接受且应归档版本最终可逐条核对。
- 50个独立身份，每个余额/补勤卡不同；换绑、旧epoch、grant失效、GM/unknown不串读；归档恢复不复活grant。
- 缓冲差1字节/正好足够/超过、NAS离线、NAS预算满：未确认不删、503不能同时更新latest；恢复后重试成功。
- 归档关闭时旧行为与旧返回值相同；开启仅影响服务端历史留存；查询断NAS仍走原本地路径。

本表是T3待执行标准，不是本次测试结果；T4/T5继续使用成熟夹具，但云端吞吐/语音/容量结论须在目标硬件单独测。
