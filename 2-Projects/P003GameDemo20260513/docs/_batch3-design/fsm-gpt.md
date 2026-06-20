# P003 小可批3 状态机重构设计 Finding

## Finding 0：目标里“5 态”与 `CLOSING` 存在口径冲突，建议按“5 个主态 + 1 个终止清理态”实现

【事实】需求写的是“5 态 FSM”，但列出的状态包含：

`SLEEPING / LISTENING / THINKING / SPEAKING / AWAITING_FOLLOWUP / CLOSING`

这实际上是 6 个状态。

【设计】建议工程实现上保留 `CLOSING` 为显式状态；对外文档可称为“5 个业务主态 + CLOSING 终止清理态”。

【理由】

- 【事实】当前核心 bug 之一是“告别不干净”，即退出链与 followup / VAD / TTS / ASR 异步事件交织。
- 【推断】如果把 `CLOSING` 折叠进 `SLEEPING` 或某个 action，会再次把“清理中”状态隐藏起来，容易复发：告别 TTS 还没播完、旧 ASR final 回来、playback_end 触发 followup、wake 又被启动等。

【风险】

- 【推断】如果团队强行坚持“只能 5 个枚举”，最容易牺牲的就是退出链的可证明性。
- 【推断】儿童语音场景里，`CLOSING` 的用户感知很强：孩子说“拜拜”后又被麦克风接话，是高优先级体验事故。

【实施要点】

- `CLOSING` 应该是 absorbing state：除 `EXIT_PLAYBACK_END / EXIT_FALLBACK_TIMEOUT / CLEANUP_DONE / FATAL_ERROR` 外，大多数业务事件都被忽略或仅做日志。
- `CLOSING` 期间禁止 beginTurn、禁止 followup、禁止重新开 ASR。
- `CLOSING -> SLEEPING` 是唯一重新 `startWakeListening` 的路径。

---

# ① 5+1 态 FSM 完整设计

## ①-1 状态图

```text
                         wake / PTT / feedback
        ┌─────────────────────────────────────────────┐
        │                                             ▼
┌────────────┐    acquire web mic + pause wake   ┌─────────────┐
│ SLEEPING   │ ────────────────────────────────▶ │ LISTENING   │
│ native wake│                                  │ web mic held │
│ on, mic off│ ◀──────────── cleanup ───────────│ ASR/VAD on   │
└────────────┘                                  └──────┬──────┘
                                                       │
                       vad.speech_end / asr.final / PTT up
                                                       ▼
                                                ┌─────────────┐
                                                │ THINKING    │
                                                │ LLM/TTS wait│
                                                │ cue timer   │
                                                └──────┬──────┘
                                                       │
                                  tts.audio / segment_start
                                                       ▼
                                                ┌─────────────┐
              barge-in / PTT / child speech     │ SPEAKING    │
        ┌─────────────────────────────────────── │ TTS playing │
        │                                       │ barge active│
        │                                       └──────┬──────┘
        │                                              │
        │                    playback_end && !exit && followup allowed
        │                                              ▼
        │                                       ┌───────────────────┐
        └────────────────────────────────────── │ AWAITING_FOLLOWUP │
                                                │ mic still held     │
                                                │ wake still paused  │
                                                └──────┬────────────┘
                                                       │
                         idle exit / L1 / L2 / max turns / error
                                                       ▼
                                                ┌─────────────┐
                                                │ CLOSING     │
                                                │ goodbye +   │
                                                │ cleanup     │
                                                └──────┬──────┘
                                                       │
                                      release web mic, then start wake
                                                       ▼
                                                ┌────────────┐
                                                │ SLEEPING   │
                                                └────────────┘
```

---

## ①-2 状态定义

| 状态 | 语义 | 麦克风 / 唤醒铁律 |
|---|---|---|
| `SLEEPING` | 待唤醒 | Web mic released；native wake running |
| `LISTENING` | 正在收孩子这一轮语音 | Web mic held；native wake paused；ASR/VAD active |
| `THINKING` | 已结束本轮收音，等待 ASR final / LLM / TTS 首包 | Web mic 可继续 held，但不上传普通语音帧；native wake paused |
| `SPEAKING` | TTS 播放中，barge-in 可触发 | Web mic held 用于本地 barge-in/VAD；native wake paused |
| `AWAITING_FOLLOWUP` | 有界续问窗，等待孩子接话 | Web mic held；native wake paused；不重新 getUserMedia，不重新 pauseWake |
| `CLOSING` | 告别、取消在途任务、释放资源 | native wake 仍 paused；清理完成后 release web mic，再 start wake |

