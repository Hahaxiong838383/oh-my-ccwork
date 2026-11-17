# T5 Ark 单写者修复（隔离候选，未部署）

2026-11-18。主13继续执行用户授权的项目1/3修复；此实现选择由主13负责，并非另获用户对具体接口的确认。

## 证据及判断

云 fd536 完整50×6000出现Ark 503及history IO等待；上传500ms节流e868仍有Ark 503，主动停止，797批/159400条并非全量通过。NAS fd536也失败，但镜像默认healthcheck、kernel/cgroup/Python不同，不能当纯磁盘A/B。保持所有旧失败证据。

b318 小规模50×200、同0.5CPU/768MiB复现503。无strace的SQL计时中，有BEGIN成功后至COMMIT调用前约74ms的停顿，而各SQL执行很短。第三轮只跟踪隔离Python的fcntl/fsync：113段WAL_WRITE_LOCK，18个Brain SQLITE_BUSY时刻中17个落在Python实际持锁区间；最终失败请求也命中。最终该次锁约2.94ms，但Brain在等待下一次10ms重试时耗尽80ms预算。短锁+共享CPU调度也能使前台失败；不能简单把整个HTTP耗时叫长锁。strace有观察开销，不作性能验收。精确日志为ARK-PROFILE-SMOKE2/3-OBSERVATION及ARK-SMOKE3-LOCK-INTERVALS。

## 实施

保留现有Brain进程、ArkStore连接、数据库schema及T2 spool。Python仅只读ark.db，JSON/哈希/文件fsync/上传/收据核验仍在后台。claim、prepare、published、confirm、prune及状态写经现有Brain的回环HTTP端点 `/internal/ark-archive` 执行，固定命令，无任意SQL、不跨请求持事务、不加持久队列。命令使用同一个ArkStore连接，避免独立导出连接和前台争抢写锁。任何文件操作不进入Brain。

默认关闭。仅 `ARK_ARCHIVE_CONTROL_ENABLED=1` 且非facts代理进程挂实操作；回环地址+独立32字以上secret，最多2个在读请求、8KiB/1秒读取边界。每条命令核验请求数据库绝对路径与当前连接一致，拒绝错库。Python设置CONTROL_URL时必须成功走owner，不回落直接写；只有未配置时保留旧离线导出兼容路径。T5以T5_ARK_SINGLE_WRITER显式启用，对全部子进程仍计同一配额。

确认保留原逐列不可变性校验：Python对原始列数组作SHA256，Brain在写事务内读取相同列核对，再删outbox/更新批次及stats。保留最大1000行/1MiB/20批、FULL、80ms前台重试与现有历史门限。重复claim/prepare/published/confirm不二次记账。失败保留durable队列。

## 备选与风险

延长超时、加sleep/调优先级仍保留争锁，已不选。独立归档DB需要跨库确认与删除语义，不选。单写者会把有限SQL和commit放在Brain原连接，可能增加其事件循环停顿，必须用同资源混合试验证明没有以延迟换成功；尚不能宣布根治。history在Analytics文件上的folio等待是另一项，尚未消除。

## 验证顺序

1. 红绿测试固定命令、错字段/错库、同ID重放、等长内容篡改、错manifest不删行。
2. 实际HTTP+Python只读导出与快照并行，正确收据才归零；拒绝/断连不自动直接写。
3. 原Ark/归档/Brain拓扑回归。Mac busy两项跳过必须Linux补验；全仓tsc旧12错不称通过。
4. 固定提交Linux同配额小规模复现对照，再50设备完整混合；不放宽history、ACK、资源、dirty门限。
5. 全混合过后才开始真实24h跨CST长稳；成熟数据、离线恢复/72h准备及T6还需独立证据。

## 回滚

源码点 `rollback/p003-t5-pre-ark-single-writer-20261118` = b318c23114241f65052d86b9a66a8129a8e4f909。当前未动生产。未来若启用，先停归档调度，保留outbox及spool，然后撤owner控制配置并按发布清单回代码。不得让旧直接写导出与新owner导出并跑；不得回灌整库或删除待确认数据。设备范围、23点日批、教学72小时窗口保持原状。

署名：codex（OpenAI）| 2026-11-18
