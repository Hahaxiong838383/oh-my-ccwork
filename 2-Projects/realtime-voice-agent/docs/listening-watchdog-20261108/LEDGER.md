# 执行记录

- 起点22ab1c31（运行50bac0b2）；rollback/p003-listening-watchdog-pre-20261108为本轮回退锚。未修改生产。
- 05:13 CST重新读三池实际PID/二进制：与前轮上线一致；倾听jobs0、cleanup healthy、queue0。PRODUCTION_BEFORE.json为直接证据。
- 预构建红测：第一次helper抽取维持旧行为，但测试插入锚未匹配，所以665仍通过，只作基线。修正插入后 watchdog-prebuild-red2 确认617过/1失败：卡住prebuild阻塞200ms事件循环期限。随后将等待放进拥有生命周期的pipeline任务，取消释放资源和一次fallback测试通过。
- 主池按hunk移植，保留本树搜索/倾听/HTTP2/连接恢复差异；缺省未开启不触发业务回收。三个新模块来自主池b911运行源，room_cleanup保留候选schema1，不引入主池schema2。
- 倾听缺失hold红测：657单元+29核心通过，runtime新增两条失败；加入真实lease/session/entry绝对期限后第一轮完整710通过、2既有ignored。
- 裁决：显式proposal/pending/Entering是已有3s/3s/5s协议期限，值得保护至其原期限，不能因普通5s idle先到而抢先终止；不是依靠active布尔续期。Runtime lease另受15s租约/30分钟上限，退出/撤权/Paused不延长。
- 裁决：显式退出（含原有按钮合同）是一次真实用户输入，应从实际接受时刻留一个原签名idle区间；重传/查询不得续期。新accepted_exit测试在None旧行为下失败，正在补齐原时间锚。
- 05:19 CST直接查主Brain当前数据库：仅02000053配置voice.session_idle_timeout_ms=5000/rev139；038无显式策略。主Brain当前源码已从effectiveSnapshot签voice_idle，未配置时省略。不能只发二进制就宣称038强制回收已启用。
- 未验：真实RTC组合路径、正式构建/ABI、Grok最终固定候选复核、单038配置与发布、真实Android。当前不可发布新watchdog候选。

- watchdog-green2完整712通过/2既有ignored；81个编译输入与当前工作树逐项SHA核同。显式退出原时间锚已补齐，并在每个pipeline事件结束更新倾听活动，重传/查询不会续期。尚未执行新候选真实RTC和正式构建，不部署。

- Grok188设计评审已完成，见原报告与GROK_ADOPTED.md。采纳租约-only及清理最小化，替代前文proposal/pending hold裁决；新反例在旧527上失败。527观察RTC真实三通道/20s倾听静音/退出/idle observe/RoomGone通过，但该候选已被替代，不部署。

- watchdog-green3完整707通过（654单元+30核心+13运行时+10语音）、2既有ignored；80个编译输入逐项SHA核同。较712少5项因删除不采用的room_verify模块及其测试，并非忽略失败。新候选只保留权威租约保护和原schema1清理；正式产物与强制回收RTC尚待验。完整红测日志已归档，未以截断输出替代反例。

- 最终业务候选85de8fb077a8d455c0ba9e2f4b29e08913820ef5已commit/push/ls-remote核同。707完整回归、6隔离真实RTC通过；正式636b1c3d、测试f657bc2d均核80输入。Grok190独立读证据/源码给出范围内PASS，189偏离只读任务而取消，未用其进展代替终审。
- 05:58:27–05:58:38 CST仅倾听池发布，正式PID3593294/NRestarts0/cleanup健康；其余两池保护文件/状态不变。05:59:04 Brain manifest更新85de，仅build/evidence_ref；名单/expiry/source_generation/倾听rev6保持。
- 标准API仅038新增idle5000，实际cfg140；初验脚本误把voice_control合同对象当bool导致断言失败。未重写配置，按真实version/capability合同修正只读核验后签名/响应/配置均核同。端侧应用未观测，未连接真实设备。
- 上线正式进程的合成SN探针失败：无canary元数据且SN不在既有名单，active=0时被job_allowed拒绝，尚未assignment；原FAIL/清理记录保留。这不是线上音频性能证据；范围未扩。另用同正式二进制的隔离进程补测正常语音，待结果。

- 正式产物两轮隔离补测2/2通过：相同636b运行字节，普通/ordered输入就绪534/495ms，可听音频4710/4720ms、字幕及三项metrics齐全；测试客户端断开后服务端删房，FFI订阅0。不是生产单038实听。最终06:09同PID3593294连续665.64秒无重启/ERROR/Panic，health jobs0、清理0，Brain ready/名单/期限/源码/PID均核同。
- 单机发布回执已送Air Downloads并核SHA；详情见RELEASE_EVIDENCE.json与回执。后续仅真实038复测、灰度观察；独立Search池本轮未发布。未声称整个历史DNS/TTS故障全局收口。
