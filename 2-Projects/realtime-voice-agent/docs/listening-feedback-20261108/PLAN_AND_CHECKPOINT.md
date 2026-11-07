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
