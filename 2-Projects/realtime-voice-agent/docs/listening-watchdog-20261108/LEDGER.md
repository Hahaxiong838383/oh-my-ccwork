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
