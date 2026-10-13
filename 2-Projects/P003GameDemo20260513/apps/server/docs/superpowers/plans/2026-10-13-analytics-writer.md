# P003 埋点写入隔离实施计划

> 执行方式：依照已有授权和 CONTEXT-BUDGET 分治。worker实现与回归由 capacity_analysis 负责；主代理负责HTTP接入、生命周期、隔离验收及发布。

**目标：** 隔离同步SQLite写入对HTTP接入的阻塞，保持持久ACK和全部原容量门槛。

**架构：** 一个长期writer thread、一个在途任务；HTTP鉴权后异步等待提交，繁忙时快速退避。查询连接只读，小缓存；独立checkpoint不变。

**技术栈：** 已有Node24.19.0、SQLite3.53.3、TypeScript/tsx、Hono；不新增依赖。

**设计：** `../specs/2026-10-13-analytics-writer-design.md`

## 约束

真实采集保持三重关闭；不碰HK2/个人3002/NIO；FULL、10秒checkpoint、256MiB RSS、84000完整对账与时延阈值均不放宽。保护现有源码与完整manifest，逐文件CAS。

## 任务1：持久writer（独立可验收）

- [x] 新建 `scripts/analytics-writer.test.ts`：持久落库后ACK、重复/冲突；外部写锁期间主线程计时器可执行且第二次submit立即busy；事务失败无半写；thread退出pending失败；close幂等。记录RED。
- [x] 新建 `src/analytics/writer.ts` / `writer-thread.ts` 及必要mjs启动器。接口 `new AnalyticsWriter(path)`、`ready`、`busy`、`settle(context,batch,requestId):Promise<AnalyticsAck>`、`close():Promise<void>`。任务单槽，失败用稳定异常类型，无正文日志。
- [x] `node --experimental-sqlite --import tsx scripts/analytics-writer.test.ts` 通过真实worker/SQLite检查；关闭全部测试资源。

## 任务2：HTTP与生命周期（主代理）

- [x] 新建真实HTTP集成回归：挂起提交期间health可返回、第二请求收到503/5、首个请求仅在提交后200；worker未ready/退出不报告ready；停止释放端口/线程。
- [x] `src/analytics/index.ts` options支持writer；请求入口/submit双重忙检查；start创建writer并将查询连接query_only、8MiB；stop等待关闭；原createApp无writer的直接单测接口保留。
- [x] 原10组analytics、新容量/迁移和writer/HTTP回归通过；`git diff --check`无空白错误。

## 任务3：隔离实机验收与交付

- [x] 记录stage源码SHA，增量同步、仅重启隔离ingest；保留既有数据库和假凭据。原负载完整复验，RSS包含所有线程。
- [x] 保存load/OS/profile证据；检查ACK/raw/seen、所有门槛、退避与总耗时；验证维护重叠及原公司health。
- [x] 通过后准备逐文件备份/迁移/小范围发布回滚记录，保持旧完整manifest可用；失败则不开放采集，不以修改门槛制造通过。
- [x] 复核生产三重关闭、进程与计数；更新回执/联调/容量选型和共享记忆，明确部署状态与剩余限制。
