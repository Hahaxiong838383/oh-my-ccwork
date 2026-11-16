# T2运行与T6接管准备

本轮仅隔离验证。生产应用、设备名单、23点上传及原备份timer未切换；以下生产接管步骤属于T6。

## 运行边界

云端复用现有Python3与Node24。NAS宿主Python2.7/fcntl仅监督锁，宿主SSH单路定偏移续传；校验使用已固定Node22.19镜像，每次短时容器，无网络、非root、1.5CPU/512MiB、2小时硬终止。新Python3测试镜像只用于90天夹具和恢复，不是生产依赖。

归档ID/manifest不可变；失败重试同ID；云端未知包拒绝ACK；NAS先完整SHA、字节、SQLite全部表计数与integrity校验并fsync后确认。NAS日7/周4为CST不同日/周各取最新，取并集；轮换先恢复最新备份，失败不删其他完整份。Ark包不进入此轮换。

锁使用不删除的常规文件+kernel flock。Supervisor与传输shell继承锁；传输主体结束时清理其专属进程组。校验容器自身另持flock，Docker客户端结束不会让遗留校验无锁运行。卷marker不存在/不匹配/跨设备时，在创建锁前拒绝，不在卸载后的宿主空目录继续写。

## T6最小安装顺序（届时重新核线上漂移）

1. 核准数据盘、spool、NAS卷与项目预算；源Backup API路径与实时库必须独立。先制作当前一致性备份并恢复验证，不裸拷贝在线SQLite。
2. 按固定候选逐文件发布归档脚本及service，保留before SHA；准备受限SSH list/meta/read/ack和已验证host key，复用专用key，不输出或传群。服务私有配置不得提交Git。
3. 停原单个backup timer，等待该服务结束。创建仅含绝对路径的私有`.env.archive`（ANALYTICS_ARCHIVE_ROOT），安装`p003-analytics-backup.archive.conf.example`对应drop-in。`analytics-archive-maintenance.sh`要求该变量，缺失立即失败，不能静默走keep2。不得另建第二个并行全库备份timer。
4. 云端一次手动oneshot，观察building→published；只有NAS确认后才是异地恢复点。备份单独锁，不占rollup锁；Python≤7200秒，Node7220秒，service7260秒（含20秒锁等待）；Restart=no，失败下次调度重试。
5. NAS准备私有wrapper，准确变量名为`ARCHIVE_ROOT`、`ARCHIVE_CODE_ROOT`、`ARCHIVE_VERIFY`、`ARCHIVE_SSH_CONFIG`、`ARCHIVE_SSH_TARGET`、`ARCHIVE_PYTHON`、`ARCHIVE_VOLUME_MARKER`、`ARCHIVE_VOLUME_ID`、`ARCHIVE_DOCKER`、`ARCHIVE_NODE_IMAGE`。本NAS的监督解释器是`ARCHIVE_PYTHON=/usr/local/bin/python`；其余路径、专用SSH别名和镜像SHA在T6逐项回读，不使用省略前缀的变量名。wrapper调用storage-nas-cycle.sh；ARCHIVE_VERIFY指向调用storage-nas-verify-container.sh的私有可执行wrapper。调度每5分钟即可，循环单包传输；20包批次上限，忙则exit3，禁止并发叠加。
6. 真实一个包归档、断线续传、隔离恢复通过后，再恢复原云端每日backup timer及NAS项目自己的调度项。NAS调度安装和重启持久性按该机QTS实际方式验证，不改其他项目crontab。
7. 日常显示backup-status.json、cycle-status.json、retention-status.json；最后成功应按备份捕获时间，断线持续增加实际年龄。健康链路RPO目标24小时；断线不承诺24小时。未知保持null。

原keep2目录本次不删除，容量四副本系数保持。T4核实实际峰值与历史目录处置后才与公式同批调整；不能先降容量系数。T3还须把StoragePolicy持久配置连接导出器和后台状态，目前这些文件是任务状态接口，不是已上线后台页面。

## 故障处置

- pending/waiting_for_nas：先修NAS/SSH/空间，重跑同包；不反复生成新整库填满云盘。
- CHECKSUM/SQLITE/COUNT错误：包进quarantine或拒绝确认，源仍保留；查证后重新拉取，不覆盖最后好备份。
- 超时：停止本任务进程组；保留旧已完成备份及ready标记。未完成自身partial下次清理；ready存在则完成同一不可变包。
- NAS离线：只读源业务继续，状态显示实际年龄；T3另做outbox预算背压，不能把备份等待当成业务历史无限存储保证。
- 共享NAS整机硬断电/重启本轮未执行；已用真实SIGKILL、孤儿写入、容器重启/锁回收和fsync故障注入核恢复边界，不以此冒称硬件断电测试。

## 大库试验的进度解释

本轮固定测试镜像实测为Python SQLite 3.40.1、Node 22.19.0 / SQLite 3.50.4。前者在integrity_check内部B-tree扫描期间不会持续触发VM进度回调，backup-status可能暂留上一条copy进度；不能仅凭状态不动判定死锁，也不能凭目标文件已达到源大小判定备份成功。结合本任务PID的读写计数、打开文件、外层截止及最终退出码诊断。不要全局重启NAS或修改数据库来刷新进度。

完整验收必须等待published、NAS独立校验及隔离恢复对账。程序内预算和外层进程超时同时保留；一次小库成功不能代替成熟库耗时结论。未来若只修阶段显示，应在进入PRAGMA前显式写入阶段，不能靠改显示缩短或跳过完整性检查。
