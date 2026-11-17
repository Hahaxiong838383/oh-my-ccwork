# T5：缩短 Ark 归档写事务

结论：10d0dc55 的 Linux 600秒混合预检提前失败。30万条埋点ACK完整；第三轮历史查询12次失败；Ark第302次请求503，接收端实录ERR_SQLITE_ERROR/errcode=5，明确是SQLITE_BUSY。不能将这个错误码倒推到没有错误码记录的旧V2样本。

WAL提前回收发生30次，ACK P95/P99改善至126.95/192.44ms，工作集峰值87.76%；仍高于80%门，历史查询最慢1212ms，因此不是根治，不能部署或开始24h验收。见WAL64-MIXED-INDEPENDENT.json。100ms内核采样未覆盖该轮最慢查询，0条folio等待不作为反证。

已实施最小候选（尚待Linux混合验证）：
- `claim`在写事务外读取最多1000条/1MiB前缀；事务内单条UPDATE RETURNING代替逐行UPDATE；核对原ID和bytes，变化则连同批次元数据回滚。AUTOINCREMENT后到设备行留待下一批，其他批次空隙不改变。
- NAS收据确认后的`finish`保留事务内全部原始列复核，将重复JSON解析/拼接移到锁外。变更任何payload或映射均不能删除源行或标记complete。
- 不增加前台busy_timeout，不新增队列/服务，不改变owner、grant、Ark current、资产事实和NAS ACK规则。

验证：旧claim在“写锁外选前缀并允许并发设备追加”用例真实RED；修复后本机16项中14通过、2项Linux锁时间测试跳过。新增字节上限、已认领空隙、前缀变动全回滚、ACK后校验与删除之间的篡改拦截。Mac HTTP持锁试验原预期503但实际200，已保留失败，不能替代Linux锁时间验收。

回滚：仅还原storage-ark-export.py到10d0dc55版本；无schema迁移、无数据回灌。源码候选尚未用于生产。

下一轮同时明确两点：业务候选仅缩短归档事务；测试前台改回现役8MiB/query_only接线，保留WAL64诊断并标注两个不同变化，不冒称单变量因果证明。所有CPU/内存/延时/日批/30万计数/混合任务门保持。

署名：codex（OpenAI）｜2026-11-18
