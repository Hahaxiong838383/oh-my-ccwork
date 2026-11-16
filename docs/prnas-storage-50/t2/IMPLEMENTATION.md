# T2归档通道：实现与当前范围

本切片对应用户“继续T2，先打通PRnas归档并完成断线续传验证”。基线bef0dea9；不启用生产归档定时器，不修改业务服务、设备范围、archive_enabled:false或当前四副本容量公式。

## 构成

- `scripts/storage-archive.py`：Python标准库的不可变包发布/受限SSH命令。目录pending→published采用同卷rename；文件/目录fsync后可列出。仅list/meta/read/ack，无任意路径/命令执行入口。
- `scripts/storage-nas-pull.sh`：NAS主动拉取单个内部ID。实际SSH进程按已落盘字节偏移读取不可变payload；全文件SHA/大小/条数校验后才确认。不是rsync append，坏前缀不会被当成成功。无需修改全局网络或经过Air搬运数据。
- `scripts/storage-nas-verify.mjs`：仅文件校验/落地。公司QNAP没有Python、flock且rsync3.0.7；复用现存Node22.19.0镜像（按digest固定）以无网络/只读根/非root/无capabilities运行，只挂载本项目目录。Analytics SQLite会独立检查integrity和清单各表count，总行数不是去重业务事件数。
- 成功ACK精确匹配ID、SHA、bytes、record_count，重复ACK幂等；确认不会自动删除任何源文件。临时包不列出，源损坏拒读；坏半包隔离后可从零重新取，正确半包按偏移续传。

## 运维边界

真实测试源：阿里云`/opt/p003/archive-t2-20261116`，完全独立于`/opt/p003/server`运行库与原备份目录。NAS目录：公司PRnas RAID1卷`/share/CACHEDEV2_DATA/p003-archive/t2-20261116`。均仅含本轮合成夹具、归档脚本、校验与回执。

NAS专用私钥留NAS，不进仓库。云端新增一条带forced-command且禁止转发/PTY/agent的公钥，只能读取本轮published包并确认；原authorized_keys已私有备份，回滚只能移除本任务精确新增行，保留并发新增条目。没有部署新的公网HTTP服务、开放NAS公网端口、复制旧.env或新增常驻容器。

NAS正常传输失败/信号退出自动释放任务锁。QNAP缺少flock，采用私有mkdir锁，宿主进程SIGKILL或NAS断电可能留下锁；本切片失败关闭，不自动强拆。下一步无人值守定时归档前须补受控重启恢复/监督逻辑；人工恢复必须先确认记录PID及同目录SSH任务均已退出，仅移除本项目残留锁。不能为自动恢复误杀其他任务。

## 不在本切片宣称完成的工作

原备份器的60秒、外层90秒、systemd120秒预算与keep2策略保持原样；本轮小规模Backup API用例不能证明90天成熟库预算。日7/周4自动轮换、未确认包阻止重复日备、两小时独立预算与定时器接管仍属T2后续。当前没有自动清理，所以未确认包不会被新通道删除，也不能直接将其长期接入现有keep2目录。

T3方舟检查点、T4成熟容量模型、T5五十台负载/语音及T6生产部署仍未执行。当前证明为合成数据的真实云端→NAS传输，不是所有真实设备已归档。

## 核心验收

本地真实文件测试：发布中断不可见、偏移边界、未知/错误ACK、路径/链接拒绝、坏包、并发锁、fsync失败后的重试、条数谎报拒绝。实机：64KiB小包与105811968字节SQLite包；终止真实SSH时保留34406400字节，下一次从该偏移继续；实际恢复数据库1600事件+1600seen、样本hash一致、WAL中的已提交数据保留，备份后新行不混入。

正式结论等待固定候选Grok复核及剩余失败注入证据，不以这份说明替代验收记录。

## 参考

[rsync官方手册](https://download.samba.org/pub/rsync/rsync.1)说明append适用边界，因此本轮不套用新版append选项；[Python SQLite Backup API](https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection.backup)用于一致性快照，未直接复制活跃数据库主文件。
