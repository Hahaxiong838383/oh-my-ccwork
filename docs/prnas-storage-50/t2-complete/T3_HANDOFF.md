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
