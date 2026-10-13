# 最终集中修复定向复审

结论：**代码 Spec gate：PASS；Quality gate：PASS。原 I1 / I2 / M1 均已关闭，无新增 Critical 或 Important。容量/开启采集 gate：NOTYET，不能开闸或扩灰。** 代码通过不代表香港压力验收通过；仅可按已批准裁决继续验证三重关闭的安装。

范围：`251668b2..82a37b793ee4e0de8a235cdf15237bb39224c80f`，读取完整 `final-scoped-review`（156656 bytes）及关联实现、定向测试、合同/计划和 owner 证据；随后定向核对 `6b88c874d13ed20406e841054cb5e708192af0e7` 的两处文档更正。本次仅复审既有 I1/I2/M1 及同一修复波带入的 snapshot、单遍聚合、缓存、checkpoint周期入口、有限验收driver、备份目标缓存和生产维护预算，不另开整分支审计。

## 原 finding 的关闭证据

| Finding | 结果 |
|---|---|
| I1 overview同步扫描逐事件fact | `src/analytics/admin-query.ts:24–40` 改读 day/device_day；计数与时钟求和，设备跨日 DISTINCT，候选不受当前alias缩窄，不读fact。received批次与覆盖率继续独立统计。返回两维度dirty、summary_days、cutoff、updated_at，UI标约每5分钟更新；dirty且无摘要显示“—”，缺少水位显示未知，不能冒称完整零事件。 |
| I1相关一致性 | `src/analytics/store.ts:72` 的deferred BEGIN读snapshot复用调用方事务、不提交它；自有异常ROLLBACK。`index.ts:56–62` 把内部query与额外allowlist coverage包在同一snapshot；没有await。读取不会取得BEGIN IMMEDIATE写锁。测试以第二真实SQLite连接在摘要读取后提交rollup，旧请求仍保留旧摘要+dirty，新请求才同时看到新摘要+clean。 |
| I2 exact ID缺前导索引 | `store.ts:40` 新增 `(client_event_id,received_at_ms)`，未改变device+ID幂等主键。当前query的命中/缺失、occurred/received四条执行计划均先按ID索引；既有库幂等补索引，raw/seen计数保持。 |
| M1 最近批次时间错误 | `admin-query.ts:35` 独立取received batch最大时间；HTML1264绑定 `last_batch_received_at_ms`。全拒收/重复批次可推进它，不推动事件汇总cutoff；API说明同步。UI定向测试覆盖纯拒收、dirty零摘要及缺失rollup三种状态。 |

server路径相对 `2-Projects/P003GameDemo20260513/apps/server/`，HTML位于相邻 `apps/web/public/admin/index.html`。

## 同一修复波的安全性核对

- **单遍rollup**：`rollup.ts` 每日期/维度仅一个按device_key/id_digest排序的fact iterator，每条semantic解析一次；仅保留当前设备session/reward集合。设备内去重后求和符合原device命名空间计数，全局/设备七组语义计数保持。删旧device_day、写逐设备摘要、写全日摘要及清dirty仍在同一每日事务；预算越界回滚此前写入，旧完整摘要保留，dirty/公平retry/诚实partial水位与先提交TTL不变。代表性13条多设备fixture及迟到、预算中途失败测试覆盖这些行为。
- **64MiB writer cache**：仅固定pager从32改64MiB，未改cache_spill、FULL、auto0、COMMIT后ACK、固定语句、256MiB双准入闸或child优先级。它是页缓存建议预算，不是RSS承诺。实机压力仍失败，不能以串行probe改善宣称容量修复。
- **checkpoint周期入口**：共享bootstrap仅接受100..10000十进制整数字符串，空/指数/小数/越界失败；默认仍10000ms，deadline仍30000ms、singleflight保持，stale由实际interval计算并回显。没有因测试profile把默认周期偷偷改成1秒。
- **backup目标128MiB**：PRAGMA仅作用于独占新目标连接，源仍mode=ro；完整integrity_check、文件摘要、隔离恢复、独占创建与已有超时未取消。主控提供697MB实际备份/新恢复证据（312040 events/seen、624080 facts、SHA一致，67.48s与82.49s），此处记录为主控现场证据，并非本人SSH重跑。
- **生产rollup30秒**：helper下发代码原有30000ms上界，仍是每日协作预算；CLI外层240秒和systemd300秒不变，不能承诺16日必在单次完成。超时可使任务失败，但已提交TTL与先前完成日期保留，进行中的日期事务回滚。主控报告8秒实跑partial正确；随后提供同一363640事件实库30秒预算结果：27.658秒完成两个维度日，failed0/remaining_dirty0/partialfalse。记录为主控现场证据，不等于84000摄入容量通过。
- **有限driver**：allSettled保留actor失败，monitor异常进入结果并使gate失败；全84000/420批完成、非空监测、原P95/P99/RSS/health门均保留。服务Retry-After超过本轮截止时停止该actor并记失败，不提前重试；部分ACK和失败报告先持久化，不再因断言丢证据。stage启动等待使用monotonic60秒，超时留PID/child并要求检查，不重新seed密钥。

## 本次额外验证

没有重跑已有绿灯整套；读取owner的query/checkpoint/ingest/http/maintenance/ops、定向TS及UI测试证据。本次额外执行一次真实临时SQLite探针，与原I2同为200000 raw行、14个假设备：

- 不存在ID：occurred **6.813ms**、received **0.557ms**；二者EXPLAIN均为 `SEARCH analytics_event USING INDEX analytics_event_client_received (client_event_id=?)`，不再日期全窗扫描或received全索引扫描。时延仅此本地样本，非香港容量值。
- 写入两天×14设备的day/device_day摘要后，直接删除临时库fact表，overview仍正确返回 **280000事件、14个跨日去重设备、14个可疑时钟计数**，耗时 **2.789ms**，证明此查询不依赖逐事件fact。摘要示例由探针构造，不冒称28万真实摄入。
- 实际PRAGMA：FULL=`2`、auto-checkpoint=`0`、cache_size=`-65536`。结束已关闭连接并清理临时库。
- `git diff --check 251668b2 82a37b79` exit0。未修改实现、未SSH/部署、未操作任何设备或真实秘密。

## 文档收口与发布边界

- **Minor文案残留已关闭**：已读取 `6b88c874`，`docs/analytics-server-contract-v1.md:75` 改为“生产30s有界预算”，与同文`:61`及helper一致；集成指南明确当前禁止任何设备上传/扩灰，必须等待新容量通过回执。无需再开修复波。
- 主控提供的最新64MiB/1秒profile完整失败回执：**50400 ACKed / 252批，P95 6041ms、P99 9434ms，容量不通过**；RSS209756160 bytes与原3001 health增量2.746ms通过，不能覆盖完成度/时延失败。6次代理超时JSON503/900按截止终止actor，31次WAL503/10，未删除任何accepted/seen。本报告不把代码PASS、Ruling或备份通过写成容量PASS。
- `82a37b79` 计划裁决允许的仅是经验证的闭门安装：global upload=false/hour0、独立allowlist空、热总闸false；还须主控完成关闭请求无DB增量、原服务health/PID守卫、实际UI、备份/恢复/回滚与源manifest核验。**全部原容量门通过前不得开启任何采集或扩灰**。现役语音自然请求、首台真机与真实午夜验收继续保留各自未完成状态。

署名：codex（OpenAI）| 2026-10-13 11:16 CST
