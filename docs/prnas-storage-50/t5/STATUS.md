# T5执行记录（2026-11-17）

状态：IN_PROGRESS，不是T5通过；不部署存储功能，不提高已验证档。

基线27c93331；rollback/p003-prnas-t5-pre-20261117指向该提交。会话360已读最新HEAD53239abe（前序业务0cb21475），Worker后台小程序Dashboard预览已完成且待评审，未部署；不整树合并或改其业务文件。

云端预检：free 13,175,631,872B，MemAvailable 2,241,624KiB；三PM2在线，PID/restarts与T4一致；无旧T5 unit。证据在私有 /Users/fu-121/.local/state/p003-prnas-t5-20261117/PREFLIGHT.json。

工具scripts/storage-capacity-load.ts：固定种子、参数化身份/事件/<=200组批；loopback真实HTTP、writer/checkpointer、Ark POST、统计及Backup API子进程。合成身份与一次性token；拒绝生产路径及复用目录。全部失败重试和延迟落盘，不用health冒充真人语音。

首轮夹具相对cwd路径错误已修为模块URL，并补client失败证据；原失败保留。
本地2×201=402事件4批200，1次503按合同重试后完整对账，Ark2/2。混合2×600=1200事件6批200，1次503重试，实际统计dirty0、备份退出0、Ark2/2。三身份含非满批复验另见mixed-smoke-02。本地结果仅工具预检。

Ruling：先在现有云盘可承受的小库做50身份日批，不缩减最终T5矩阵。44.87GB成熟库需要足够隔离盘与目标IO，不能放进现役40GB卷；资源前提仍待解决。不得用本地或NAS快盘替云端验收。
Ruling：复用createLoadAccounting精确ID/seen对账，accepted与duplicated都可完成，ACK分区必须完整且不交叉。短时可重试503不隐藏，端到端排空和ACK门槛分别考核。

尚待：50×6000统计维护失败的修复及复验、600k批次、成熟维护/锁p99、Ark实际Brain查询deadline、NAS恢复/72h积压+1h断线、语音AB各50轮、24h耐久、完整回归和Grok固定候选复验。

并行时间查询：Grok会话369，task 0de071fd-a969-4d4b-a4b3-1f1e92c83c5d，只读调研/历史语料/词库；主13实现并交叉验证后单独部署，不携带PRnas未验收改动。

2026-11-17 后续：50×6000首轮ab88de96已完成，上传精确对账/ACK指标通过，但最终统计dirty=1，整体FAIL，证据084eee66已push。冷缓存对照full45.66s/narrow45.54s/grouped44.28s；rowid重排33.75s仍超过30s，不宣称解决。重排实验未达标，已撤回rollup.ts运行源码；保留3个交错设备/查询形状测试改进。profile04已完成，详见下一段。

实验结论：profile04完整成功。仅索引COUNT冷读10.63s，整张新鲜夹具顺序扫23.56s（不适用于90天成熟库），定日rowid重排33.39s仍不达30s。单纯缩列、SQL聚合、rowid重排都没有完成修复；同等冷处理下索引回表/存储读取成本是明确瓶颈，不能从暖缓存4秒外推生产。rowid实验已保存patch并撤回运行源码，保留交错设备和不依赖SELECT*字样的测试改进。后续需合适的隔离盘/IO资源，必要再比较有界按日布局方案，不以扩大预算冒充性能优化。

最新冲突复核：会话360于本次回读已恢复in_progress；HEAD仍53239abe，正在未提交地修改device-registry/pairing/parent-conversations/admin-data/profile/telemetry及admin/index.html，并新增miniapp-dashboard/miniapp-admin与测试。PRnas树未修改这些现有业务文件；T4后台admin/index.html与其后续成果存在集成重叠，T6须逐段合并，不整文件覆盖。当前阶段未操作其工作树。

压测/分析结束只读复核：7项受保护线上文件SHA未变，3个PM2进程PID/重启次数/online与开工一致，剩余12,340,690,944B。证据POSTLOAD-PRODUCTION-GUARD.json。没有将未通过的统计实验或容量配置部署生产。

覆盖索引实验：复制合成库，原表及生产不改；同等缓存处理原查询前/后47.392/47.394秒，cover occurred/received4.620/4.517秒，全部30万结果SHA相同。索引新增178,515,968B（60万facts）；真实原版rollup无需代码修改即可由优化器选cover，两维合计7.394秒、dirty0、100设备日每个6000，raw/seen/facts前后完全一致。读取优化有证据，但写入/TTL/成熟空间与混合耐久尚待。负载工具仅新增T5_COVERING_INDEX=1实验开关，在新建合成空库且writer启动前建索引；未增加任何生产启动迁移。2×601、部分批ACK/Ark/维护/备份smoke通过，1次503按合同重试。下一轮50×6000带cover混合负载待运行。

覆盖索引混合轮已结束：固定a3f2b982、50合成身份×6000=300000条/1500批全部精确入库，544.148秒；ACK P95/P99=395.00/1088.17ms，全部2770次503退避保留；Ark50/50、三轮维护exit0、最终dirty0、备份exit0、checkpoint无失败/超时。unit inactive/exit0。仅新鲜日批混合子项通过，覆盖索引未进入生产schema；成熟库/TTL持续净回收/600k/语音/24h仍未验，T5整体未完成。
会话360最新本地HEAD35b67d5e，已有10文件小程序后台发布成功回执；前文“未部署”是历史状态。后续T6须重新建线上基线。
