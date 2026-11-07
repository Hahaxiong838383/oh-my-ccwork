# 倾听反馈口令分段修复（待 RTC 与发布验收）

基线：61c12793，运行源码 de090103。源码回滚标签 rollback/p003-listening-feedback-pre-20261108。
现役回滚须在实际发布前另取当前二进制、环境和 Brain manifest；不使用旧 5b3 代替当前传输修复基线。

## 已复现根因
旧 5b3 与现役 de090 同 WAV 都把“小可／我讲完了／请说说你的看法”分三条 final；首末相距 2763ms。
parse 仅匹配完整单条，RecentWake 只处理 Normal 入场，故没有 feedback HTTP、LLM/TTS。
反馈不需要 listening.proposal，不能把其缺失作为失败唯一依据。参见 ../listening-transport-20261108/RTC_FEEDBACK_SPLIT_FINDING.md。

## 最小实现
仅已授权、已完成进入的 Listening 状态；只收既有明确反馈口令的严格前缀，从“小可”起。
固定绝对 5000ms、总原文 256 bytes 上限，不随片段续时；绑定 epoch 和场景。
完整后走既有 voice_utterance / Brain 反馈授权，不造 Android seq，不扩展普通聊天，不改 ASR end_window。
未完成、不匹配、超时片段在同一有效上下文原样回故事；模式已切换则不携带旧片段进入新 epoch。
引用标点、否定或附加语导致白名单不匹配；这不是通用语义引用分类器，不能保证 ASR 丢失引用上下文后仍识别引用。
唱歌必须在首片段之前已观察到 500ms 停顿，后续 VAD 小停顿不能补授权；回声在拼接变更之前过滤并清上下文。

## 验收
三个真实红测在基线失败；修复后原三项与权限/回声/普通聊天/唱歌等边界通过。固定日志 SHA 与测试数量见 UNIT_EVIDENCE.json。
完整 Cargo/Linux通过不等于真实 RTC/安卓通过。下一步用原失败同 WAV 验语音反馈，不用控制消息替代；再做三种退出与正常聊天回归。
仅 Codex 实现；Grok 只读独立复核。尚未生产变更。

署名：codex（OpenAI）| 2026-11-08

## 初版候选被真实 RTC 与复审否决（保留失败）
`de4c472f`：659 项单测通过，但同 WAV RTC 仍 timeout；不是通过。
新证据 trace `p0-39-bab65dab-74a5-446a-a06e-e7374c35ca97`，首末 final 间有两次 VAD SpeechStart。
实际 Pipeline 的 `clear_listening_pending` 每次 VAD 都清整个口令缓存；原适配器测试没覆盖这条外层清理。
已把「停止旧播放」与「结束模式清口令」拆开；仅 SpeechStart 保留有界缓存，模式/回声/关房仍清理。
另外两个红测证实：原文退回故事时漏字幕、lease tick 先换 epoch 导致暂存正文丢失。
新实现将恢复正文绑定原 entry request_id；不会授权过期反馈，也不能写进新 entry 的故事。
Pipeline 在同一字幕批次先发恢复片段再发当前 final；原有 publish_deferred_batch 保序。
完整新测试 662 通过、2 既有忽略。一次 green1 构建因并发锁拒绝，未当代码失败；锁释放后 green2 完整通过。
待固定新候选重新构建并跑原 WAV，不使用 de4c 的二进制上线。

## 尾片段回声不应删除先前用户正文
新增红测（613通过/1失败）证明 0d863d4b 的 discard_echo_voice_context 仍会删除前两段已接受的原文。
已改为恢复原先片段的故事及字幕，丢弃本次回声尾部，同时清口令授权链；完整回归 663 通过、2 既有忽略。
该修复不放行回声，不使其成为反馈，也不重新识别已恢复的正文。当前候选仍待新 RTC 与独立最终复核。

## Grok B2 与完整口令回声范围
Grok指出：仅“小可”片段与近期 TTS 重合时，旧候选会误吞合法前缀。新红测614过/1失败确认。
已改成仅完整口令参与回声判定，比较拼成的完整规范化文本；不比较未完成前缀，也不按最后1字决定整句回声。
新测试“近期TTS仅含小可/看法”不误吞，近期TTS含完整口令仍拦截。完整回归665通过/2既有忽略。
Grok B1 的实际 Pipeline 证据现已补齐：0d863d4b 同WAV真实RTC PASS，trace a190b68f；真实VAD/ASR/Brain反馈一次、含故事标记、声音字幕metrics、退出恢复聊天及清房、进程退出0，三生产进程无变更。
后续新增回声策略须以当前完整固定候选重新跑RTC，不复用旧包当当前通过。
