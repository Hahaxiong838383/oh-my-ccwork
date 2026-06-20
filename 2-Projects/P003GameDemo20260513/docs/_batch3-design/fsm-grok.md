**评审 Finding（P003 状态机重构设计方案）**

### ① 5 态 FSM 完整设计
**建议设计**：定义严格枚举 `enum VoiceState { SLEEPING, LISTENING, THINKING, SPEAKING, AWAITING_FOLLOWUP, CLOSING }`。转移表采用 `state × event → (newState, action[])` 形式，动作仅包含 `startRecording`、`stopRecording`、`pauseWakeListening`、`startWakeListening`、`playThinkingCue`、`cancelTTS`、`finalizeExit` 等原子操作。事件映射示例：
- asr.final → 若当前 LISTENING 且非 EXIT 标记则 → THINKING（带 version 校验）
- vad.speech_end → LISTENING → AWAITING_FOLLOWUP（窗内不关麦）
- playback_end → SPEAKING → AWAITING_FOLLOWUP（若 turnCount < MAX）
- llm.done[EXIT] → 任意态 → CLOSING
- 唤醒词 → SLEEPING → LISTENING
- PTT 按下 → LISTENING/AWAITING → LISTENING（重置窗）
- 吐槽 → LISTENING → THINKING（feedback 路径）
- error → 任意 → CLOSING（带 cleanup）

**【事实】** 现有 7 个 timerRef 需全部收编为状态内 timeout 动作，避免散落。**【推断】** 6 态（含 CLOSING）比 5 态更安全，能确保关麦原子性。

**风险**：转移表遗漏 error/vad 路径会导致麦泄漏或死锁。**实施要点**：先画 Mermaid 状态图（SLEEPING↔LISTENING↔THINKING↔SPEAKING↔AWAITING_FOLLOWUP→CLOSING→SLEEPING），再用 switch/reducer 实现，单测每条转移。

### ② 有界续问窗实现
**建议设计**：AWAITING_FOLLOWUP 状态下**显式禁止** `stopRecording` 与 `pauseWakeListening` 调用，窗内 VAD 继续监听（复用现有 vad.speech_end + 能量兜底）。静音超时 6-8s 触发 `idleNudge` → 若无 speech 则 `finalizeExit` 进入 CLOSING。孩子接话直接事件驱动 `asr.partial` → LISTENING（无缝，无需重开麦）。与 MAX_FOLLOWUP_TURNS 协调：窗内仍保留轮数上限，达 4 轮强制 CLOSING。

**【事实】** 现有 WAKE_RECORD_MS 6000 / IDLE_NUDGE_MS 9000 需合并为窗内统一超时。**【推断】** 连续开麦可消除“频繁开关”痛点。

**风险**：窗内 VAD 误判导致无限续问或卡死。**实施要点**：AWAITING_FOLLOWUP 进入时启动单一 `followupTimer`，退出时必 clear；测试童声静音场景。

### ③ versioned state 设计
**建议设计**：引入 `turnVersion: number`（递增于每轮 beginTurn）。数据结构 `{ turnVersion, capturedTurnMeta, playbackGeneration, activeTurn, discardBelow }` 统一存于 FSM state。收编 3 补丁：server capturedTurnMeta 用 version 校验；playbackGeneration 用 version 作废旧 segment；activeTurn + discardTurnAtOrBelow 用 version 丢弃旧 TTS。ASR 异步 final / barge-in / 退出时先比对 version，version 不匹配直接 discard。

**【事实】** 现有 server/client 补丁已证明 version 有效。**【推断】** 统一 version 可根治竞态。

**风险**：version 溢出或初始化错误。**实施要点**：version 从 0 开始，每 beginTurn ++，CL<|eos|>
