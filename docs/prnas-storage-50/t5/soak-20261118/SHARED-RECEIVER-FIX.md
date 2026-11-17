# 混合预验的查询接线与后台锁重试

结论：300k正式频率首轮仍失败；已分别处理查询测试接线和归档短写锁，新的Linux完整预验与24h尚未通过。未部署生产。

固定失败候选b5bb1cbf：1500批、300000条ACK完成、3851次请求、客户端446159ms排空；未完成最终独立数据库全账，不能把ACK当最终数据库验收。第300秒查询子进程在ArkStore构造时database is locked，尚未调用preview；归档作业另报OperationalError，导致整个运行提前停止。源失败库和日志仍保留。一次额外只读quick_check/计数SSH采集35秒超时，没有拿到结果，不作为通过证据。

## 查询接线

原测试每次维护重启Brain查询进程及额外Analytics reader，并再次初始化ArkStore/schema。现役ArkStore/runtime常驻，查询走处理上传的同一个Analytics HTTP应用。Grok412只读复核同意修正测试拓扑，同时明确不能用此解释吞掉独立的导出失败。

测试改为一次启动查询子进程，producer启动前建好连接，轮次经IPC执行；原冷启动压力脚本保留。查询进入本轮实际接收上传的HTTP应用，使用原授权/grant和sha256设备键；每条应答必须核对接收进程PID、资产值/时间/null、HTTP状态和完整正文。单独记录首笔、异常、退出，不重启重试失败查询。生产120/125ms与全量P99≤100ms不变。启动按现役1秒warmup；degraded不代表通过，后续查询仍逐笔验收。

Grok410发现旧Mac smoke的HTTP查询晚于同轮rollup完成491–898ms。现在维护CLI附实际工作起止时间，正式预验/24h还要求真实HTTP请求与实际维护区间重叠，不再只用启动两个子进程作证。

Node24本机功能smoke：50身份、10000事件、400次查询，全部命中同一接收进程且资产正确；查询P99 26.772ms，ACK P95 90.124ms/P99 328.363ms，dirty0，三项重叠存在。杀死查询子进程时，待完成及后续IPC调用均拒绝通过，关闭阶段也不能掩盖异常死亡。仅功能smoke，不是Linux性能/24h。

## 归档短写锁

Linux Python3.12.3/SQLite3.45.1真实持锁复现：旧导出遇350ms写锁后失败，连last_error写入也撞锁，掩盖首次异常。该复现证实存在短写锁处理缺口；历史日志只有OperationalError，不能从这一个类型反推每次旧错误都是BUSY。

仅后台导出连接对SQLite错误码BUSY重试；保留每次SQLite等待100ms，所有失败等待/退避共享累计1秒预算。不重跑整个cycle，不增加20批上限，不把等待带入设备HTTP。非BUSY立即失败，持续锁到预算后保留队列并失败；错误状态写入不能替换原始异常，CLI追加SQLite错误名便于下轮定位。文件发布/收据/清理仍使用既有幂等映射。

Linux12项全部通过：短锁恢复且只发布一次、持续锁有界退出及pending保留、非BUSY不重试、错误ACK、篡改、磁盘不足、实际SIGKILL后恢复等。代码SHA与日志见EXPORT-BUSY-LINUX-GREEN-02.json；旧码RED见EXPORT-BUSY-LINUX-RED.json。Mac两项真实锁时限测试跳过，不能替代Linux结果；Mac原SQLite等待100ms实测可能超过1秒，不据Mac误判Linux锁预算。

本机首次shared smoke使用系统Python3.9.6/SQLite3.51.0组合，备份OperationalError失败；换回既有测试Python3.11.9/SQLite3.45.1后通过，尚未证明该失败的唯一根因是版本。失败目录保留，后续Linux固定运行时必须独立验证备份。

## 发布边界

运行src树仍等于b1ce23；后台产品导出脚本有本次BUSY修复，不能再笼统称所有运行文件与b1相同。其余改动是测试接线和维护报告时间戳。回退可逐文件恢复本轮前版本；本轮未改生产业务、设备范围和已验证14档。旧失败样本不追认为通过。

署名：codex（OpenAI）｜2026-11-18