【关键设计】这里的“麦连续开”不等于 ASR websocket 永远开、也不等于一直上传音频；而是把“持有 Web mic / MediaStream”和“当前 utterance 的 ASR 录音”拆开：

```text
MediaStream held != ASR utterance active
```

这样可以做到：

- followup 窗内不频繁 getUserMedia；
- native wake 不反复 pause/start；
- 但 THINKING / SPEAKING 时可以停止上传普通音频帧，降低串音和成本；
- SPEAKING 时仍可用本地 VAD / 能量检测做 barge-in。

---

## ①-3 转移表

### 通用规则

| 规则 | 说明 |
|---|---|
| stale event | 事件携带的 `sessionId / turnId / outputGen / asrGen` 不匹配时直接忽略 |
| invalid event | 当前状态不接受该事件时 no-op + debug log |
| CLOSING 优先级最高 | 进入 `CLOSING` 后，禁止 followup、禁止 beginTurn、禁止旧 playback_end 拉起新监听 |
| error 分级 | mic/native wake 错误优先清资源；ASR/LLM/TTS 错误可以播歉意后进入 AWAITING 或 CLOSING |

---

### 核心转移表

| 当前状态 | 事件 | 条件 | 新状态 | action |
|---|---|---|---|---|
| `SLEEPING` | `WAKE_DETECTED` | wake 可用 | `LISTENING` | `pauseWakeListening`；acquire Web mic；new session；new turn；start ASR/VAD；start listen timeout |
| `SLEEPING` | `PTT_DOWN` | 用户按住说话 | `LISTENING` | 同上，`mode=ptt` |
| `SLEEPING` | `FEEDBACK_DOWN` | 吐槽入口 | `LISTENING` | 同上，`mode=feedback`，后续 bypass LLM |
| `SLEEPING` | 旧 `asr/llm/tts` 事件 | stale | `SLEEPING` | ignore |
| `LISTENING` | `ASR_PARTIAL` | version match | `LISTENING` | 更新临时 transcript；可用于 UI，但不提交 LLM |
| `LISTENING` | `VAD_SPEECH_END` | 有有效语音 | `THINKING` | finalize utterance；flush ASR；停止上传本轮帧；不 release mic；start thinking timeout / cue timer |
| `LISTENING` | `ASR_FINAL` | 文本非空，非退出 | `THINKING` | 固化 transcript；提交 LLM；启动 thinking cue |
| `LISTENING` | `ASR_FINAL` | 命中 L1 告别白名单 | `CLOSING` | set exitIntent=L1；取消 followup；播告别或直接 cleanup |
| `LISTENING` | `ASR_FINAL` | 空文本 / no speech | 初始轮：`CLOSING`；followup：`AWAITING_FOLLOWUP` | 初始唤醒无输入则退出；followup 窗无效输入则继续等或走 idle |
| `LISTENING` | `PTT_UP` | `mode=ptt` | `THINKING` 或 `CLOSING` | 有语音则 finalize；无语音则清理回睡眠 |
| `LISTENING` | `LISTEN_TIMEOUT` | 超过最大录音窗 | `THINKING` 或 `CLOSING` | 作为兜底，不再用固定 6s 主导判停 |
| `LISTENING` | `FEEDBACK_DONE` / `FEEDBACK_UPLOAD_DONE` | `mode=feedback` | `CLOSING` → `SLEEPING` | 上传反馈库；不进 LLM/TTS；释放 mic；恢复 wake |
| `THINKING` | `THINKING_CUE_TIMEOUT` | 仍未有 TTS 首包 | `THINKING` | 播填充音，带 output generation |
| `THINKING` | `LLM_DELTA` | version match | `THINKING` | 累积文本 / 送 TTS；不一定转态 |
| `THINKING` | `LLM_DONE` | 含 `[EXIT]` | `THINKING` | set exitIntent=L2；等已有 TTS 播完，或无 TTS 则进 CLOSING |
| `THINKING` | `TTS_SEGMENT_START` / `TTS_AUDIO` | version match | `SPEAKING` | 开始播放；取消 thinking cue |
| `THINKING` | `THINKING_TIMEOUT` | LLM/TTS 超时 | `CLOSING` 或 `SPEAKING` | 可播“我有点没想好”后关闭或进入 followup，按产品决定 |
| `THINKING` | `BARGE_IN` / `PTT_DOWN` | 孩子抢话 | `LISTENING` | abort 当前 LLM/TTS；increment generation；new turn |
| `SPEAKING` | `TTS_AUDIO` | outputGen match | `SPEAKING` | 播放音频 chunk |
| `SPEAKING` | `TTS_END` | server TTS 流结束 | `SPEAKING` | 仅表示流结束，不等于播放结束 |
| `SPEAKING` | `PLAYBACK_END` | `exitIntent=true` | `CLOSING` | 禁止 followup；进入告别/清理 |
| `SPEAKING` | `PLAYBACK_END` | followupCount < MAX | `AWAITING_FOLLOWUP` | start followup idle timers；保持 mic；wake 继续 paused |
| `SPEAKING` | `PLAYBACK_END` | followupCount >= MAX | `CLOSING` | 有界结束，防无限陪聊 |
| `SPEAKING` | `BARGE_IN` / `VAD_SPEECH_START` / `PTT_DOWN` | version match | `LISTENING` | stop TTS；`outputGen++`；discard old audio；new turn |
| `SPEAKING` | `AVATAR_EXPRESSION` | version match | `SPEAKING` | UI side effect，不驱动主状态 |
| `AWAITING_FOLLOWUP` | `VAD_SPEECH_START` | 本地 VAD 判到孩子开口 | `LISTENING` | new followup turn；打开/复用 ASR utterance；送 pre-roll 音频 |
| `AWAITING_FOLLOWUP` | `ASR_PARTIAL` | 如果 ASR hot | `LISTENING` | 视作孩子接话 |
| `AWAITING_FOLLOWUP` | `PTT_DOWN` | 手动抢话 | `LISTENING` | new turn，保留 mic，不触发 wake |
| `AWAITING_FOLLOWUP` | `FOLLOWUP_NUDGE_TIMEOUT` | 尚未 nudge | `SPEAKING` | 播 idle nudge，例如“你还想聊什么？”；标记 nudged |
| `AWAITING_FOLLOWUP` | `FOLLOWUP_EXIT_TIMEOUT` | 已 nudge 后仍静音 | `CLOSING` | L3 idle exit |
| `AWAITING_FOLLOWUP` | `FOLLOWUP_MAX_REACHED` | 达到 MAX_FOLLOWUP_TURNS | `CLOSING` | 释放 mic，回到唤醒态 |
| `CLOSING` | `ENTER` | 任意来源 | `CLOSING` | abort ASR/LLM；取消非 exit TTS；取消 timers；可播 goodbye；start exitFallback |
| `CLOSING` | `PLAYBACK_END` | goodbye 播完 | `SLEEPING` | release Web mic；等待 release done；startWakeListening |
| `CLOSING` | `EXIT_FALLBACK_TIMEOUT` | goodbye 卡住 | `SLEEPING` | 强制 stop audio；release mic；start wake |
| `CLOSING` | 旧 `asr/llm/tts/vad` | 任意 | `CLOSING` | ignore |

