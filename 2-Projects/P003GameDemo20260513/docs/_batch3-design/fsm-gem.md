# P003 小可批3 状态机重构设计方案评审报告

---

## ① 5态 FSM 完整设计

### 1. 设计

#### 状态定义 (State Definitions)
虽然业务描述为“5态”，但为实现干净的退出生命周期管理，设计中显式定义以下 6 个核心状态：
1. **`SLEEPING`**：待唤醒状态。此时原生唤醒词引擎工作，Web端录音与 ASR 关闭（麦克风硬件释放）。
2. **`LISTENING`**：聆听与录音状态。麦克风硬件开启，音频流持续向 ASR 引擎发送。
3. **`THINKING`**：思考状态。收到 ASR 最终结果并停止向 ASR 发送音频，等待 LLM/TTS 首包响应，伴随填充音计时触发。
4. **`SPEAKING`**：播放状态。TTS 正在播放，此时开启本地 VAD 监听以支持打断（Barge-in）。
5. **`AWAITING_FOLLOWUP`**：续问等待状态（有界续问窗）。麦克风硬件保持打开，静音检测计时器工作，等待用户接话。
6. **`CLOSING`**：干净退出中状态。播放告别词 TTS，停止接收任何新的 ASR，播放完毕后平滑释放麦克风并切换回 `SLEEPING`。

#### 状态转移图 (State Transition Diagram)
```
                  WAKE_UP / PTT_PRESS (pauseWake -> startRecording)
   +----------------------------------------------------------------------+
   |                                                                      |
   |                                                                      v
+--------------+           VAD_SPEECH_END / TIMEOUT_WAKE        +--------------+
|   SLEEPING   | <--------------------------------------------- |  LISTENING   |
+--------------+                                                +--------------+
       ^                                                               |
       |                                                               | VAD_SPEECH_END
       |                                                               v
       | (Goodbye End /                                         +--------------+
       |  TIMEOUT_EXIT_FALLBACK)                                |   THINKING   |
       |                                                        +--------------+
       |                                                               |
       |                                                               | LLM_START / TTS_START
       |                                                               v
       |  FORCE_STOP / L2 EXIT /                                +--------------+
       |  TurnCount Max / L3 Timeout                            |   SPEAKING   |
+--------------+ <--------------------------------------------- +--------------+
|   CLOSING    |                                                       |
+--------------+ <-----------------------+                             | TTS Playback End
       ^                                 |                             v
       |                                 | TIMEOUT_IDLE_EXIT    +--------------+
       +---------------------------------+--------------------- |   AWAITING   |
       |                                                        |  FOLLOWUP    |
       |                                                        +--------------+
       |             VAD_SPEECH_START (Barge-in & Turn++)              |
       +---------------------------------------------------------------+
```

#### 状态转移表 (State Transition Table)

