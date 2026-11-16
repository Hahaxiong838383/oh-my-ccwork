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

11ef01ec补齐：实际空闲门槛保守计入全部队列预留＋新行预留＋4.5GiB，不仅检查新行。可能已有部分正文落盘而重复预留，宁可提前背压；不把此系数当T4实测容量。导出前再次检查目标卷空闲，至少保留4.5GiB＋本包字节＋64KiB元数据余量；其他任务占盘后会暂停新文件生成，已确认包仍可清理释放。运行中其他进程无协调抢占磁盘无法由本模块原子预留，I/O失败仍保留不可变映射并重试。

4ea6af5a补齐：最多20个已有批次中，某个未发布批次磁盘不足时先记暂停，继续处理后面已确认批次，之后仍返回导出失败告警；避免UUID排序让较晚收到确认的包无法释放空间。仅跳过明确的低磁盘错误，错误回执、内容不一致等仍立即拒绝。

只对本次需要留档但预算不足的更新返回503 archive_buffer_full + Retry-After:60，current/outbox都不变；duplicate/不需留档更新保持既有行为。关闭归档后停止新增历史，但独立导出器仍排旧积压。HTTP仅读取本地配置、磁盘与本地库，不探测NAS。

## 运维入口（T6才安装调度）

`python3 scripts/storage-ark-export.py --db /absolute/ark.db --root /absolute/spool`

一次最多20包，无常驻循环。复用T2 NAS周期与受限SSH入口；不新建另一套备份任务。导出器不得指向完整游戏存档或修改用户权限。保持现有归档卷标记与镜像固定验证，不重启共享NAS。

## 会话360兼容边界

会话360固定5d24359d：两个摘要/184条历史对话已上线；修复使用时长APK与微信实机验证仍待。R1新流水客户端合同不兼容仍关闭上传。本树不能整树覆盖360或生产，routes/telemetry.ts、routes/ark.ts与records-*必须保留其新增功能。T3与360重叠验证在独立归档副本，不改360分支。T6发布前再次核上线漂移。

收尾时再次核对360：HEAD推进4b5e1eb287b34d030df387d727dca79746067ad9，与5d24359d之间仅7份文档/技能变化，运行源码等价；会话正在继续mini009最小服务端兼容开发。不能用本轮固定源码测试担保尚未提交的新适配。其方向已改为服务端已知格式适配＋Native稳定scope小修，不能沿用“必须端侧全面重做协议”的旧结论。

复验脚本见compat360/run.py：从固定360提交归档；仅覆盖7个T1/T3模块；逐字节保护records四模块、telemetry路由、挂载records的Ark路由、parent-conversations。测试夹具显式提供50模拟身份的已验证额度，并开启隔离归档。dashboard断言按T1既定规则修正：删除ENV不等于撤销已存在grant，实际grant撤销才不可见。原360生产源码与分支均未改。最终33条records（含同库并发导出）＋15条summary＋15条history＋16条dashboard全部通过。

```sh
python3 docs/prnas-storage-50/t3/compat360/run.py \
  --repo /absolute/worktree --candidate 4ea6af5a \
  --node /absolute/node24 --out /absolute/new-disposable-directory
```

## 验证边界与首次失败记录

- 生产同版本Linux Node22、Mac Node24均复跑专项；后台真实Vue/WebKit挂载57断言通过，但不是线上管理页验收。
- 实际阿里云隔离库→既有T2受限传输→PRnas独立T3目录：50模拟身份、50条、41755字节；NAS独立读回余额1..50、身份50个、完整SHA相同，ACK后outbox=0、current=50、baseline=50。它证明真实链路，不证明50台真实设备容量或游戏完整存档恢复。
- 生产保护文件hash、三个PM2 PID/重启次数前后相同；未触碰设备配置、R1开关、主服务、生产归档调度。
- 全仓tsc仍12项既有错误，输出与T1基线字节一致，不声称全仓类型检查通过。
- 360首次隔离测试因缺T1额度夹具、旧ENV撤权断言失败，按上述合同适配后通过。并发夹具首次因macOS /var临时路径未resolve触发Spool符号链接防护，修正测试路径后通过，未放宽业务检查。
- Linux暂存脚本首次把固定SHA占位替换误作用于base64导致SyntaxError；NAS首次探测因暂存尚未完成而缺候选目录。均未进入业务写入；修正脚本顺序、按依赖串行后重跑通过，私有原失败证据保留。
- 磁盘累计预留新增反例在74482851真实失败，11ef01ec修复后通过。其他阶段的容量/负载承诺仍留T4/T5。
- 跨批次低磁盘清理反例在11ef01ec失败，4ea6af5a通过。新增用例首次把已清理包也计入Spool.list，预期3实际2；按既有“只列仍有正文的包”合同修正断言，未修改T2 list。
- PRnas固定Node22.19.0容器、1.5CPU/512MiB限制下，10000份合成元数据清单筛选20项535.49ms；一轮GC删除100项8279.68ms；RSS60407808字节，未确认包均保留。这是元数据扫描测量，不是10000份真实归档或50台生产负载；更长期体量及维护净吞吐留T4/T5。