---

## ①-4 现有事件映射

| 现有事件 | FSM 事件 | 主要落点 |
|---|---|---|
| `asr.partial` | `ASR_PARTIAL` | `LISTENING` 更新 UI；`AWAITING` 可触发接话；其他状态需 version guard |
| `asr.final` | `ASR_FINAL` | `LISTENING/THINKING` 固化本轮；可触发 L1 exit |
| `llm.delta` | `LLM_DELTA` | `THINKING` 累积/送 TTS |
| `llm.done` | `LLM_DONE` | 检测 `[EXIT]`，设置 L2 exitIntent |
| `tts.audio` | `TTS_AUDIO` | `THINKING -> SPEAKING` 或 `SPEAKING` 播放 chunk |
| `tts.end` | `TTS_END` | 标记 server 流结束，不等于播放完 |
| `tts.segment_start` | `TTS_SEGMENT_START` | `THINKING -> SPEAKING`，取消填充音 |
| `tts.playback_end` | `PLAYBACK_END` | `SPEAKING -> AWAITING_FOLLOWUP / CLOSING` |
| `avatar.expression` | `AVATAR_EXPRESSION` | UI side effect，不应改变主 FSM |
| `error` | `ERROR` | 分级处理；严重错误进 `CLOSING` |
| `vad.speech_end` | `VAD_SPEECH_END` | `LISTENING -> THINKING` |
| 唤醒 | `WAKE_DETECTED` | `SLEEPING -> LISTENING` |
| PTT | `PTT_DOWN / PTT_UP` | `SLEEPING/AWAITING/SPEAKING -> LISTENING`，release 时 finalize |
| 吐槽 | `FEEDBACK_DOWN / FEEDBACK_DONE` | `SLEEPING -> LISTENING(mode=feedback) -> CLOSING/SLEEPING` |

---