| 当前状态 | 触发事件 | 目标状态 | 关联动作 / 副作用 (Side Effects) |
| :--- | :--- | :--- | :--- |
| **`SLEEPING`** | `WAKE_UP` | `LISTENING` | 唤醒成功：执行 `pauseWakeListening()` -> 延时 -> `startRecording()`，开启首轮录音，初始化 `turnVersion = 1`，清除所有 Timer。 |
| **`SLEEPING`** | `PTT_PRESS` | `LISTENING` | PTT 按下：执行 `pauseWakeListening()` -> `startRecording()`，设置 `isPttMode = true`，初始化 `turnVersion = 1`。 |
| **`LISTENING`** | `VAD_SPEECH_END` | `THINKING` | 用户说话结束：停止发送音频至 ASR，启动 `THINKING_CUE_DELAY_MS`（300ms）填充音延迟定时器，启动 `THINKING_TIMEOUT_MS`（12s）超时定时器。 |
| **`LISTENING`** | `TIMEOUT_WAKE_RECORD` | `SLEEPING` | 唤醒后 6s 无说话：执行 `stopRecording()` -> `startWakeListening()`，重置状态。 |
| **`LISTENING`** | `FORCE_STOP` | `CLOSING` | 强行终止：执行 `stopRecording()`，启动退出流程。 |
| **`THINKING`** | `LLM_START` / `TTS_START` | `SPEAKING` | 收到响应：清除填充音定时器/停止播放填充音，启动 TTS 播放，增加 `playbackGeneration`。 |
| **`THINKING`** | `TIMEOUT_THINKING` | `CLOSING` | 思考超时（12s）：播放超时兜底音频，转向退出状态。 |
| **`THINKING`** | `FORCE_STOP` | `CLOSING` | 强行终止：取消在途 LLM/TTS 请求，转向退出状态。 |
| **`SPEAKING`** | `VAD_SPEECH_START` | `LISTENING` | 播放中打断（Barge-in）：执行 `playbackGeneration++`（使在途 TTS 块失效并停止播放），`turnVersion++`，开始向 ASR 发送音频，重置 `turnCount`。 |
| **`SPEAKING`** | `PLAYBACK_END` | `AWAITING_FOLLOWUP` | 正常播放完毕（且 `turnCount < MAX_FOLLOWUP_TURNS`）：保持麦克风开启，启动 `IDLE_NUDGE_MS`（9s）静音定时器，开始将音频发送至 ASR。 |
| **`SPEAKING`** | `PLAYBACK_END` | `CLOSING` | 正常播放完毕（且 `turnCount >= MAX_FOLLOWUP_TURNS`）：达到多轮接话上限，不进入续问窗，直接启动退出流程。 |
| **`SPEAKING`** | `LLM_DONE(isExit=true)` | `CLOSING` | 检测到 LLM 退出标记：停止后续播放生成，立刻转向退出状态。 |
| **`SPEAKING`** | `FORCE_STOP` | `CLOSING` | 强行终止：执行 `playbackGeneration++` 停止播放，转向退出状态。 |
| **`AWAITING_FOLLOWUP`**| `VAD_SPEECH_START` | `LISTENING` | 续问窗内孩子接话：清除 `idleNudge` 与 `idleExit` 定时器，`turnVersion++`，开始正常发送音频至 ASR，`turnCount++`。 |
| **`AWAITING_FOLLOWUP`**| `TIMEOUT_IDLE_NUDGE`| `AWAITING_FOLLOWUP` | 续问窗 9s 静音：播放闲时提醒语音，启动 `IDLE_EXIT_MS`（9s）退出定时器。 |
| **`AWAITING_FOLLOWUP`**| `TIMEOUT_IDLE_EXIT` | `CLOSING` | 提醒后 9s 仍无响应：关闭录音，启动退出流程。 |
| **`AWAITING_FOLLOWUP`**| `FORCE_STOP` | `CLOSING` | 强行终止：关闭录音，转向退出流程。 |
| **`CLOSING`** | `TTS_PLAYBACK_END` / `TIMEOUT_EXIT_FALLBACK` | `SLEEPING` | 告别词播放结束：彻底释放麦克风，调用 `startWakeListening()`，重置 `turnVersion = 0`，`turnCount = 0`。 |

### 2. 理由
* **【事实】**：散落在 20+ 个 useState/useRef 和 7 个 timer 中的控制逻辑存在隐式依赖，极易产生非预期叠加（例如在退出过程中突然触发 ASR 的 `final` 导致重新开麦）。
* **【推断】**：将核心交互行为收拢为显式的状态转移矩阵，能从根本上消除竞态条件。状态机作为单一真相源（Single Source of Truth），可确保任何状态下的事件响应都是确定且排他的。

### 3. 风险
* **异常流阻塞风险**：如果发生底层网络错误（如 WebSocket 断开）或 Native 语音引擎抛错，若未在 FSM 中为所有状态配置对应的 `ERROR` 降级转移，状态机可能会锁死在 `THINKING` 或 `CLOSING` 状态。
* **打断判定过灵敏**：在 `SPEAKING` 状态下，TTS 自身的扬声器漏音可能回授到麦克风，被 VAD 误判为 `VAD_SPEECH_START`，导致频繁发生自我打断。

### 4. 实施要点
* 在 FSM 设计中必须包含全局 `ERROR` 转移：在除 `SLEEPING` 外的任何状态下收到 `ERROR` 事件，必须无条件清理当前轮次，播放错误提示，并转移至 `CLOSING` 进行硬件释放，确保系统可恢复性。
* 调试期间增加 FSM 转移日志打印，格式统一为 `[FSM] ${PrevState} --(${Event})--> ${NextState}`，便于通过日志快速定位非预期状态流转。

---

## ② 有界续问窗实现

### 1. 设计
* **麦克风连续开启机制**：
  进入 `AWAITING_FOLLOWUP` 时，不调用 `stopRecording()` 释放硬件。采用“逻辑静音门控（Logical Gate）”设计：
  * 在 `LISTENING` 和 `AWAITING_FOLLOWUP` 状态下，门控开启，将采集到的 PCM 数据包通过 WebSocket 发送给 ASR。
  * 在 `THINKING` 和 `SPEAKING`（非打断状态）状态下，门控关闭，直接在本地丢弃采集到的音频数据，不进行网络传输与识别。
