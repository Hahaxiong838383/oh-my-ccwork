# T5 传输验收进展（2026-11-18）

**最终600k测试库真实NAS还原已通过；完整T5未通过，未部署。**

- 2,124,611,584字节经真实云→NAS SSH拉取，产品校验/ACK/独立还原约375秒。主13重新读取NAS恢复文件，完整SHA与本机已验证副本一致，18表计数完全相等：600000事件、600000 seen、1200000统计事实、dirty0。NAS恢复文件与包文件inode不同，源和NAS收据完全相同。证据 [NAS-FINAL-VERIFIED.json](NAS-FINAL-VERIFIED.json)。
- 本轮是停写合成库导出，未执行在线BackupAPI全量备份，不代表成熟混合性能。私有源文件已迁入只读spool并记录回退方法。测试封装启动失败均保留，最终源/NAS代码按SHA核同。
- 真实1小时归档传输拒绝已于11月18日00:27:50.011 CST启动，最早01:27:50.011恢复。50模拟身份继续HTTP写入、持久队列与导出；只隔离此任务的SSH端口，生产保护每5秒读取ready，5GiB空间底线。现已完成独立源/NAS全账核验，结果见下方一小时子项；不代表完整T5通过。
- 修复长稳统计工具的假绿：整机平均值不能替代cgroup限额；在原门基础上加CPU配额占比<70%、组内存至少20%余量（保守工作集口径）、配额变更失败。先实测旧代码错误通过的RED，再补正反/边界测试GREEN。只有模拟计数测试通过，没有24h证据。

新鲜600k业务运行候选仍b1ce23；本轮业务src无修改，测试生产者提交4aed8139。完整成熟库/72h积压真实排空/语音AB/真实24h以及50档容量评估继续待验，已验证档14、设备范围和23点日批不变。

署名：codex（OpenAI）｜2026-11-18

## 新增独立子项

- 72h容量模型：本机Node24、真实ArkStore/FULL持久化，50×5184=259200条不同签名全部入队。正文218386560字节、代码预留1451422080字节，未触8GiB；独立全行SHA/身份/null/序列/20包核对通过。当前只导出首20000条，未执行全部NAS排空，不作为Linux性能或完整A11通过。见MODEL-72H-INDEPENDENT.json。
- Linux受控文件缓存探针：64MiB测试组读128MiB自有文件，raw current达到99.98%，保守工作集17.95%、OOM0，删文件后raw降到18.33%。memory.events max=814仍保留，说明发生缓存回收压力，不能说无压力或应用延迟已通过。
- 资源门修正：仅把`max(0,min(current,inactive_file)-file_dirty-file_writeback)`计为可回收，工作集/限额须≤80%；raw占用保留。与Grok406公式在不一致采样时不同，主13采用先裁current再扣dirty/writeback，更保守，新增负向测试。主机可用20%、CPU配额70%、OOM/重启/磁盘/ACK与原24h时长均不降；缺统计失败。RED已复现旧脚本错误拒绝clean-cache，GREEN含边界与缺失统计。该探针和模拟计数不能追认24h。
- Grok405核固定1a0ed证据文件和资源旧脚本；Grok406结合实际NAS接线撤销404两项P0，反对删除恢复排空段。后续实际一小时仍须独立源/NAS逐条对账。
- 仅回收已多副本恢复验证的2.12GB合成测试源payload缓存；NAS双文件、本机还原和分块、原manifest/receipt均保留，云端原payload已不存在，回退从已验副本恢复。未删除生产数据/未验失败样本。

口径依据：[Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)、[Kubernetes内存压力](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)。实现比扣除全部inactive_file更保守，不扣active_file或未落盘页。

## 一小时真实传输恢复完成

已独立核对源端和NAS原始全量数据：50模拟身份/74轮共3700 accepted，23包3178684字节，完整3600秒断线、120次真实SSH/TCP拒绝；恢复后161715毫秒源端pending=0。全部snapshot_id/record_id/账号/epoch/钱包null/载荷SHA/收据一致，0丢失0重复。751次保护检查生产ready均true，最低空闲5574287360字节，夹具峰值9495938字节。源unit和NASrunner均exit0。见OUTAGE-VERIFIED.json。此为小流量1h子项，完整259200积压+排空仍未通过。

Linux真实资源采集器已实跑（2个样本，无缺字段），明确不足24h且local_resource_gate=false；Grok407复核固定13b62db9实现与四真实内存值回放，无阻断。Grok未重新SSH采样，主13的Linux实际采样另存RESOURCE-LINUX-PROBE.json。

隔离Linux调度smoke-01在0.25CPU/512MiB下：600条/3成功批数据完整，dirty0，但ACK p95/p99=1303.305ms，触发p95≤500ms门，unit exit1。保留该失败，不称Linux性能通过；其配额低于前轮已验0.5CPU/768MiB，且仅3成功样本，须进一步区分冷启动和配额影响。完整门不降低。

## 长稳开跑前调度修正

- 同候选ec6e3f75按既定0.5CPU/768MiB、50身份×200再跑Linux：10000接受、0重复，50成功/157次503均留账；ACK P95=200.096ms/P99=1205.240ms，dirty0，unit exit0。它改变了配额和样本量，不能视为只改变CPU的因果AB；不追认前次3批失败，也不是24h。
- Grok408复核指出5分钟循环相位可能错过短日批的维护/备份重叠。采纳：等待第一笔实际ACK后主动并行触发维护与备份，归档串行锁与周期任务共享；备份只从此刻开放，保留published判定。按实际请求起止时间而非子进程启动/退出时间验重叠。
- 新增真实ArkRuntime→独立Analytics HTTP reader持续查询，与每轮维护并发，资产校验按查询前后不可变快照值/时间配对，不能只验末尾current。日批合成事件使用本轮开始时刻，早于持续快照，避免把期望值弄成任意时刻的历史/快照混算；当前catalog没有星尘余额事件，星尘仍应未知。
- 首次新增查询smoke漏用现役src/index.ts的warmArkHistory，首查166ms、history无200，已留失败；测试补上同一已有1秒启动流程（不增加运行代码、不丢弃设备查询）。复验18次实际查询0错/0传输失败、P99=43.125ms；1800事件精确对账、ACK P95/P99=223.221ms、dirty0、两项真实重叠。仅Mac短测，后续Linux/24h仍待。
- NAS旧失败夹具保存首次启动因临时模板把ROOT替换进环境变量名，1ms即停止，尚未传输；已按前后SHA修正测试包装、保留失败记录再启动。产品归档源码和已通过1h/600k包未变化。正式24h包装同类问题在启动前一并纠正。
