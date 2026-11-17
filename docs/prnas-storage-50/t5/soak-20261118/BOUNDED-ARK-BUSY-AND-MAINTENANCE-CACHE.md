# T5继续修复：限次忙锁重试和后台缓存预算

5be3完整混合未过：30万条Analytics ACK完整，ACK P95/P99 155.46/223.76ms；Ark第301次503并实录SQLITE_BUSY，历史150查18失败；工作集峰86.42%，OOM0。归档缩短事务不足以消除实际调度/磁盘提交的锁占用，不能把源码审查PASS当性能通过。

新候选：
- 仅SQLITE_BUSY低8位5且Node ERR_SQLITE_ERROR重试；最多3次尝试，10/20ms异步等待，共用80ms重试准入预算，每次预留原15ms SQLite忙等。事件循环迟延会消耗预算，不能重新开窗。这是重试准入界限，不能保证阻塞I/O的硬墙钟80ms。
- 正常请求只调用一次；非BUSY不重试。重试前重新核验凭据、SN/账号/epoch、授权grant和范围，换人/撤销即停止。快照不变，仍由原数据库事务保证幂等。前台busy_timeout仍15ms，没有新增队列或服务。
- 后台analytics-rollup连接页缓存从通用writer的64MiB改为8MiB，并回读记录cache_kib。目标是减少与HTTP/入库并行时的匿名内存及页缓存重复；真实I/O收益待同条件混合验证。writer64MiB、FULL、250ms、8s和统计时间/事实预算不变。
- 本次没有启用mmap；SQLite官方列出SIGBUS/I/O错误处理差异，当前不引入该额外故障模式。https://www.sqlite.org/mmap.html

本机：旧路由8用例中的瞬时忙锁和撤销场景先RED；新8项HTTP/预算用例GREEN。现有9组Ark、13组Analytics回归exit0。全仓tsc仍12项历史错误，未宣称通过。新增跨空隙与等长正文篡改各自定向GREEN。正式Linux候选和完整混合待验，24h未开始。

回滚：路由/新helper/后台脚本还原到5be3；Python归档缩短事务可独立保留，整个本轮总回滚点10d0dc55。无schema迁移，无整库回灌。生产业务、设备范围与教学窗不变。

署名：codex（OpenAI）｜2026-11-18