* **静音超时判定与 VAD 复用**：
  * 放弃散落的 timer 累加，统一使用本地 Web-VAD（或 Native VAD 服务）检测。
  * 当状态机转移至 `AWAITING_FOLLOWUP` 时，同步启动本地 VAD 监听，并在 React 侧开启一个 9s 的 `idleNudgeTimer`。
  * 如果在 9s 内 VAD 触发了 `VAD_SPEECH_START`，表明孩子开始接话，立即清除 `idleNudgeTimer`，状态转移至 `LISTENING` 并开始传输音频。
  * 如果 9s 内 VAD 无响应，触发 `TIMEOUT_IDLE_NUDGE`，播放闲时提醒（如“小可还在听哦”），同时启动 9s 的 `idleExitTimer`。如果在提醒播放期间或之后 9s 仍无 VAD 信号，触发 `TIMEOUT_IDLE_EXIT` 转移至 `CLOSING`。
* **轮数限制与多轮协调**：
  * 在状态机 State 中维护 `turnCount` 变量。
  * 首轮通过 `WAKE_UP` 或 `PTT_PRESS` 触发时，`turnCount` 初始化为 `0`。
  * 之后在 `AWAITING_FOLLOWUP` 中每一次通过 `VAD_SPEECH_START` 成功接话并转向 `LISTENING` 时，执行 `turnCount++`。
  * 当某轮 TTS 播放结束（`PLAYBACK_END`）时，检查 `turnCount` 是否已达到 `MAX_FOLLOWUP_TURNS (4)`。如果达到，则直接强行转移至 `CLOSING` 状态播放告别语并关闭麦克风，不再进入 `AWAITING_FOLLOWUP`。

### 2. 理由
* **【事实】**：每次开麦需要重新初始化 `AudioRecord` 并重新分配硬件缓冲区，会带来 300ms 以上的物理延迟，且部分 Android 设备会伴随系统级“啵”声。
* **【推断】**：在续问窗内保持麦克风物理处于激活状态（仅在逻辑层控制流的启用与切断），可以消除由于频繁重新开麦带来的硬件延迟与杂音，提供类似于 Gemini Live 的无缝连贯对话体验。设置 4 轮的硬上限可以防止在嘈杂环境下因环境噪声误触发而导致 AI 无休止自言自语。

### 3. 风险
* **隐私顾虑与耗电**：麦克风长时间物理开启会导致设备电量消耗增加，且在没有视觉提示的情况下持续开麦可能引发家长对隐私的担忧。
* **回声消除（AEC）失效导致自打断**：在 `AWAITING_FOLLOWUP` 状态播放 Nudge 音频时，如果 AEC 性能不佳，Nudge 自身的音频会被麦克风录入并触发 VAD，导致 AI 自己唤醒自己。

### 4. 实施要点
* **逻辑门控的物理隔离**：麦克风保持开启是指 `MediaStreamTrack.enabled = true`，但必须在传输模块的发送端进行严格的数据流截断（Discard Audio Buffer at Source），绝对禁止在 `THINKING` 阶段向 ASR 传输环境噪音。
* 在播放 Nudge 填充音或提示音期间，需短暂调高 VAD 门限阈值或直接在播放期间暂停 VAD 判定，待播放结束后再重新开启，规避自打断问题。

---

## ③ versioned state 设计

### 1. 设计

#### 数据结构定义
```typescript
interface VersionedFsmState {
  status: FsmStatus;
  turnVersion: number;        // 全局对话轮次版本，每次新交互（包含打断/接话）递增
  playbackGeneration: number; // 播放代次，每次停止播放/打断递增
  capturedTurnMeta: {
    turnId: string;
    asrText: string;
    timestamp: number;
  } | null;                   // 当前正在处理的轮次元数据快照
}
```

#### 补丁收编与防污染机制

```
[ASR / LLM / TTS 异步任务生命周期控制]

 发生打断 (Barge-In) / 新轮次触发:
   state.turnVersion++
   state.playbackGeneration++

                        +--------------------------+
                        |   异步事件 (Event Payload) |
                        +--------------------------+
                                     |
                                     v
                       Is Event.version === CurrentVersion?
                                  /     \
                                YES      NO
                                /         \
                               v           v
                       [处理/允许状态转移]    [彻底丢弃 (Ignore)]
```

