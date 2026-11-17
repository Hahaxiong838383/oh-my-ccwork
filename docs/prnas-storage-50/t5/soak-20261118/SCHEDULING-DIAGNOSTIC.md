# T5 调度对齐诊断

只读核实线上接收进程nice=0、I/O为none；统计/备份systemd服务是Nice=10、best-effort priority7，见PRODUCTION-SCHEDULING-READONLY.json。旧隔离测试整个组Nice=15，未区分前后台；这是测试拓扑差异，不能由其失败直接断言生产同样失败。早期直接split整行/proc/stat把priority误标为nice，已改为从最后一个右括号后按字段读，并用ps交叉核实；以此文件记录为准。

新增仅Linux profiled preflight可用的T5_DIAGNOSTIC_SCHEDULING=production。测试接收/客户端nice=0，后台统计/备份/导出通过nice10和ionice best-effort7启动；核实际进程属性。CPU总配额0.5核、内存768MiB、FULL、单writer、8秒job、查询120/125ms、全量P99≤100ms、ACK门及统计预算均不变。

这是定位调度影响的实验，不是已证明修复；源码运行基线仍为708a3149，仅测试调度增加开关。本轮同时包含非阻塞Ark修复和生产调度，不能把相对16716936的全部差异单独归因于nice。不会改线上服务或内核参数；不以诊断开关直接冒充24h正式验收。

署名：codex（OpenAI）｜2026-11-18
