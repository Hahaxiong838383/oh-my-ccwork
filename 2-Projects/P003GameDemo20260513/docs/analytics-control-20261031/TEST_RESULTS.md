# 埋点控制与方舟接入验收

2026-10-31，Codex 主实现与执行；只读辅助评审。候选基线647285fc，现役普通Brain基线0708d768。

- Analytics原有10脚本、capacity 5脚本、control专项2脚本通过；涵盖CAS、事务故障回滚、容量不可用可关闸、首次接管不得绕过容量、异常策略关闭、在途撤销、超时释放槽位。
- 方舟49项专项通过（知识4、状态16、历史11、runtime7、HTTP/SSE7、proxy4），另P2代理service身份/普通聊天零查询1项通过。
- 浏览器真实Vue/Element Plus挂载38项通过：筛选/多选/容量拒绝/保存/关闭/离线提示/停用已选移除/GET期间禁编辑/方舟原子授权与预览互斥。API用桩，不写生产。
- Device Brain29、旧KB6、device-config36、memory-extract15及倾听RTC隔离预检通过。
- P2按现役源码三方合并，保留searchDialogueHistory、searchTermExplanation和取消逻辑。合并后真实本机Ark HTTP/SSE7、proxy service1、search-dialogue1、R20 5、chat-abort3项通过；未以普通Brain整树覆盖P2。
- 20台隔离补传：600批×200条=120000条，全量唯一入库，约151.5秒，P95 65.52ms/P99 218.80ms，RSS254.16MiB，153次受控503全部退避恢复；同步执行汇总维护，主健康P95增量2.465ms。详见LOAD_TEST.json。只有health探针，不是真机音频质量证明；本轮未做备份与补传同时运行测试。
- 隔离进程已停止，证据已归档；只清本次合成analytics库，未清业务库或旧证据。

全量tsc仍有12条已确认基线诊断（listening-content和amap-weather），本次没有新增，不能称全量类型检查通过。现役主分支的部分搜索测试已有基线问题；P2本次涉及的实际路径已用现役合并副本回归。

尚待端侧：真实串行重试/23点到账、安卓权威快照、真机语音回答与跨设备验收。合成测试不冒充真实设备数据。
