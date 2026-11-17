# T5 调度对齐混合：失败，继续定位

9a5ac270在Linux Node24.19.0/SQLite3.53.3、整组0.5CPU/768MiB下，调度nice0/后台nice10+BE7已真实观测。前台实际query_only=true、cache8MiB；此前摘要提64MiB不是本次运行配置。业务源与708a3149相同。

35份原始输入逐文件核SHA，归档SHA256为10bf9d9e22f4ce9b6aae3f5cec7e089832843fed04968d0a6bcc91ce560a5fa7。4173次Analytics尝试中1471个HTTP200、2702个503；最终只完整落到1470份客户端完成记录，测试被Ark断言提前打断，不能宣称全量ACK/300000事件对账完成。Ark303次中302个200、1个503；该503的2次BUSY尝试均保留。

150次history查询20次传输失败，整体P99=129.127ms，第三窗P99=148.271ms。服务端稍后200不抵消客户端超时。最慢926.867ms，严格窗口9个采样均D/folio_wait_bit_common；assets580ms/135168B、evidence325ms/45056B。没有OOM或memory.max触发，工作集峰67.061%。生产97次独立guard全ready。最终drain未运行，不以dirty余项断言已修统计收敛复发。

结论：busy0和调度无法消除同步页读等待，不能发布或跑24小时宣称通过。发现harness把Ark POST也放在Analytics主进程，正在与生产Brain/Analytics分进程拓扑独立核验；该差异会放大快照等待，不豁免history超时。下一步先局部SQL成本对照与拓扑核验，避免原样重复完整压测。

Grok420原文原样保留。主13复核补充：167最慢请求严格时间窗共11采样=10 folio+1 do_get_write_access；报告12包含窗外/边界采样，摘要不能用11/12代替。708实际常量10ms、最多6次；这是本机45ms真实锁4次方案失败、6次成功后选择，Linux45ms=51.343ms/200、250ms=62.102ms/503已验。源码注释提exponential是在解释不采用指数等待，并非实际实现仍指数。原报告的四次建议未采用。

此前167完整失败副本已在NAS独立还原及双副本SHA核同；派生副本只读计数300000events/seen、600000facts、dirty2。执行镜像实际Node22.19.0/SQLite3.50.4，仅证明原文件计数，不冒称Node24恢复验收；首次只读mount errcode14失败保留。

署名：codex（OpenAI）｜2026-11-18