# ② 有界续问窗实现

## ②-1 设计

【设计】`AWAITING_FOLLOWUP` 的核心不是“录音一直提交”，而是“Web mic / MediaStream 一直 held，native wake 一直 paused”。

建议拆分三层：

```text
Mic session:
  acquire/release Web mic，跨 LISTENING/THINKING/SPEAKING/AWAITING 保持

Utterance session:
  每一轮孩子说话才 start/stop ASR utterance

Frame gate:
  决定哪些音频帧送 ASR，哪些只给本地 VAD/barge-in
```

### AWAITING_FOLLOWUP 内部策略

1. `SPEAKING -> AWAITING_FOLLOWUP`：
   - 不 `stopRecording` 到释放 mic 的程度；
   - 不 `startWakeListening`；
   - 不再次 `pauseWakeListening`；
   - 只开启 followup timers；
   - 本地 VAD 开始监听 speech_start；
   - 保存 500ms-1000ms pre-roll ring buffer，避免孩子第一个字被截断。

2. 孩子接话：
   - 本地 VAD 触发 `VAD_SPEECH_START`；
   - `AWAITING_FOLLOWUP -> LISTENING`；
   - 创建新 `turnId`；
   - 打开新的 ASR utterance；
   - 把 pre-roll 音频一起送入 ASR；
   - 后续由 `vad.speech_end / asr.final` 判停。

3. 静音超时：
   - 保留 L3 语义：先 nudge，再 exit。
   - 可以把现有 `IDLE_NUDGE_MS=9000 / IDLE_EXIT_MS=9000` 作为初始值。
   - 如果真机数据证明儿童 5-10 岁等待过长，可调到 6000-8000ms，但建议通过配置或实验灰度，而不是硬编码替换。

4. MAX_FOLLOWUP_TURNS：
   - 仍然需要。
   - 时间窗解决“每轮麦克风开关”问题；
   - 轮数上限解决“无限陪聊 / 隐私 / 电量 / 费用 / 状态泄漏”问题。
   - 建议：
     - 初始唤醒轮不计入 followup；
     - 每次 `AWAITING_FOLLOWUP -> LISTENING` 成功形成有效用户输入后 `followupCount++`；
     - `followupCount >= MAX_FOLLOWUP_TURNS` 时，本轮回答播完后进入 `CLOSING`。

---

## ②-2 理由

【事实】痛点 1 是“多轮 followup 每轮 stopRecording 关麦 → 等接话 → 唤醒/超时 → 又开麦”。

【推断】真正需要消灭的是“释放 Web mic / 恢复 native wake / 再次抢麦”的资源抖动，而不是禁止所有 ASR utterance stop。

【推断】如果 ASR websocket 在 AWAITING 全程保持 hot，会简单但成本高，也更容易把环境音误识别为孩子接话。更稳的方案是：

- Web mic held；
- 本地 VAD 判 speech_start；
- ASR utterance 按轮打开；
- pre-roll 补偿开头截断。

---

## ②-3 风险

1. 【推断】Web mic 长时间 held 会增加电量消耗和隐私敏感度。
2. 【推断】SPEAKING 时 mic held 可能收到 TTS 回声，导致误 barge-in。
3. 【推断】本地能量 VAD 对儿童轻声、远场、噪音环境不稳定。
4. 【推断】如果 Android WebView / 机型对音频焦点处理差，TTS 播放与录音并存可能出兼容问题。

---

## ②-4 实施要点

- 必须引入 `MicManager`，并把旧的 `stopRecording` 拆成：
  - `stopUtterance()`：结束本轮 ASR，不释放 MediaStream；
  - `releaseMicSession()`：真正释放 Web mic；
  - `startUtterance()`：为新 turn 开启 ASR；
  - `acquireMicSession()`：只在 `SLEEPING -> LISTENING` 或显式 PTT/feedback 入口调用。
- AWAITING 使用本地 VAD + pre-roll。
- SPEAKING 的 barge-in 要有抑制策略：
  - 播放开始后 200-400ms 内可设 echo guard；
  - 使用 AEC/noise suppression；
  - 需要阈值高于普通 AWAITING；
  - 或要求检测到连续人声片段再 barge-in。
- 所有 followup timer 必须带 `sessionId`，旧 timer 到期不能影响新会话。

---

# ③ Versioned state 设计

## ③-1 数据结构设计

建议每个事件都带 envelope：

