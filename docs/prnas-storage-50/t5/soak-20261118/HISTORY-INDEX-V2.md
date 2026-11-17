# T5 历史证据冷读：最小候选

尚未完成T5，未部署生产，24h NOT_STARTED。既有项目1 writer-fatal/checkpoint与统计前缀收敛修复保留，本次只处理历史查询的读取成本。

63de5fcf原配置Linux诊断第300秒捕到：evidence all 921.433ms、线程CPU4.056ms、主线程read_bytes208896；assets29.103ms/1.521ms/86016B。读盘实际存在，但计数不等于把所有921ms精确归因给IO：配额/回收仍可能重叠。独立wchan采样晚8秒，未覆盖首个慢调用，不得冒充首例栈证据。

已确认两条查询均USING COVERING INDEX、无回表，但旧evidence按事件类型分段后排序，读入普通reward/command/gift再过滤。仅重新排序索引在本地60k实验398→394页、VM67900→63600，改善有限；使用**原样过滤谓词**的窄索引398→67页、VM67900→2600，263条结果SHA完全相同。这是局部SQL计划证据，不能代替云端吞吐/延迟验收。

最小改动：离线新增analytics_ark_evidence_cover_v2，以device_key/received_at_ms顺序读取，只收当前SQL本来会返回的normal-day/GM候选；保留properties原值供既有精确GM边界判断，不把GLOB宽匹配直接当GM。去掉该查询不用的batch/session/client-event列。SQL读取与索引共用同一谓词。资产与daily索引未改；权限、历史watermark、null、512限制、HTTP预算不变。

读端顺序V2→旧V1→原selective索引，兼容未迁移数据库。安装仍离线、事务内、精确DDL冲突拒绝，不在服务启动建大索引，不删除旧V1。回滚源码到63de5fcf；已经增加的V2可以保留，旧代码继续用保留的V1/原索引。后续若需删除V2，只能离线且先核当前读者，不回灌整库。

验证：新增测试先在旧源码因临时排序失败（RED）；候选默认历史19项通过，补旧V1升级/降级/数据修改边界后cover20/20；最终完整9组Ark回归exit0。升级用例首次错误地使用enum外command=normal，属于测试夹具失败；修正合法摄入后直接修改合成旧数据验证marker兼容，失败日志保留。精确日志hash见HISTORY-V2-TEST-EVIDENCE.json。

下一步：冻结候选，独立评审，先对原64MiB诊断比较只变索引；再生产8MiB设置独立完整混合。仍需ACK/全部历史返回/dirty0/资源门，不提高CPU、内存、超时，也不降低混合负荷。

署名：codex（OpenAI）｜2026-11-18
