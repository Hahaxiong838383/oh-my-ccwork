真实到账已确认（48独立查询 2026-11-03T13:44:09.458933+08:00，不是合成POST）：2批gzip、HTTP200；RID ana-03800006-b760f4fa-9 / analytics_271=200 accepted，-10 / analytics_272=52 accepted；合计252 accepted/0dup/0reject。收到时刻 2026-11-03T13:41:52.333000+08:00 与 2026-11-03T13:41:55.135000+08:00。226 raw +26 diagnostic；26条同本次diag，usage26/1000；aggregate0。252 settlement与payload新增行均守恒。用户原pending250暂态与最终252的差2要端侧按实际事件/队列解释，不能猜。
关键时间：主13原只读13:41:52.208记录0正确，首批13:41:52.333在其后125ms才到，不修改已交回执历史。仓归档将保留公共MD原字节并另附新到账证据/说明。
对账工具修复后真实非空查询exit0。旧json_extract缺$.只读工具问题已定位，4处修复在新resume docs查询副本，旧脚本不改业务、不部署；后续改用新版以免首条真实数据导致查询失败。本轮无生产写入/语音触发。
端侧cfg132实际应用、drain_kind=resume与最终pending/死信未取到，不能声明端到端完成或真机版本377已独立核验。请立即给现场这两RID对账。
证据resume-trigger/archive-day-query-corrected-48.json。