```ts
type Phase =
  | 'SLEEPING'
  | 'LISTENING'
  | 'THINKING'
  | 'SPEAKING'
  | 'AWAITING_FOLLOWUP'
  | 'CLOSING';

type TurnSource = 'wake' | 'ptt' | 'followup' | 'feedback';

interface Version {
  sessionId: number;     // 一次唤醒到关闭的会话
  turnId: number;        // 一轮孩子输入
  asrGen: number;        // ASR utterance generation
  outputGen: number;     // LLM/TTS/playback generation
}

interface TurnContext {
  version: Version;
  source: TurnSource;
  followupIndex: number;
  startedAt: number;

  // 收编 capturedTurnMeta
  metaSnapshot: {
    feedbackMode: boolean;
    wakeTriggered: boolean;
    ptt: boolean;
    childProfile?: unknown;
    promptContext?: unknown;
  };

  transcriptPartial?: string;
  transcriptFinal?: string;
  exitIntent?: null | 'L1' | 'L2' | 'L3';
}

interface FSMState {
  phase: Phase;
  sessionId: number;
  activeTurn?: TurnContext;

  mic: 'released' | 'acquiring' | 'held' | 'releasing';
  wake: 'running' | 'pausing' | 'paused' | 'starting' | 'stopped';

  followup: {
    count: number;
    max: number;
    nudged: boolean;
  };

  closing?: {
    reason: 'L1' | 'L2' | 'L3' | 'max_turns' | 'error' | 'manual';
    startedAt: number;
  };
}

interface FSMEvent {
  type: string;
  version?: Partial<Version>;
  payload?: unknown;
  ts: number;
}
```

---

## ③-2 收编现有 3 个补丁

### A. `capturedTurnMeta`

【事实】现有 server 有 `capturedTurnMeta`，用于防止 ASR 异步 final 期间 meta 被覆盖。

【设计】将其变成 `TurnContext.metaSnapshot`。

【规则】

- 创建 turn 时一次性拍快照；
- 后续 ASR final、LLM request、feedback upload 都只读这个 snapshot；
- 禁止从全局 mutable ref 重新取 `feedbackMode / wakeTriggered / promptContext`。

---

### B. `playbackGeneration`

【事实】现有 voice-client 有 `playbackGeneration`，用于 barge-in 后作废已调度 segment。

【设计】收编为 `Version.outputGen`。

【规则】

- 每次开始新的 LLM/TTS 输出时设置当前 `outputGen`；
- 每次 barge-in / exit / abort 时 `outputGen++`；
- `tts.audio / segment_start / playback_end` 必须携带或绑定 `outputGen`；
- 不匹配的播放事件直接 ignore。

---

### C. `activeTurn + discardTurnAtOrBelow`

【事实】现有有 `activeTurn + discardTurnAtOrBelow`，用于丢弃旧 turn 在途 `tts.audio`。

【设计】用 `sessionId + turnId + outputGen` 替代。

【规则】

- reducer 中只有一个 `activeTurn`；
- 新 turn 创建时 `turnId++`；
- 旧 turn 的 ASR final / TTS audio / playback_end 都因 version mismatch 被忽略；
- 不再需要额外维护 `discardTurnAtOrBelow`，除非为了兼容未带 turnId 的旧 server event。

---

## ③-3 典型竞态处理

### ASR 异步 final

```text
LISTENING turn=3
  -> vad.speech_end
  -> THINKING turn=3
  -> 用户 barge-in，new turn=4
  -> 旧 asr.final(turn=3) 到达
  -> reducer 检查 turnId != activeTurn.turnId
  -> ignore
```

### barge-in

```text
SPEAKING turn=3 outputGen=8
  -> VAD_SPEECH_START
  -> outputGen++ => 9
  -> stop TTS playback
  -> new turn=4
  -> 旧 tts.audio(turn=3, outputGen=8) 到达
  -> ignore
```

### 退出

```text
LLM_DONE turn=3 payload contains [EXIT]
  -> set exitIntent=L2
  -> playback_end(turn=3, outputGen=current)
  -> CLOSING
  -> session closing flag set
  -> 旧 followup timer / old ASR final 到达
  -> ignore
```

---

## ③-4 风险与实施要点

【风险】

- 【推断】如果公司侧 server 不 echo `sessionId / turnId / outputGen`，client 只能弱过滤，不能完全证明旧事件无害。
- 【推断】如果有些 native bridge event 无法携带 version，需要在注册 callback 时绑定当前 version，回调触发后再 dispatch。

【实施要点】

- 所有异步入口统一走 `dispatch(event)`。
- 所有 timer 创建时绑定 version。
- 所有 server request 带上 `sessionId / turnId / outputGen`。
- server 返回的 `asr/llm/tts` event 尽量 echo 这些字段。
- 个人站 server 冻结时，不应依赖其改造；公司侧 server 可改的链路优先补 echo。
- 无法改 server 的 event，需要在 client adapter 层包一层“发送请求时的 version”。

