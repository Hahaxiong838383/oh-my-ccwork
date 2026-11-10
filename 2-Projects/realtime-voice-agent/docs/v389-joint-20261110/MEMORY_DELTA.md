# v389 共享记忆脱敏增量

仅保存本轮新增内容；不包含其他项目或整份共享记忆。原字节备份位于私有 state 目录，不随 Git。恢复时逐条合并，不能覆盖共享文件。

## RECENT_EVENTS.md

## 2026-11-10 · [p003-v389-recovery-20261110] P003 v389恢复回执复核与知识归档：15条历史trace、17job无交叠，7独立SDK场景/10次执行通过；保留首夹具失败与受影响复验。纠正垫句SourceDrained冒充正文TTS、设备participant冒充Worker替换、connect_end冒充input_ready及cleanup口径；历史no_final和Android四故障仍待验。证据7b6f866d已push，Air最终回执SHA f044d5ad；当前仅记忆/voice-agent-ops更新，不改生产。[复盘](/Users/fu-121/.codex/worktrees/p003-voice-input-routing-fix-20261110/2-Projects/realtime-voice-agent/docs/v389-joint-20261110/RETROSPECTIVE.md)

## memory-items.md

- ★★★ [project/P003-v389服务端恢复复核] [p003-v389-recovery-20261110] 2026-11-10核验15条11/6历史trace，17个完整job同PID区间无交叠；正式二进制私有SDK共7场景/两轮10次执行通过，结论SCOPED_SERVER_SDK_PASS_ANDROID_PENDING。cf3c3208正文provider首PCM0且建连10001ms超时，垫句/搜索回执播放不抵消失败；03a2d982另有2次超时但此前有PCM；e4d3ae97有49920样本而无final，原因未定。安卓四故障、同房Worker更换/旧轨拒绝、突然崩溃孤房、candidate准入仍未验。11/10取证主池源1481072/binary8a953489、倾听fd3ad604/517f5290；不能倒填历史。未改生产，测试已停止；原证据提交7b6f866d已push，回执已到Air Downloads。[复盘](/Users/fu-121/.codex/worktrees/p003-voice-input-routing-fix-20261110/2-Projects/realtime-voice-agent/docs/v389-joint-20261110/RETROSPECTIVE.md) [2026-11-10] #P003 #验收边界
- ★★★ [feedback/P003语音成功分层] 客户端FINAL_AND_ANSWER/字幕、SourceDrained或body首帧均不能单独证明正文TTS成功；可能仅垫句/搜索回执。按同轮providerPCM、播放轨及实听分层核验。resolve_tcp无细分不能唯一归因DNS/TCP；有采样无final不能说没收音；CaptureFailed须与abort/cancel按时序核对，不能倒置晚到cancel为原因。 [2026-11-10] #P003 #日志归因
- ★★★ [feedback/P003实体和计时对齐] trace先映射历史签票/agent，room name与Room SID区分；无键ASR/TTS先核全部job区间互斥。process exiting可能仅job退出，不能当daemon重启。设备dev参与者换SID不等于Worker agent换SID，新房恢复不等于同房热迁移；connect_end不等于input_ready。 [2026-11-10] #P003 #关联键
- ★★★ [feedback/P003隔离测试证据] capacity核available与实际assignment，SFU不再offer不能冒称decline分支通过；output-gate核精确底层原因/当前预算/零泄漏/删房及下一房恢复。夹具文案差异保首失败并重跑受影响项，区分唯一场景与执行次数；主动删测试房不冒充Worker自然删房。SDK、合成LLM、普通agent、改过的语义fixture各按覆盖范围给PASS，不替代Android/真实路由/原crate。 [2026-11-10] #P003 #故障注入
- ★★★ [feedback/P003证据与回滚更新] 独立评审原意见、后到证据与最终裁决分别归档，不能用摘要掩盖原失败或缺口；只补档案时不为加日志改生产协议。后续生产发布重新建立当次回滚点，保留后来轮换的新凭据，尤其禁止用11/8旧env覆盖11/10新火山Key。共享记忆本地落盘，脱敏增量单独随Git，不能把代码push说成整个0-System已push。 [2026-11-10] #P003 #回滚 #记忆

## task-log.md

| 2026-11-10 17:44 | P003/知识归档 | v389恢复核验经验与技能落盘 | codex（OpenAI） | 已落盘；推送另核 | voice-agent-ops/updating-shared-memory-safely |
