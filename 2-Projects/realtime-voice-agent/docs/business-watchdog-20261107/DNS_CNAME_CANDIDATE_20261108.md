> 最新状态：ca5f95b4 已部署并完成两轮正式RTC验收。见 [部署回执](P003_DNS_CNAME_TTL_RELEASE_RECEIPT_20261108.md)。下文保留发布前记录。

# DNS CNAME 修复最新候选：TTL边界已补齐，待复审部署

当前候选 `voice_connect.rs` SHA256：`f49596c20a9351ef6325b5a1430d001cb8f50e48859738bcdd4127a6d234be8d`。

**旧候选282a4167 / 正式包59e5bb26禁止部署。** 第一次544项通过的测试中CNAME与目标TTL都为1秒，没有覆盖CNAME60秒、目标1秒。新增反例实际失败(543过1失败)，读真实Hickory0.26.3 cache.rs确认缓存寿命只按ANSWER相关记录计算，过期ADDITIONAL仍以TTL0返回。生产未切换，旧发布入口已禁用，证据保留。

新修复保留严格CNAME owner/地址族筛选。若最终目标来自ADDITIONAL，则在本次结果返回后清除该host及实际遍历CNAME链的同地址族缓存；不清全局缓存或无关CNAME，普通ANSWER缓存保持。特殊附加记录路径会多做DNS查询，这是避免地址跟随较长别名TTL过期使用的取舍。域名/SNI/证书/连接与前台总截止保持原样。

固定源码全套547 passed / 0 failed / 1 ignored。覆盖：目标附加地址、无关IP陷阱、不等TTL、TTL0、IPv6、多跳同包、递归查询后原名缓存、线上常见CNAME与目标都在ANSWER的缓存/到期。中间一次误改普通A测试断言、一次递归fixture误构自环导致测试失败，已纠正夹具并保留私有失败日志，不算线上业务故障。

探针补验：原Python客户端未完整关闭FFI资源，旧冷批发生功能PASS后SIGABRT。v2明确关闭音频流及远端已断开的Room资源；3轮普通/ordered/普通均完整exit0、0残余订阅、三通道与自然关房通过，详见PROBE_CLEANUP_EVIDENCE.json。没有强制退出或屏蔽警告。

范围：实际历史4.704秒DNS长等待仍未获得同次包证据。正常捕获不证明历史根因，CNAME缺陷不得冒充其唯一原因。Grok175审的是旧85229df候选，新TTL候选需单独补核。生产仍713f6f35/3dd0430a；ASR修复保留。

发布仍须新正式构建、实际现役3dd+env5c15回滚备份、空房/无未完成job与其他池防漂移，以及新版本正式RTC普通+ordered。旧59e包不许替代。回滚源码标签rollback/p003-pre-dns-cname-20261108→713f6f35已push。

署名：codex（OpenAI）| 2026-11-08