---

# ④ 现有功能映射

## ④-1 唤醒词

【设计】

- 仅 `SLEEPING` 允许 native wake active。
- `WAKE_DETECTED` 后：
  1. `pauseWakeListening`;
  2. 等 pause ack 或短 timeout；
  3. acquire Web mic；
  4. 进入 `LISTENING`。

【理由】避免 native wake 和 Web getUserMedia 抢麦。

【风险】pauseWake 如果无 ack 或失败，可能卡死。

【实施要点】

- pause/start wake 必须幂等。
- `startWakeListening` 只允许在 `CLOSING -> SLEEPING` 的 cleanup 完成后调用。
- 不允许每轮 followup 播放完后 start wake。

---

## ④-2 PTT

【设计】

- `PTT_DOWN` 从 `SLEEPING` 进入 `LISTENING(mode=ptt)`。
- `PTT_UP` finalize utterance。
- 如果 PTT 在 `SPEAKING` 中触发，视作 barge-in：
  - stop TTS；
  - invalidate old outputGen；
  - new turn；
  - 进入 `LISTENING(mode=ptt)`。

【风险】

- PTT release 过早可能无 final。
- 与 VAD speech_end 同时发生会重复 finalize。

【实施要点】

- `finalizeUtterance` 必须幂等。
- PTT 模式下以 `PTT_UP` 为强结束，VAD 只作辅助。

---

## ④-3 吐槽 feedback

【设计】

- 用 `mode=feedback`，不要增加第七个主状态。
- `FEEDBACK_DOWN -> LISTENING(mode=feedback)`。
- 录音结束后：
  - 上传反馈库；
  - 不进 LLM；
  - 不进入 followup；
  - 走 `CLOSING -> SLEEPING` 清理资源。

【风险】

- 如果 feedback 与普通 conversation 共用全局 ref，容易污染 turn meta。

【实施要点】

- feedbackMode 必须进入 `TurnContext.metaSnapshot`。
- feedback 事件也要带 version，避免异步上传回调改错状态。

---

## ④-4 填充音 thinking cue

【设计】

- 只在 `THINKING` 中调度。
- `THINKING_CUE_DELAY_MS=300` 可保留。
- 一旦收到 `TTS_SEGMENT_START / TTS_AUDIO / CLOSING / BARGE_IN`，取消 cue。
- cue 播放也要绑定 `outputGen`。

【风险】

- cue 可能和正式 TTS 重叠。
- barge-in 后旧 cue 可能误播。

【实施要点】

- cue 是 versioned output。
- cue timer 是 versioned timer。
- cue 不能触发 followup。

---

## ④-5 退出 L1 / L2 / L3

### L1 告别词白名单

- `ASR_FINAL` 命中白名单；
- 立即设置 `exitIntent=L1`；
- 进入 `CLOSING`；
- 禁止再 beginTurn。

### L2 LLM `[EXIT]`

- `LLM_DONE` 检测 `[EXIT]`；
- 设置 `exitIntent=L2`；
- 如果已有 TTS 正在播，等 `PLAYBACK_END` 后进 `CLOSING`；
- 如果没有可播放音频，直接 `CLOSING` 或播短 goodbye。

### L3 idle

- `AWAITING_FOLLOWUP` 中：
  - nudge timer 到期：播一句轻提示；
  - exit timer 到期：`CLOSING(reason=L3)`。

【实施要点】

- `CLOSING` 必须吸收所有 followup timer。
- `PLAYBACK_END` 在 exitIntent 下只能去 `CLOSING`，不能去 `AWAITING_FOLLOWUP`。

---

## ④-6 VAD

【设计】

- `LISTENING`：
  - 火山 definite VAD 是主判停；
  - 前端能量 VAD 是兜底；
  - `vad.speech_end -> THINKING`。
- `AWAITING_FOLLOWUP`：
  - 本地 VAD 用于 speech_start；
  - speech_start 后再打开/复用 ASR utterance。
- `SPEAKING`：
  - 本地 VAD 用于 barge-in；
  - 需要 echo 抑制阈值。

【风险】

- 儿童轻声会漏检。
- TTS 回声会误检。

【实施要点】

- AWAITING 维护 pre-roll buffer。
- SPEAKING barge-in 设置更严格门限。
- 所有 VAD event 带 session version。

---

## ④-7 麦克风互斥铁律

建议定义唯一资源表：

