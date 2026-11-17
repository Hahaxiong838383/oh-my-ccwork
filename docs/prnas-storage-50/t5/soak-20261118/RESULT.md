# T5 传输验收进展（2026-11-18）

**最终600k测试库真实NAS还原已通过；完整T5未通过，未部署。**

- 2,124,611,584字节经真实云→NAS SSH拉取，产品校验/ACK/独立还原约375秒。主13重新读取NAS恢复文件，完整SHA与本机已验证副本一致，18表计数完全相等：600000事件、600000 seen、1200000统计事实、dirty0。NAS恢复文件与包文件inode不同，源和NAS收据完全相同。证据 [NAS-FINAL-VERIFIED.json](NAS-FINAL-VERIFIED.json)。
- 本轮是停写合成库导出，未执行在线BackupAPI全量备份，不代表成熟混合性能。私有源文件已迁入只读spool并记录回退方法。测试封装启动失败均保留，最终源/NAS代码按SHA核同。
- 真实1小时归档传输拒绝已于11月18日00:27:50.011 CST启动，最早01:27:50.011恢复。50模拟身份继续HTTP写入、持久队列与导出；只隔离此任务的SSH端口，生产保护每5秒读取ready，5GiB空间底线。完成后仍需独立核源/NAS全账，不能提前写通过。这是1小时小流量子项，实际恢复尚待核验。
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
