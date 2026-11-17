# 私有反例独立复核

结论：调整为符合既有上传协议的夹具后，三个反例均通过，未复现产品缺陷。

1. 换到另一家长：旧300秒不进入新scope，旧家长读取404，新report_id独立。
2. 历史授权JSON损坏：保持503 history_configuration_invalid安全失败，不绕过权限；恢复原配置后原300秒、report_id、revision均保持。
3. 边界、精度及别周坏事件：299999ms保留299.999秒且活跃0；played严格计1；周日22点发布，23:30补传修订且首次发布时间不变；周一period-end补全再修订一次，稳定重读不再修订；隔离SQLite中的另一周倒序旧脏focus不污染旧周诊断或数值。

夹具判定：当前telemetryStore.ingestEvent接受未知outcome=PLAYED，统计将其视为未知，不计played；倒序focus由既有协议正确返回invalid_event_data，不能要求accepted。本审阅先显式验证拒收，再仅向临时SQLite插入旧脏行，以保留“读到历史脏数据仍隔离”的测试意图。快照时Grok源文件已把周一revision预期改为+1，本审阅另外验证随后重读版本不增长。

测试实测：3/3通过、exit 0。全部数据库为mkdtemp隔离测试库；未改产品代码、未改Grok原文件、未访问生产凭据或写生产业务。

测试文件与源码快照SHA见review-manifest.json。署名：codex（OpenAI）| 2026-11-17