| 状态 | Web mic | native wake | ASR utterance |
|---|---|---|---|
| `SLEEPING` | released | running | off |
| `LISTENING` | held | paused | on |
| `THINKING` | held | paused | flushing/off |
| `SPEAKING` | held | paused | off 或 barge-only |
| `AWAITING_FOLLOWUP` | held | paused | off，local VAD on |
| `CLOSING` | releasing/held until goodbye end | paused | off |

【硬规则】

1. `pauseWakeListening` 只在进入 conversation mic session 前调用。
2. `startWakeListening` 只在 Web mic 完全 release 后调用。
3. `AWAITING_FOLLOWUP` 不 start wake。
4. `SPEAKING -> AWAITING_FOLLOWUP -> LISTENING` 不重新 getUserMedia。
5. `CLOSING` 是唯一收口清理点。

---

# ⑤ React hook 落地方案

## ⑤-1 设计选择

【设计】建议不用 XState，先用“手搓 typed reducer + 单一 stateRef + effect runner”。

理由：

- 【事实】当前是在 `useMobileVoice.ts` React hook 中。
- 【推断】儿童 demo 当前复杂度适合 typed reducer，不一定值得引入 XState 依赖和学习成本。
- 【推断】团队最需要的是“单一真相 + version guard + 可单测转移表”，不是复杂状态机运行时。

推荐结构：

```text
useMobileVoice
  ├─ useReducer(fsmReducer)
  ├─ stateRef                    // 给异步 callback 读最新状态
  ├─ dispatch(event)
  ├─ effectRunner                // 根据 reducer 返回的 commands 执行副作用
  ├─ MicManager ref              // imperative resource
  ├─ VoiceClient ref             // ASR/LLM/TTS client
  ├─ AudioPlayer ref
  └─ TimerManager ref
```

---

## ⑤-2 哪些进 FSM state

应进入 reducer state：

- phase；
- pressed / pressedRef 语义；
- connected；
- wakeAvailable；
- listeningByWake；
- feedbackMode；
- turnCount / followupCount；
- exiting / exitPending；
- idleNudged；
- activeTurn；
- discard / generation；
- pending exit reason；
- 当前 transcript；
- timers 的“语义状态”。

不建议继续以散落 ref 表达这些业务事实。

---

## ⑤-3 哪些保留 ref

应保留 ref，但只作为 imperative handle：

- `clientRef`;
- `recorderRef`;
- `mediaStreamRef`;
- `audioPlayerRef`;
- native bridge ref；
- timer handles；
- WebSocket / ASR stream handle；
- animation/avatar controller。

【原则】ref 可以保存“对象句柄”，不保存“业务真相”。

---

## ⑤-4 effect runner 模式

Reducer 保持纯函数，返回：

```text
nextState + commands
```

例如：

```text
Event: WAKE_DETECTED
State: SLEEPING
Reducer returns:
  nextState: LISTENING(acquiring)
  commands:
    - pauseWake(version)
    - acquireMic(version)
    - startASR(version)
    - scheduleListenTimeout(version)
```

异步 command 完成后再 dispatch：

```text
MIC_ACQUIRED(version)
ASR_STARTED(version)
COMMAND_FAILED(version)
```

【风险】

- 如果 command 直接读闭包里的旧 state，会重现 stale bug。

【实施要点】

- command 完成时必须带 version 回来。
- `stateRef.current` 只用于 guard，不用于绕过 reducer 修改业务状态。
- 所有 timer 由 TimerManager 统一注册和取消。

---

# ⑥ 实施策略与测试

## ⑥-1 渐进重构，不建议一次重写

【设计】建议分 5 步迁移。

### Phase 0：冻结行为，补日志

- 不改业务逻辑；
- 为现有 handler 打点：
  - 当前 inferred phase；
  - mic held；
  - wake running；
  - active turn；
  - playback generation；
  - timer fire。
- 建立真机复现脚本。

### Phase 1：先引入 version envelope

- 创建 `sessionId / turnId / outputGen / asrGen`；
- 包住 ASR / LLM / TTS / timer callback；
- 先收编：
  - `capturedTurnMeta`;
  - `playbackGeneration`;
  - `activeTurn + discardTurnAtOrBelow`。

收益：即使 FSM 还没完全迁完，也先降低异步污染。

### Phase 2：引入 MicManager

- 把 `stopRecording` 拆成：
  - stop ASR utterance；
  - release mic session。
- 确保 pauseWake/startWake 只有 MicManager 统一调用。
- 加 invariant log：

```text
assert(!(webMicHeld && nativeWakeRunning))
```

