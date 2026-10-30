# 本批评审与复盘

主实现由当前会话 Codex 完成；辅助评审只读，没有委派写代码。一次整批评审及定向复核发现的 4 项 Important 均已修复，未发现 Critical。评审不等于真人验收。

| 问题 | 修复与用例 |
|---|---|
| 授权在途时 state 抢先推进序号，enter 被判 stale，留下 authority entry | 有界暂存查询，先提交 enter，再顺序完成 state；失败/超时 close 原 entry；`listening_pending_enter_state_query_preserves_entry_sequence` |
| 重复 enter 在排空/local_ready 之前错误 completed | Entering 重发只回 received；Paused 拒绝；`listening_duplicate_enter_never_completes_before_both_confirmations` |
| 摘要失败后高水位使每个音频 tick 都发新请求 | 独立 5/10/20/30 秒失败退避，成功/取消也设置最小间隔；`listening_summary_failure_cannot_retry_on_every_audio_tick` |
| 语音预约未取消在途摘要，反馈占槽后无法开始 | 语音与按钮同样取消内容任务；`listening_voice_invitation_preempts_inflight_summary` |

主实现另外补了：普通模式新 turn 撤销旧 turn 许可；control 提前发现过期不能漏掉暂停清理；STT Final 先于 VAD SpeechEnd 时保留邀请并等待重验；进入授权超时直接暂停并关闭 RTC，不退回普通聊天。

反向测试留在 evidence：control 解析缺失、重复 enter 提前完成、移除摘要退避门、语音与摘要竞争均已观测到预期断言失败。pending/state 和授权超时也实际复现过失败；完整修复后的结果以最终 Linux 日志为准。没有将编译错误、缺 fixture、网络超时算作有效 RED。

工程教训：

1. 双确认既要限制第一次 ACK，也要限制重复请求的 ACK；只测状态机不足以证明传输层正确。
2. 异步授权与客户端查询共享序号空间，不能让后来的查询抢先消费进入请求。
3. 后台内容任务的失败重试必须独立限速，音频循环频率不能成为 HTTP 重试频率。
4. 持有 Native capture admission 到 FFI 真正完成；不能用丢 Rust future 冒充原生队列已排空。
5. 联合模拟应使用实际路由和双方绑定/SHA，不只各自跑 mock。真实模型、真人听感和线上窗口仍需单独取证。
6. 拷贝构建缓存前先检查磁盘。本轮第一次复制使根分区空间不足，已仅清理本轮专用副本；最终在有足够空间的 /data 专用目录独立构建，未写穿旧缓存。
7. 本批并非所有集成代码都严格测试先行：最初 runtime 与后续具体缺陷有 RED→GREEN 证据，部分接线先实现再补测。回执只列真实观测，不补造 TDD 历史。

署名：codex（OpenAI）| 2026-10-30
