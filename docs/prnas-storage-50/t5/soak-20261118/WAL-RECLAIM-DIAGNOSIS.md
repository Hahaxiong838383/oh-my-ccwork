# 下一单变量：更早回收已检查点的 WAL

状态：仅准备诊断开关，尚未运行、未修改生产默认值。前一轮固定3b09cde5只改历史evidence索引，仍在Linux原64MiB混合测试。

原63de原配置完整诊断：300000条精确ACK、dirty0、ACK P95/P99 343.075/823.854ms；250查询21次history transport失败，P99 161.288ms，工作集峰99.971%，不是通过。首evidence读取208896B，wall921.433ms/线程CPU4.056ms。

V2运行中的只读mincore快照（1794945371703）：WAL文件225755432B、驻留154189824B；数据文件526147584B、驻留150786048B；group memory.current785121280B。映射PROT_NONE，仅问页驻留，不触页或读内容；这不是逐cgroup内存归属，更不能直接把154MB全算作工作集。

待测假设：当前WAL到256MiB硬门才尝试TRUNCATE，可能留存可回收的日志页缓存并挤压在线读。使用现有checkpointer参数在64MiB时更早尝试SQLite回收，验证内存/冷读是否下降；不是声称PASSIVE反复复制全部WAL。SQLite检查点会记录进度，见[官方WAL文档](https://www.sqlite.org/wal.html)。

`T5_DIAGNOSTIC_WAL_RECLAIM=64MiB`只在profiled preflight允许。测试明确记录checkpointer回收目标64MiB，writer硬门256MiB保持；10秒节奏、独立子进程、FULL、8秒writer预算、503重试、500/2000ms ACK门、120/125ms历史门和P99≤100不变。不改生产、不改默认值、不让诊断开关流入24h验收。

只有实际SQLite TRUNCATE可回收，busy时按原机制等待下轮；不得unlink WAL。测试需核所有ACK、两维统计、最终dirty0、身份/GM/null、真实历史HTTP、内存、WAL、checkpoint失败/耗时，并与固定V2单变量对照。若仅改善局部或引起ACK退化，保留FAIL，不宣布根治。

署名：codex（OpenAI）｜2026-11-18
