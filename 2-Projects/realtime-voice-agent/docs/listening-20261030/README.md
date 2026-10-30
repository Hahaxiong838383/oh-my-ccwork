# P003 倾听 Worker：首批开发检查点

2026-10-30，分支`codex/p003-listening-worker-20261030`，基点`ef92ee1a`；Codeg“P003 倾听 Worker｜开发”folder29。

已实现可独立测试的`listening_mode.rs`与`listening_buffer.rs`，覆盖双确认进入、单次反馈许可、用户讲话取消、15秒租约与30分钟会话上限、seq/epoch去重、摘要修订CAS及有界上下文。**尚未import进main/pipeline，未接线上音频、未部署/开闸。**

运行：在`rust-worker`执行`bash scripts/test-listening-core.sh`，当前29项通过；仅需std，适配本机rustc1.70/edition2021。不是完整项目edition2024 Cargo或Linux/RTC通过证明。

先鉴别真实participant、签名metadata和主Brain租约，再调用纯模块。所有时间参数同一单调时钟。记录SpeechStart及SpeechEnd；只触发一次Start后持续讲话也不得获反馈许可。`Action::Enter`与Feedback/Exit/LocalReady均需epoch。`capture_drained`和`local_ready`是独立条件；实际capture取消与队列排空下一批接线。

摘要ticket只匹配创建它的buffer实例/摘要版本/原文前缀；异步HTTP仍需绑定room/session/trace/listening_id，不能用本地实例ID替代网络鉴权。最近256条已压缩片段保留版本/指纹；更老片段重传保守作废摘要并标缺口。近期4000字截出未摘要前文同样标缺口。

共享合同`4-Assets/contracts/p003-listening-mode-v1.json`与Brain树字节一致；完整执行计划、Android交接、回滚记录在`codex/p003-listening-brain-20261030`分支：
- `docs/superpowers/plans/2026-10-30-p003-listening-implementation.md`
- `2-Projects/P003GameDemo20260513/docs/P003_LISTENING_ANDROID_HANDOFF_20261030.md`
- `2-Projects/P003GameDemo20260513/docs/listening-20261030/EXECUTION.md`
- `2-Projects/P003GameDemo20260513/docs/listening-20261030/ROLLBACK.md`

后续需完成主循环输入拦截、所有输出许可、在途capture取消、搜索显式播放标记、独立Brain摘要/反馈客户端、Android当前包与真人测试。搜索候选保持独立R26基线，不从本普通R18树整包覆盖。

源码冻结标签`rollback/p003-listening-worker-20261030`。本批没有线上变更，撤回只需revert新增模块提交，不重启服务器、不回灌数据库。

署名：codex（OpenAI）| 2026-10-30
