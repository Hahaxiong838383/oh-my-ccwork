# P003 埋点容量优化（2026-10-13）

用户已授权按同配置定位、写入优化和错峰建议推进。真实设备上传保持关闭；不修改端侧包、不启动语音测试，不购买或迁移服务器。

## 基线与验收

- 已部署运行源 e0585c1e，文档 HEAD 572f7f6f；生产 64 MiB pager / 10 秒 checkpoint / FULL / 256 MiB WAL 准入上限。
- 原失败回执保留：32 MiB/10秒完整 84000 条但时延失败；64 MiB/1秒仅确认 50400 条，时延与完成度失败。
- 使用原 HK 隔离库、固定假凭据和假设备。保留现有数据、seen、旧报告；同库增长后的新基线不能冒充完全等量 A/B。
- 原目标不变：14×30×200=84000条，P95≤500ms，P99≤2000ms，RSS≤256MiB，原3001健康P95增量≤50ms。成功批次时延与重试总耗时分别报告。
- 完整性将修正为唯一测试事件的 accepted+duplicated ACK 与数据库对账，保留两种计数；已提交后 ACK 丢失而重放命中去重，不应被计成数据丢失。

## 实施顺序

1. 记录当前源码/进程/容量，备份隔离测试的入口与环境文件；将隔离 checkpoint 恢复到生产10秒。
2. 启用仅限隔离入口的数值SQL分段诊断，读取操作系统磁盘/CPU等待，跑完整同配置基线。
3. 依据耗时占比做最小改动，先建立失败回归；不降低持久性、不以增加超时或改变指标替代优化。
4. 原完整负载复验，必要的重放、提交失败和进程中断测试；验证维护任务重叠。
5. 通过后逐文件备份与关闭状态部署，仅重启 analytics；核源码、权限、原服务和三重关闭状态。更新回执、联调与记忆。

## 服务器建议依据

当前只读实测2 vCPU、3669209088字节可见内存、40GiB系统盘、约16.4GB可用，无swap；主机共享多项业务。实例产品及云盘类别需进一步核验，`lsblk ROTA=1`不能判断真实云盘介质。先根据实测提交、I/O等待和容量增长选择独立数据盘/分机，不凭事件总数直接购买高配机。

后续实测与回滚锚追加在本文件，详细数值放私有证据目录，不写凭据或真实设备标识。

## 本轮证据锚

- 实例加固元数据核验：`ecs.e-c1m2.large`，`cn-hongkong`；仅请求类型和地域，未读取RAM凭据。
- 隔离库与入口/环境备份：`/opt/p003/analytics-staging-20261013/capacity-preprofile-20261013T054709Z`，完整manifest核SHA；DB814215168字节、WAL7436632字节，保留原库，不重置假设备身份。
- 新基线：`evidence/capacity-baseline-64m-10s-20261013/`；运行源码与生产一致，仅隔离入口增加无事件内容的数值SQL计时，按原14×30×200负载。旧失败证据不覆盖。
- 测试统计修复回归：真实SQLite先持久提交后丢ACK，再重放得到duplicated，RED后GREEN；检查唯一ID及raw/seen增量，不改变任何时延目标。

## 实测定位与被否定的方案

64MiB/10秒/FULL同配置基线仍失败：ACK确认11000条、数据库实际新提交12800条，P95 5659ms、P99 9734ms；13次代理503兜底、2次隔离就绪探针超时。不能将已提交但未收到ACK的1800条称为丢数据。原3001健康P95增量2.70ms、RSS186228736字节过门槛。

慢窗口磁盘忙度约99%、CPU iowait最高约98%，实际CPU计算约1%–6%、steal为0；IOPS长窗口约2118–2138。SQL计时中fact约51.6%、seen约15.8%、settlement约17.7%、COMMIT约14.2%。该轮主瓶颈是存储等待，不能沿用早期串行样本“COMMIT占57%”推断全部负载。

合并提交ABBA隔离实验：每组20批×200条，group=1耗时11851/6343ms，group=4耗时21850/13420ms；未证明获益且出现更长事务。不采用该方案，不修改ACK耐久语义。新增16000条假数据完整保留。

## 最小索引布局实验