### Phase 3：迁移主链路 FSM

优先迁：

1. wake -> listening；
2. vad/asr final -> thinking；
3. tts playback_end -> awaiting；
4. awaiting -> listening；
5. closing -> sleeping。

此阶段先保留原有 UI state 映射，降低破坏面。

### Phase 4：迁移退出链

- L1/L2/L3 全部只进入 `CLOSING`；
- 删除旧的 `exitingRef / exitPendingRef / idleNudgedRef` 语义；
- `CLOSING` 吸收旧事件。

### Phase 5：清理旧 ref/timer

- 删除已经被 FSM state 替代的 ref；
- timer 全部集中到 TimerManager；
- 补 reducer 单测和集成测试。

---

## ⑥-2 不破坏上线功能的策略

| 功能 | 保留方式 |
|---|---|
| 唤醒词 | `SLEEPING` 专属 native wake；conversation 内 wake paused |
| PTT | `mode=ptt`，PTT_UP finalize |
| 吐槽 | `mode=feedback`，bypass LLM |
| 填充音 | `THINKING` 的 versioned cue timer |
| L1 退出 | `ASR_FINAL` 命中后进 `CLOSING` |
| L2 退出 | `LLM_DONE [EXIT]` 后 playback_end 进 `CLOSING` |
| L3 退出 | `AWAITING_FOLLOWUP` nudge + exit timers |
| VAD 判停 | `LISTENING` 用火山 definite + 前端兜底 |
| 麦互斥 | MicManager 统一 pause/start wake 与 acquire/release mic |
| 多轮 followup | `SPEAKING -> AWAITING_FOLLOWUP -> LISTENING`，不释放 mic |

---

## ⑥-3 测试策略

### Reducer 单测

必须覆盖：

1. `SLEEPING + WAKE_DETECTED -> LISTENING`;
2. `LISTENING + ASR_FINAL(normal) -> THINKING`;
3. `LISTENING + ASR_FINAL(L1) -> CLOSING`;
4. `THINKING + TTS_AUDIO -> SPEAKING`;
5. `SPEAKING + PLAYBACK_END(no exit, under max) -> AWAITING_FOLLOWUP`;
6. `SPEAKING + PLAYBACK_END(exit) -> CLOSING`;
7. `AWAITING + VAD_SPEECH_START -> LISTENING`;
8. `AWAITING + idle nudge -> SPEAKING`;
9. `AWAITING + idle exit -> CLOSING`;
10. `CLOSING + stale ASR_FINAL -> CLOSING`;
11. stale `tts.audio` 被忽略；
12. barge-in 后旧 `playback_end` 不得触发 followup。

### Fake timer 测试

- thinking cue 300ms；
- thinking timeout 12000ms；
- followup nudge；
- followup exit；
- exit fallback 8000ms；
- timer version mismatch ignore。

### 资源 invariant 测试

必须长期成立：

```text
nativeWakeRunning && webMicHeld == false
CLOSING eventually reaches SLEEPING
SLEEPING has no activeTurn
AWAITING_FOLLOWUP does not call startWakeListening
CLOSING is the only path that release mic + start wake
```

### 真机场景测试

1. 唤醒后孩子连续追问 4 轮；
2. 第 5 轮触发 MAX close；
3. TTS 播放中孩子插话；
4. 孩子说“拜拜”；
5. LLM 返回 `[EXIT]`；
6. AWAITING 静音 L3；
7. PTT 按住说话、松开提交；
8. 吐槽上传；
9. ASR final 延迟到下一轮后返回；
10. TTS audio 延迟到 barge-in 后返回；
11. wake pause ack 丢失；
12. mic acquire 失败。

---

# 总体建议

【结论】这次重构的关键不是“把 20 个 ref 换个地方放”，而是建立三条硬边界：

1. **业务状态边界**：所有对话状态只能由 FSM reducer 决定。
2. **资源边界**：native wake 与 Web mic 只能由 MicManager 管，且 conversation 窗内不反复 start/pause wake。
3. **时间边界**：所有异步事件、timer、server stream、playback 都必须 versioned。

【推荐最终形态】

```text
5 个主态：
SLEEPING / LISTENING / THINKING / SPEAKING / AWAITING_FOLLOWUP

+ 1 个必须显式存在的终止态：
CLOSING

+ 1 套 version：
sessionId / turnId / asrGen / outputGen

+ 1 个资源管理器：
MicManager

+ 1 个原则：
CLOSING 之前不 start wake，SLEEPING 之外不让 native wake 抢麦。
```

署名：codex（OpenAI）