* **收编 `capturedTurnMeta`**：
  * 当 ASR 判定结束或 PTT 释放，向后端发送 LLM 请求前，生成当前 `turnVersion` 对应的 `capturedTurnMeta` 快照。
  * 后续所有发出的 LLM 请求、TTS 请求均必须在 Payload 中携带当前的 `turnVersion`。
* **收编 `playbackGeneration`**：
  * 每次向播放队列推送新的 TTS 音频段时，均打上当前的 `playbackGeneration` 标签。
  * 一旦发生打断事件（`VAD_SPEECH_START`）或用户手动强停，状态机在转移时执行 `playbackGeneration++`。
  * 播放器的音频片调度器在播放下一片前检查：如果该音频段的 `generation < currentPlaybackGeneration`，则立即丢弃，停止送入音频输出管道。
* **收编 `activeTurn` / `discardTurnAtOrBelow`**：
  * 用 `turnVersion` 统一作为过滤屏障。令 `discardTurnAtOrBelow = state.turnVersion - 1`。
  * ASR 最终文本返回（`asr.final`）、LLM 文本生成返回（`llm.delta`/`llm.done`）、以及 TTS 音频流推送，只要其携带的 `version <= discardTurnAtOrBelow`，前端业务逻辑直接在入口处拦截丢弃，不触发任何状态转移与界面渲染。

### 2. 理由
* **【事实】**：ASR 识别结果、LLM 网络响应及 TTS 音频生成均为高度异步的网络 IO。在不稳定的移动网络下，乱序到达是高频发生事件。
* **【推断】**：引入全局单调递增的双重版本号（`turnVersion` 针对业务流，`playbackGeneration` 针对音频流），可以在入口处物理隔离掉过期的异步回调，避免“上一轮迟到的 ASR 最终识别结果”误触发新一轮的对话，从根本上解决“告别不干净”与“话语混杂”的问题。

### 3. 风险
* **内存积压**：如果老版本的 TTS 音频段已经被下载并积压在内存队列中，未能被及时 GC 释放，可能会在频繁打断时导致 WebView 内存消耗激增。
* **版本号不同步**：如果前端递增了版本号，而某些底层长连接异步事件未能在其回调中带回对应的版本号，会导致正常的数据包被误判为“过期数据”而丢弃。

### 4. 实施要点
* **闭包防护**：在 React `useEffect` 或事件监听器（ASR / TTS / Bridge）中，必须通过 `useRef` 同步读取最新的 `turnVersion` 和 `playbackGeneration` 进行比对，避免因 React hook 闭包捕获旧 State 导致判定失效。
* 明确定义丢弃逻辑并加入监控埋点，当丢弃发生时在控制台输出：`[Version Filter] Discarded payload of version ${payload.version}, current active version is ${currentVersion}`。

---

## ④ 现有功能映射与麦克风互斥铁律

### 1. 设计

#### 麦克风独占控制规范 (Hardware Exclusive Access)
* **【事实】**：Porcupine/Sherpa 原生唤醒引擎与 Web 端的 `getUserMedia`（或原生 Recorder）共享同一物理输入麦克风，在 Android 平台中无法并发独占，必须实施严格的“先释放、再占有”的串行化机制。
* **状态机执行路径规范**：
  * **开麦路径 (`SLEEPING` -> `LISTENING`)**：
    1. 调用 Native Bridge 的 `pauseWakeListening()` 挂起唤醒词引擎。
    2. **必须等待唤醒释放成功的 Promise resolve 确认（或设置 150ms 强制延迟）**。
    3. 调用 `startRecording()` 开启 Web 端录音。
  * **关麦路径 (`CLOSING` -> `SLEEPING`)**：
    1. 退出 TTS 播放完毕或超时，调用 `stopRecording()` 释放 Web 端麦克风。
    2. **等待录音完全关闭的 Promise resolve**。
    3. 调用 Native Bridge 的 `startWakeListening()` 重新挂载唤醒词引擎。

#### 功能融合映射关系