fact唯一索引从`dimension,day,device_key,id_digest`调整为`dimension,day,device_key,received_at_ms,id_digest`，使同设备、日期的新事实集中在接收时间尾部；表本体仍按rowid存储，不称为无随机I/O。对应rollup按同键流式遍历，command_failures同分明确按command/error_code排序。

新键自身唯一性弱于旧键：同ID不同接收时刻可共存。当前摄入仍先在同一事务中通过seen与raw唯一约束判重/冲突，后写fact；不能绕过摄入路径直接补写事实。保持九列、rowid、14/90天保留策略和FULL不变。

迁移仅由显式CLI执行，不在服务启动时自动重建。事务内逐rowid九列比较和总数校验后换表；异常回滚。CLI先只读检查目标，再写连接，拒绝无rowid/未知列/附加索引或trigger。回退代码兼容九列INSERT；旧rollup可能多一次排序，回退保持上传关闭，不还原旧整库覆盖新写入。

迁移前隔离库备份：`/opt/p003/analytics-staging-20261013/capacity-prefact-20261013T061645Z`，DB877973504字节，SHA256 `5238297a8a3a9c12526ceaa7396190b8a1ff00f5e6f0b943482033832d5c9cb9`，raw/seen392700、batch2007、fact785400。逐文件备份及SHA通过，停隔离三个端口后操作，生产未改。

本机新增回归已通过：有序汇总无临时B-tree、迁移损坏与DROP后失败注入、九列/rowid/其他表不变、重放/冲突/事务失败、原始数据过期后去重与迟到重算、90天TTL、旧INSERT兼容、同分前100稳定；CLI误指向其他业务库的日志模式保持不变。原10组analytics回归通过。

隔离实机迁移结果：785400条fact，21.989秒，changed=true。迁移后与上述备份对全部10张analytics表逐行流式计算`rowid+全部字段`SHA，行数与SHA全部一致，`quick_check=ok`；不是仅比较总条数。独立复审发现的CLI误目标先改WAL、WITHOUT ROWID误识别两项均已RED/GREEN修正并复核关闭。源码四文件与本地SHA一致。

新布局完整负载仍使用原14×30×200、5分钟deadline、2秒批间隔、256MiB RSS上限及FULL/10秒checkpoint，开始前不清数据或seen：

| 假库连续增长中的实验 | 完整ACK/数据库对账 | P95 / P99 | RSS | 含退避总耗时 | WAL压力503 |
|---|---:|---:|---:|---:|---:|
| 新索引64MiB | 84000一致 | 3597.56 / 6296.66ms | 201175040B | 138.75秒 | 56 |
| 新索引96MiB | 84000一致 | 1259.31 / 2781.53ms | 229142528B | 166.48秒 | 120 |
| 新索引128MiB | 84000一致 | 665.39 / 1847.42ms | 280072192B | 155.16秒 | 109 |

三轮均无代理超时/actor失败/监控失败，原3001健康P95增量均约2.1–2.3ms。96MiB仍未过P95/P99；128MiB未过P95且超过256MiB RSS，不采用128MiB。不按成功200时延改善宣称总体吞吐提升：96MiB的退避次数、总耗时均更多。三轮库量不同，不能冒充等量冷缓存A/B。

64MiB新索引每84000事件fact SQL合计1483.6ms，原基线12800事件却为15972.2ms，随机事实索引已明显改善；新瓶颈在seen/settlement/COMMIT。96MiB事务P95194.66ms、P99545.38ms，与HTTP P95不是同一个分位样本，不能直接相减断言ACK排队根因。

新增同请求数值分段仅在隔离profile入口：独立客户端8400事件/42请求短探针，HTTP P9558ms，事务P9549ms，COMMIT→HTTP end最大1ms，无背压；短探针不替代完整容量验收。

随后原完整负载带trace：84000条全量ACK/raw/seen一致，153.411秒、84次WAL退避；HTTP P952678ms / P998475ms，RSS227336192B、原health增量2.508ms，仍时延FAIL。库raw/seen到737100、batch3729，所有假数据保留。

