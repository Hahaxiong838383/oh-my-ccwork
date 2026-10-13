# P003 埋点写入隔离设计

本次属于已获授权的容量优化：用户要求按建议优化；先在现有 HK 隔离环境实施和验证。不开启真实采集，不采购服务器，不改变端侧合同。

## 证据与方案比较

完整 84000 条同请求计时：COMMIT→HTTP end 最大 1ms，客户端发送→服务端 request 回调 P95 2075ms / 最大8709ms，事务P95 436ms / 最大2791ms。同步 SQLite 写入使接入事件循环无法及时响应。主动延迟ACK没有依据，不采用。合并四批事务已实测更慢，不采用。128MiB缓存超过原256MiB RSS门槛，不采用。

推荐一个长期 worker thread 执行原同步事务：使HTTP在磁盘繁忙时仍能接收请求、及时返回503；它不能提高物理磁盘速度。另一个方案是迁移异步数据库驱动/数据库，改动和回滚面更大，暂不采用。更换独立数据盘/将埋点与语音分机作为硬件方案，需实际目标盘验收。

## 边界与行为

- 主线程仍处理鉴权、三重开关、设备状态、协议校验、WAL/磁盘/请求速率。保留最多两个读请求体的槽位；worker只有一个在途写任务，不建立内存积压队列。
- 主线程数据库连接只做查询，缓存8MiB；worker独立连接采用64MiB缓存、FULL、autocheckpoint=0。首轮96MiB已实测RSS291733504B超门槛，故收窄缓存。SQLite每批原子事务和独立10秒checkpoint保持不变。
- `AnalyticsWriter` 暴露 `ready`、`busy`、`settle(context,batch,requestId)`、`close()`。未ready或故障返回存储不可用；busy返回原503/Retry-After 5。HTTP不把任务入队当成功，只在COMMIT后的worker消息到达后返回原ACK。
- HTTP通过`settle`第四个可选参数传原始JSON文本，避免深坏事件在structuredClone或JSON.stringify中先栈溢出；worker解析后按原事件结算。4000/10000层混合批与同ID冲突均有真实worker回归。该文本受原2MiB请求体上限约束。
- worker退出、出错、无法通信或任务超过8秒时拒绝在途请求，不自动重放、不产生成功ACK；客户端仍按原合同重试，seen保证已提交但ACK丢失后去重。超时后永久failclosed并等待实际任务结束，迟到消息不能恢复ready或补发成功ACK。
- SIGTERM停止接入，最多等待在途事务30秒，再关闭writer、checkpoint、查询连接；超时退出码为1，不宣称写入成功。再次关闭幂等。PM2 kill_timeout由5秒调至35秒以容纳该关闭流程，HTTP代理10秒超时与所有容量门槛不变。
- readiness必须包括worker ready；RSS使用整个进程RSS（含worker），不得只计主线程。所有错误只返回稳定错误码，不打印事件正文或凭据。
- 新fact索引保持已验证迁移设计；迁移和发布分开，显式备份与事务迁移，保留旧完整发布manifest。回滚恢复文件，保留数据库、WAL、seen和密钥。

## 验收与停止条件

TDD验证真实SQLite持久ACK、重放/冲突、失败无半写、worker繁忙时主线程心跳/HTTP及时响应、worker退出与幂等关闭。原10组回归全部运行。

原容量负载不变：14×30×200=84000，5分钟deadline、2秒批间隔、125ms主体起步间隔；P95≤500ms、P99≤2000ms、整个进程RSS≤256MiB、公司3001健康P95增量≤50ms，唯一ACK+raw+seen逐条对账。单独报告全部退避次数与总耗时，不能靠更多拒绝掩盖吞吐退化。假库持续增长，不清seen；目前单日737100，避免跨过100万事实维护预算。

通过后再进行关闭状态部署。若时延/内存任一仍失败，保留真实FAIL和三重关闭，不声称可开放全量；记录软件收益与独立存储需求。

参考：[Node.js worker_threads 官方文档](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)。worker用途是隔离本项目同步数据库调用，非承诺提高I/O吞吐。
