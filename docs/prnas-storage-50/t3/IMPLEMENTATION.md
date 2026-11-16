# T3 方舟快照历史归档

T3沿用已评审T3_HANDOFF，单SQLite事务＋独立Python导出器＋T2受限SSH与NAS校验，不新增服务或设备协议。当前仅候选开发和隔离验收；生产接管为T6。

- Ark accept在旧grant/时钟/乱序/duplicate检查后，同事务保存current与应留档版本。首次、300000ms、冻结关键字段变化触发；倒数/boot/序号噪声不刷新检查点基线。正常/GM/unknown及grant/epoch固定在封套。
- 新表ark_archive_baseline/outbox/batch/stats均增量建立，与360的ark_record/coverage/rate表分开。同库锁预算维持15ms；导出器短事务领取批次，文件/SSH不持Ark事务。
- 每包最多1000行且不超过1MiB；先持久批次映射和manifest，再写临时文件→fsync→发布原包ID。确认丢失与进程崩溃重跑同批。NAS校验封套、完整snapshot v1、每行body_hash、整体SHA、字节、行数、ID边界。
- 源端收到精确ACK后，重新核完整映射才删除源正文；轻量检查点保留。NAS只清理已确认且超过90天Ark包，独立于SQLite日/周保留。
- 默认archive_enabled=false；独立PUT /api/admin/analytics/storage/archive接收expected_revision/ enabled。规划数量PUT不变、修改任一项都使用同revision CAS。不会授权设备、修改verified profile或Analytics设备开关。
- 后台显示关闭/继续补送/待确认/导出异常及真实计数、最老积压、导出成功和NAS确认时间。没有确认保持null，不把导出成功说成NAS已到账。

## 预算口径

8GiB为Ark待归档缓冲，按每行(封套字节+1024)*3预留数据库/WAL/索引、生成及已发布文件的峰值。分配batch之后仍计入；确认并清理完成才释放。Analytics全库备份维持独立四副本模型，不占用这份Ark逻辑配额，实际磁盘还必须保留4.5GiB。两者共享磁盘的完整容量校准在T4，不能据本轮宣称50台生产容量通过。

只对本次需要留档但预算不足的更新返回503 archive_buffer_full + Retry-After:60，current/outbox都不变；duplicate/不需留档更新保持既有行为。关闭归档后停止新增历史，但独立导出器仍排旧积压。HTTP仅读取本地配置、磁盘与本地库，不探测NAS。

## 运维入口（T6才安装调度）

`python3 scripts/storage-ark-export.py --db /absolute/ark.db --root /absolute/spool`

一次最多20包，无常驻循环。复用T2 NAS周期与受限SSH入口；不新建另一套备份任务。导出器不得指向完整游戏存档或修改用户权限。保持现有归档卷标记与镜像固定验证，不重启共享NAS。

## 会话360兼容边界

会话360固定5d24359d：两个摘要/184条历史对话已上线；修复使用时长APK与微信实机验证仍待。R1新流水客户端合同不兼容仍关闭上传。本树不能整树覆盖360或生产，routes/telemetry.ts、routes/ark.ts与records-*必须保留其新增功能。T3与360重叠验证在独立归档副本，不改360分支。T6发布前再次核上线漂移。
