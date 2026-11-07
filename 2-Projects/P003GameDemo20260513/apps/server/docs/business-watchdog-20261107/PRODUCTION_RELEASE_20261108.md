# Brain 单机业务空闲策略上线

已部署081c3f59的两TS文件及保留现役主机监控UI的候选。北京时间2026-11-08 00:42主进程更新，00:47:51复核PID613211不变、health正常、三文件SHA一致；其他Brain进程未改。

只为尾号02000053设置voice.session_idle_timeout_ms=5000，生产API读回和实际签票metadata一致，cfg-139、派单rust-worker。全局与其他覆盖未变。没有连接真实设备房间，Android应用状态未观察到。

主Worker becc21e9已上线并三次正常派单合成问答/自动回收通过；354秒同PID、NRestarts0、任务3/3结束、SFU房0、队列0。搜索/倾听Worker现役未变。信令超时、ASR提前无音频、初始输入与12票仍未收口，不以单机发布替代全故障根治。

证据见PRODUCTION_RELEASE_EVIDENCE_20261108.json；主Worker分支docs/business-watchdog-20261107/P003_BUSINESS_WATCHDOG_PRODUCTION_RECEIPT_20261108.md为完整回执。Grok169/170对发布前根因/候选的联合讨论已经完成，本轮生产部署由Codex核验。

回滚：先DELETE管理API中此SN的voice.session_idle_timeout_ms覆盖（不整库恢复）；实际文件备份/root/p003-business-watchdog-20261107/brain-before。此前签票/在途任务不会因删除配置立即撤销。仅在无任务且无并发文件漂移时恢复本轮两TS+UI，验证健康与其他服务；不用旧Git UI覆盖新监控改动。

首次launcher语法错误发生在执行前，修正版本deployment-exit rc0；保留两次证据。没有新增业务源码，无需为文档重复全套测试。

署名：codex（OpenAI）| 2026-11-08 00:49 CST
