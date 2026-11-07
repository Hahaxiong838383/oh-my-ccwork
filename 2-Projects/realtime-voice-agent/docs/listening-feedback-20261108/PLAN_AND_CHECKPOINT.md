# 当前状态：本轮反馈修复已发布（2026-11-08）

50bac运行源/正式1e9ec83a已于04:59部署原单038倾听池，05:00 Brain清单确认ready/effective_enabled；05:03:11 PID3574920已运行220.869秒、无重启/ERROR/panic。原env逐字节未变，主池/独立搜索池和各Brain进程保持，窗口仍11-11 18:00。完整回执见[P003_LISTENING_FEEDBACK_RELEASE_RECEIPT_20261108.md](P003_LISTENING_FEEDBACK_RELEASE_RECEIPT_20261108.md)。下方保留逐轮历史，不用旧待验状态覆盖当前结果。

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

## 最终候选验收过程（2026-11-08，生产尚未变更）

50bac0b2：665 项通过、2 项既有忽略；78 个输入的测试/test-feature/正式构建清单逐字节与 Git 一致。正式无测试 feature 二进制 1e9ec83a（77996640 字节），ABI 验收通过。

最终 RTC case0 语音反馈通过。续跑 case1 的第一次准备在绑定固定测试端口时报 EADDRINUSE；当时没发起该场景。后只读核端口已空、三生产进程未变，将隔离测试改为分配空闲回环端口；不是线上端口改动。此前将这次错误称为 SSH 超时已更正。

case1 超时原文恢复通过。case2 的旧断言预设 wake WAV 只产一条“小可”，但 worker 日志存在两条独立 ASR final（间隔889ms），客户端收到两个独立字幕段；此证据不支持服务器重复追加。失败结果完整保留，不改写。测试修正为采集该真实时间窗全部 ASR final，与客户端全部非空 final 字幕逐条比较内容、数量、顺序与段ID唯一性，并保持无音频断言；没有放宽为“至少一条”。新 case1/2 正在同50bac包重跑；业务代码未变。

Brain 直连 SSH 两次超时，既有严格 hostkey 的 Air/home-studio TCP 转发入口只读成功，04:52 ready/effective_enabled=true、rev6、单038、窗口11-11 18:00及de090清单核同。不能把直连运维入口超时称为业务离线。

复验结果：最终50bac运行源三组均通过；case0 trace38bd16b5，case1 tracead3fae98，case2 tracec9a5f95f。后两组严格匹配真实ASR与字幕；三组真实口令反馈均包含即时故事尾部标记，三个退出和恢复普通聊天均有音频/字幕/metrics。全部隔离进程已退出、房间回收、三生产池PID/hash未改变。6次first_pcm_ms为1067/489/544/439/520/463，计时包含预热等待，不是只报provider_ttfb；非安卓端到端时延。

部署门：只使用正式无test-feature包1e9ec83a，仍需最终Grok源码报告及线上最新空闲/哈希核验后原子切换。回滚新备份基于当前de090/d627，不能用旧5b3覆盖已上线连接修复。