```
[功能模块]                       [FSM 挂载点与控制逻辑]
------------------------------------------------------------------------------------------
唤醒词 (Wake Word) ------------> 仅在 SLEEPING 激活。唤醒触发 WAKE_UP 事件。
PTT (按住说话) ----------------> 任何非 LISTENING 状态按下 -> 强转 LISTENING (清空当前轮, version++)。
吐槽模式 (Feedback) ------------> LISTENING (打上 feedbackMode 标记) -> VAD 结束 -> 不请求 LLM ->
                                写入本地库 -> 播放“感谢反馈”TTS -> 转向 CLOSING。
填充音 (Thinking Cue) ---------> 进入 THINKING 后延迟 300ms 触发。LLM.delta 到达时若已播放则淡出，
                                未播放则取消定时器。
退出意图拦截 (L1/L2/L3) --------> L1: ASR Final 命中白名单 -> 直接丢弃请求，转向 CLOSING。
                                L2: LLM.done 携带 [EXIT] -> 停止后续 TTS，转向 CLOSING。
                                L3: AWAITING 9s+9s 超时 -> 触发 TIMEOUT_IDLE_EXIT，转向 CLOSING。
麦克风互斥 ---------------------> 转换 [SLEEPING -> LISTENING] 与 [CLOSING -> SLEEPING] 时严格串行控制。
```

### 2. 理由
* **【事实】**：如果直接并发抢占麦克风，Android 底层 AudioRecord 会抛出 `EGeneric` 或 `DeviceBusy` 错误，表现为开麦失败、录音无声或唤醒引擎永久死锁。
* **【推断】**：将麦克风与唤醒器的控制动作声明式绑定在 FSM 的转换边界上，可确保在任何极端操作（如快速狂点 PTT）下，硬件状态的切换顺序都是安全且受控的。

### 3. 风险
* **Bridge 异步挂起风险**：如果 Native 端的 `pauseWakeListening` 由于内部线程卡死而没有返回 resolve，前端状态机将永久阻塞在转换中间态，导致后续无法开麦。
* **双端状态失步**：如果用户拔出耳机或系统因电话接入夺取了音频焦点，Native 的硬件状态发生物理改变，但前端 FSM 未能及时感知并处理此异常，会造成状态失步。

### 4. 实施要点
* 对所有的 Native 麦克风控制 Bridge 调用包裹超时器（例如 `Promise.race` 设定 500ms 超时），一旦 Bridge 异常未响应，立即强行按“调用成功”向下执行并记录 Warn 日志，防止界面卡死。
* 在 Native 侧监听 Android 音频焦点丢失事件（`onAudioFocusChange`），一旦丢失，通过 Bridge 发送 `FORCE_STOP` 事件给前端状态机，退回 `SLEEPING` 状态以释放资源。

---

## ⑤ React hook 落地

### 1. 设计
* **架构选择**：**「手搓 Reducer 状态转移 (用于渲染) + Single StateRef (用于异步读取) + React Context/Refs (用于硬件与定时器)」**。
* **理由**：不使用 XState 等重型框架。儿童 Demo 场景对体积要求高，且原生 Bridge 的回调与 React 的闭包状态极易冲突。手搓 Reducer 可确保逻辑的高透明度与零依赖。
* **数据存储与管理方案**：
  * **进入 FSM State（触发 UI 重新渲染）**：
    * `status` (当前状态)
    * `turnVersion` (当前轮次版本)
    * `turnCount` (当前 followup 计数)
  * **保留在 `useRef` 中（不触发渲染，作为副作用控制）**：
    * `stateRef`：同步指向最新的 FSM State。所有的异步回调事件（如 ASR final / TTS 播放段）在读取当前状态以做版本校验时，**必须**从 `stateRef.current` 中读取，避开闭包过时问题。
    * `timersRef`：管理 7 个定时器的引用。在 Reducer 执行或包装的 `dispatch` 逻辑中，切换状态前必须显式清理关联的定时器。
    * `clientRef` / `webSocketRef`：网络连接与音频传输的底层句柄。

#### 核心代码骨架示例
```typescript
type FsmStatus = 'SLEEPING' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'AWAITING_FOLLOWUP' | 'CLOSING';

interface FsmState {
  status: FsmStatus;
  turnVersion: number;
  playbackGeneration: number;
  turnCount: number;
}

// 纯函数 Reducer，仅负责计算下一状态与版本升级
function fsmReducer(state: FsmState, action: FsmAction): FsmState {
  switch (state.status) {
    case 'SLEEPING':
      if (action.type === 'WAKE_UP') {
        return {
          status: 'LISTENING',
          turnVersion: state.turnVersion + 1,
          playbackGeneration: state.playbackGeneration + 1,
          turnCount: 0,
        };
      }
      break;
    case 'SPEAKING':
      if (action.type === 'VAD_SPEECH_START') { // Barge-in
        return {
          status: 'LISTENING',
          turnVersion: state.turnVersion + 1,
          playbackGeneration: state.playbackGeneration + 1,
          turnCount: 0, // 打断后重置多轮计数
        };
      }
      if (action.type === 'PLAYBACK_END') {
        if (state.turnCount >= 4) {
          return { ...state, status: 'CLOSING' };
        }
        return { ...state, status: 'AWAITING_FOLLOWUP' };
      }
      break;
    // 其他转移逻辑 ...
  }
  return state;
}
```