420个成功请求按同一request摘要关联（毫秒nearest-rank分位，与报告插值算法略异）：客户端发送→服务器request回调P952075ms / 最大8709ms，回调→事务P95192ms，事务P95436ms / P99924ms / 最大2791ms，COMMIT→HTTP end最大1ms，end→finish最大1ms，finish→客户端最大6ms。由此否定“提交后ACK被拖延”候选，不实施延迟ACK/槽位释放补丁；该候选RED测试移到私有实验归档，不作为已证实业务缺陷。同步SQLite使HTTP接入排队是下一验证点；不声称单一跨度能严格排除所有网络等待。

写入隔离设计与计划见`docs/superpowers/specs/2026-10-13-analytics-writer-design.md`、`docs/superpowers/plans/2026-10-13-analytics-writer.md`。方案仍在隔离验证，不降低FULL、不延长HTTP超时、不隐藏线程RSS、不改变原负载。PM2退出等待由5秒改35秒，仅容纳writer最多30秒的关闭流程，任务8秒仍无结果即拒绝ACK并关闭ready；迟到提交由后续客户端重放去重。

## 独立写入worker候选

本机原10组analytics与新增4组容量回归通过；实际SQLite锁等待期间主线程心跳、单槽拒绝、COMMIT时失败的五表全回滚、已提交后线程退出重放去重、messageerror/启动失败、clone失败释放槽、8秒job/30秒close期限均覆盖。主查询连接query_only且缓存8MiB，worker缓存96MiB；生产源码尚未更新。

真实HTTP重启回归先复现`UND_ERR_SOCKET`，把`closeAllConnections`移至writer drain之后转GREEN：停止接入时已派发事务正常完成并返回200 ACK，之后释放线程、checkpoint和连接。同步启动异常也清理已创建资源。全项目类型检查仍仅报告既存`race-llm.ts`三处`DeepseekLlmClient.abort`缺失，未声称全仓类型检查通过。

隔离代码回退锚：`/opt/p003/analytics-staging-20261013/capacity-prewriter-20261013T072238Z`，代码快照不包含数据库还原操作；现有假数据和凭据保留。候选v2包SHA `7366c37654a708ad2c0f891ed8f65563ab67ec2873b737f94f909e9c15bbeeee`，10文件逐SHA一致，07:22:50Z隔离ready=true/FULL2/auto0；此时启动RSS136048640B。开始完整负载，不能用启动RSS代替峰值验收。

发布工具已支持独立`--release-id`和整包SHA绑定；同ID异包在写目标前拒绝，保留旧完整manifest及CAS/锁/fsync。同包可幂等重跑，旧manifest无包SHA时拒绝占用原ID。19项发布和5项回滚测试通过；本轮若发布须使用新的capacity版本ID。

96MiB worker首轮：84000全部ACK/raw/seen一致，P95452.95ms/P99705.30ms/最大924.86ms、原health增量2.27ms，时延通过；RSS291733504B（278.22MiB）未通过，整轮FAIL。总耗时188.46秒、WAL503共94次、忙503共81次；退避与总耗时增多，不能把成功请求时延变短说成吞吐提升。新增数据保留，raw/seen821100、batch4149。

复审独立复现一个P1：structuredClone遇4000层坏事件会整批503，拖累正常事件。已RED/GREEN改为HTTP传原始JSON文本，worker JSON.parse后沿用结算，不重写深对象；4000/10000层混合批、同ID同内容/冲突均保持合同。原结构回归现用真实worker，全部10组再次通过。下一轮worker缓存64MiB，候选v3包SHA `4b921a3997ee46a680988698657e86ac37a702ba18c2f0ac7096dd839e0f6d00`，隔离代码回退锚`capacity-prewriter64-20261013T073005Z`，10文件SHA一致；生产仍未改。

64MiB worker与原JSON文本IPC完整验收：84000条全部ACK/raw/seen一致，P95408.378ms/P99553.772ms/最大670.3ms，整进程RSS251879424B（约240.21MiB），原3001健康P95增量1.970ms，189.604秒，205次503（忙141、WAL64），actor/monitor失败0，原全部门槛通过。退避及总耗时并未下降，不能称为吞吐提升。运行代码提交`2c086ae6`，仅本地提交未push。

随后额外维护重叠测试失败：同一进程不重启，原负载开始25秒后启动原rollup CLI；仅完成17000条/85批，14主体均耗尽8次重试预算，WAL压力503共111次。该次wrapper在90秒截断维护，不能把90秒说成生产预算（正式子进程240秒、systemd300秒）。原失败报告及空维护输出保留，不能因独立上传已过而放行。

