# T2 completion回滚记录

源码前锚：rollback/p003-prnas-t2-completion-pre-20261116 → ac476d3c55d6d708bc49536ba4348870541419b0。

本轮只修改专用树代码、隔离测试目录及临时测试镜像/容器。未发布生产应用、未改变设备授权/Analytics开关/23点日批、未覆盖业务数据库。当前不需要回滚现役应用。

## 隔离任务停止与回退

1. 按本轮证据记录的精确容器/单元ID停止本任务。当前成熟库生成容器为`p003-t2-mature-fixed-20261116`，验收容器为`p003-t2-mature-acceptance-final-20261116`；旧`p003-t2-mature-20261116`等是已停止的历史测试。云端隔离服务只操作本轮`p003-t2-isolated-backup-*`的已核具体单元，禁止按全局python/node/ssh进程名杀进程或重启整个NAS。
2. 保留PRnas t2-complete-20261116与云archive-t2-20261116的spool、manifest/receipt、partial、测试日志。候选代码替换前的副本在云隔离目录rollback-t2-complete。恢复源码需检查目标仍为本候选hash；漂移则停止覆盖。
3. 源码采用反向提交或另树检出回滚标签，不reset其他会话、不删除工作树。测试镜像暂存供复验，不自动全局prune镜像/卷。
4. 未确认payload、Ark包、业务DB及永久seen一律不删。恢复演练只写新隔离路径，不能回灌线上库。

## T6以后生产回退准备

先停归档timer/导出器，保留所有已接受outbox和包；恢复上一兼容脚本、service/drop-in（逐文件hash守卫）。T3新表保留，不能用旧库覆盖。恢复legacy keep2前重新核云盘空间及未确认spool峰值，不与新备份任务并跑。停归档不影响本地最新状态/语音读取；必要业务背压遵循当时已发布合同。