### 2. 理由
* **【事实】**：React 的 `useState` 在组件渲染周期内是常量，异步事件处理器（如 ASR、TTS Bridge）在注册时绑定了旧的上下文（Stale Closure），导致回调执行时读取的变量值永远是旧的。
* **【推断】**：将核心转移抽取为纯 Reducer 函数便于隔离测试；通过组件顶层双向绑定的 `stateRef` 可保证异步事件处理器随时获取实时的全局状态与版本号，消除由于 React 生命周期导致的竞态条件。

### 3. 风险
* **副作用管理混乱**：Reducer 本身是纯函数，不能处理“调用 Native Bridge 开启麦克风”或“清理定时器”等副作用。如果副作用代码散落在组件各处，容易导致与状态机失步。
* **状态不同步**：如果直接更新了 `stateRef` 而忘记调用 `dispatch`，或者 `dispatch` 之后没有更新 `stateRef`，会导致渲染层和逻辑控制层状态分裂。

### 4. 实施要点
* **包装 Dispatch 函数**：在 Hook 中封装一个 `sendEvent(action)` 函数作为唯一修改入口。在其中先调用 `dispatch(action)` 更新 React 渲染状态，同步更新 `stateRef.current`，然后根据最新的 `state` 统一执行副作用（清理定时器、调 Bridge 麦克风等）。
* **定时器物理防漏**：编写 `clearTimersForState(nextState)` 助手函数。在 `sendEvent` 发生状态转移时，根据目标状态自动物理清理前置状态的定时器，杜绝内存泄漏和定时器在后台野跑。

---

## ⑥ 实施策略

### 1. 设计
为保证儿童 Demo 线上功能的稳定性，拒绝一步到位的推倒重写，推荐采用**「影子状态机逻辑验证 -> 核心链路逐步替换 -> 单元测试双向守护」**的渐进重构策略。

```
[第一阶段: 独立开发与测试]
   - 编写纯函数 `fsmReducer.ts`
   - 编写 Jest 单元测试覆盖 100% 转移矩阵

[第二阶段: 影子状态机上线运行 (不接管硬件)]
   - 在 useMobileVoice 中平行引入 FsmState 与 sendEvent
   - 在现有老事件 handler 中同步调用 sendEvent
   - 对比 [老状态] 与 [影子状态机状态]，输出 Debug 日志进行边界校准

[第三阶段: 硬件与逻辑完全接管]
   - 切断老状态变量，将组件控制与 UI 绑定到 FsmState.status
   - 启用 FSM 的 Version 机制过滤网络异步回调
   - 移除老 useState/useRef，清理无效补丁代码
```

### 2. 理由
* **【事实】**：`useMobileVoice.ts` 内部涉及的原生 Bridge 交互、VAD 逻辑判定以及 Volcano ASR/TTS 服务接口极为繁琐，重写极易丢失隐式边界细节。
* **【推断】**：影子状态机模式（Shadow FSM）可以在完全不干扰线上运行逻辑的前提下，利用真实用户的现场操作数据来检验重构状态机的正确性与鲁棒性。

### 3. 风险
* **老代码过度交织**：在影子阶段，老代码的 Timer 和状态可能与新状态机的 Action 发生干扰，难以实现完全的“无副作用”运行。
* **重构周期过长**：影子测试可能会产生大量边界不一致日志，如果过度追求影子状态机的完美映射，会拖延方案正式上线的进度。

### 4. 实施要点
* **单测准入标准**：针对 `fsmReducer` 编写全面的 Jest 测试用例，测试用例必须显式包含：
  1. 正常多轮对话状态机流转。
  2. 播放中发生 Barge-in 时，`playbackGeneration` 与 `turnVersion` 的自增。
  3. L3 闲时超时告别与退出过程中，唤醒引擎与麦克风开启顺序校验。
* **一键回滚降级设计**：在 Hook 中设置 Feature Flag：`const USE_FSM = true;`。当该 Flag 为 `false` 时，整个 Hook 绕过状态机逻辑，回退到原有的 20+ 个散落 useState 逻辑中，为上线初期提供一道安全防护门。

---

署名：gemini（Google）