已分段诊断：现有922360条事件、1844720条fact，同库单独TTL没有任何过期行仍在fact DELETE上耗时5429.66ms；其余TTL SQL均不到0.1ms。单独rollup两维均922360条，分别12449.68/4092.17ms、合计16.56秒，rebuilt=2/failed=0/dirty=0。两项独立运行不能单独解释重叠90秒，应保留争用场景复验。

TTL查询修正只复用现有复合索引，不新增写入索引：先取首dimension，再以`dimension>last`逐维seek，在维内用`dimension=? AND day<? LIMIT remaining`删过期行；每表额度仍1000、严格cutoff、空/未知维度也处理、seen不删、外层事务不变。专测以原实际DELETE的SCAN取得RED，修正后SEARCH转GREEN；五表跨维限额、边界保留、删空维度结束和中途失败整事务回滚均通过，原maintenance/ops/fact-layout回归通过。实机同库修正后整个prune profile含打开/关闭共4ms，最慢单SQL0.217ms，仍删0行；该次缓存状态与前次不同，不按5.43秒/4毫秒直接宣称固定加速比。

修正后原84000负载与维护重叠全PASS：P95454.186ms/P99809.460ms/最大999.071ms，RSS256286720B（244.41MiB），193.646秒，原health增量2.959ms；ACK/raw/seen全部一致，actor/monitor失败0。503共198次（忙104/WAL94），不冒称完全无退避。维护采用正式240秒子进程预算、CLI仅加stage数值计时：20.485秒退出0；两维各939160事实，分别15.203/4.943秒，rebuilt2/failed0/partial=false。

末库1006360条event/seen、5084批、2012720fact全部保留，stage三端口16:03前均已停。累积假数据已超过原1M facts/维度/日上限，但本次维护开始时939160未越界；未提高预算，不能把本次结果外推为超过1M的整日汇总验收。旧失败以及wrapper90秒截断证据保留，不能把独立5.43秒TTL断言为旧90秒全部原因。

## 生产关闭部署与恢复

2026-10-13 15:58:34 CST，仅analytics增量发布10文件，运行提交9b63e7e9135d667c807562fd1581b0ea04ce5a07，源码逐SHA复核。无新增依赖，生产package.json不改；PM2只更新analytics，35秒退出等待保障writer drain，未调整HTTP超时。fact显式迁移从digest-first-v1到received-first-v2，0生产行、FULL integrity_check ok；不是拿压测数据放进生产。

新快照`/opt/p003/server/backups/analytics-releases/analytics-capacity-predeploy-20261013T075722Z`：原5文件归档、forward/reverse包、state及私有新版apply工具；数据库在线一致备份118784B/SHA203fc7b4b43c07c2418e9c0af942f5b2f08c4fa997db392e948ca32efeca2414。正向包SHA06befd730422cd9a5b852abcc68ac5fa62ea66d6e9ba8db2061abb6b2d9a41a1；反向包c658bb87ceb11f7d85ab61a94b9deaeab3bdcea17633b5417fa01dce55fb81e1，5文件生产预检成功，未实际回滚。旧完整manifest保留，回退不恢复DB/seen，不重启3001；详见容量回退记录。

16:03:14生产复核：10文件SHA同、analytics PID2899018/kill35000；公司2817417/23、个人1626403/0未变；global false/0点、gray0、gatefalse，events/seen/batches/facts仍0。公网admin七GET200、未登录/无效凭据401、有效设备关闭上传JSON503/900、完整配置cfg-11不丢posture。两维护timer active，rollup/backup实际success/exit0，Studio异机LaunchAgent16:02:29实拉新1份、核2份成功。

私有数值证据归档`capacity-final-evidence-20261013.tar.gz` SHA6720e07d8e423875ff5efe71869c4bf602a9b4a0e2a865e6ce22591cd2014a1b，24文件全部逐SHA校验；Studio同时保存不含env的容量回退材料tar，SHA76a75a5bd4061eebc9ba85e22ee47ae20182a4cba09eff498167d0cafa18857a。真实采集、首台、午夜以及端侧重试时钟疑点仍待联合验收，未购机迁库。
