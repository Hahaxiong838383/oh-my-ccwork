## 评审结论：推荐「Web 每轮管」为正解，即方向 X，但要做成 **X + Z 的协议修正版**

不建议继续走方向 Y 的「原生连续识别直接产出多轮 chat」。原生可以保持音频线程/Recognizer 常驻以降低延迟，但**对话轮次必须由 Web 状态机统一管理**：什么时候收音、什么时候只允许一个 final、什么时候 thinking/speaking、什么时候 followup、什么时候 exit，都应由 Web 决定。

更准确地说：

> **推荐方案 = Web 管一轮一轮的对话状态；原生 ASR 只负责当前 turn 的识别。端侧 endpoint 后不要 reset 后继续自动产出下一句，而应 pause/stop-on-endpoint，等待 Web 下一次 beginTurn。**

这相当于方向 X 的原则 + 方向 Z 的 native 行为修正。

---

## 1. 状态机正解

### 推荐：X，不推荐 Y

#### 为什么 X 更正确

云火山链路的正确性来自一个核心约束：

> 一轮用户输入只产生一个 LLM 请求；LLM/TTS 播完后，Web 再决定是否进入下一轮 followup。

端侧 ASR 如果让原生 continuous mode 自己不断 endpoint/final，就会绕过 Web 的 turn 管理，导致：

1. 一个用户句子被切成多段，多个 final 直接触发多个 chat。
2. Web 不知道当前到底是“还在录音一轮”还是“已经进入 thinking/speaking”。
3. `listeningByWake`、`turnCount`、idle timer、startExit/finalizeExit 语义被破坏。
4. TTS overlap、按钮红、语音打断等都会变成补丁式修复。

方向 Y 可以临时止血，但本质会引入一套端侧专用状态机，最后还是要重新实现 Web 已有的 turn/idle/exit 逻辑，长期更容易出 bug。

### 正确形态

端侧状态机应对齐云火山：

```text
wake/PTT
  → Web beginTurn(turnId)
  → native startAsr(turnId, mode, stopOnEndpoint=true)
  → partial 更新字幕
  → endpoint/final
  → Web close current turn：清 recording/listening，thinking
  → Web 接受本 turn 唯一 final，bargeIn/abort stale TTS，然后 sendChatTrigger
  → LLM/TTS
  → playback_end
  → Web 决定 followup beginTurn 或 idle/exit
```

原生可以继续持有 AudioRecord，但**不能在 endpoint 后 reset stream 并继续向 Web 产出下一句 final**。应该改成：

```text
ASR_ARMED(turnId)
  → endpoint
  → compute final
  → notify final once
  → ASR_PAUSED/WAIT_WEB_NEXT_TURN
```

也就是说，“连续持有麦克风”可以保留，“连续产生对话轮次”不应保留。

---

## 关键实现要点：避免 endpoint final 与 stopAsr final 二次触发

当前最大协议问题是：

> `stopAsr()` 会 flush stream 并且也 `notifyAsrFinal`，这会和 endpoint final 重复。

需要把“停止控制”和“提交识别结果”拆开。

### 建议 bridge/native 协议

#### 1. 所有 ASR 事件都带 `turnId`

```ts
startAsr({ turnId, mode: 'auto' | 'ptt', stopOnEndpoint: true })
onAsrPartial({ turnId, text })
onAsrEndpoint({ turnId })
onAsrFinal({ turnId, text, reason: 'endpoint' | 'ptt_release' | 'flush' })
stopAsr({ turnId, emitFinal: false, reason: 'cancel' | 'exit' | 'tts' })
```

#### 2. `stopAsr()` 默认不应发 final

`stopAsr()` 是控制命令，不应无条件产生业务 final。

建议语义：

```ts
stopAsr({ emitFinal: false }) // cancel/exit/切状态，绝不触发 chat
commitAsr() 或 stopAsr({ emitFinal: true }) // PTT 松手等明确提交场景
```

#### 3. endpoint 场景由 native 一次性提交 final，然后 pause

endpoint 命中后，native 应该：

```text
isEndpoint()
  → finalText = recognizer.getResult()
  → notifyAsrFinal(turnId, finalText, reason='endpoint')
  → reset/pause recognizer
  → 不继续监听下一句
  → 等 Web 下一次 startAsr
```

不要 endpoint 先通知 Web，然后 Web 立刻 stopAsr，native 又 flush 一次 final。最好把 endpoint 与 final 合成一个“utterance final”业务事件，`onAsrEndpoint` 只作为 UI/调试事件。

#### 4. Web 侧必须做 final 去重和单轮锁

Web 每个 turn 只能接受一个 final：

```ts
if (event.turnId !== activeTurnId) ignore;
if (finalAcceptedForTurn) ignore;
if (!isAsrTurnClosingOrListening) ignore;
if (!text.trim()) handleNoSpeech();

finalAcceptedForTurn = true;
clearRecordingFlags();
setVoiceStatus('thinking');

client.bargeIn(); // 停旧 TTS/旧流
client.sendChatTrigger(text);
```

即使 native 因竞态多发了一次 final，Web 也不能二次 chat。

---

## 2. bug1：双声音叠

### 根因

不只是缺少 `bargeIn`，更根本是：

> 原生 continuous ASR 把一个唤醒后的多段 endpoint 都当成独立 chat final，Web 没有一轮只允许一个 final 的保护。

孩子一句话被 `rule2=1.1s` 切成多段后，多次 `sendChatTrigger`，旧 TTS 没被取消，新 TTS 又开始，于是叠音。

### 必修修复

1. **端侧一轮只允许一个 final。**
   - Web 维护 `turnId + finalAccepted`。
   - 同一个 turn 的第二个 final 直接丢弃。

2. **`onAsrFinal` 前必须执行 bargeIn/abort。**
   - `client.bargeIn()` 或等价的 `stop current TTS + abort current LLM stream`。
   - 同时给 TTS/LLM 响应加 `responseId`，旧 response 的音频 chunk 到达时直接丢弃，避免服务端旧流晚到又播放。

3. **endpoint 后 native 不再连续 reset 产出下一句。**
   - endpoint final 后 pause，等待 Web 的下一次 `beginTurn()`。
   - followup 由 `onPlaybackEnd()` 触发，而不是 native 自己连续识别触发。

4. **调长 endpoint 切句阈值。**
   - `rule2=1.1s` 对儿童说话偏短，容易把思考停顿切成两句。
   - demo 建议 auto 模式先调到约 `1.6s ~ 2.0s`。
   - PTT 模式可以短一些，因为松手本身就是硬终止。

5. **可选：endpoint debounce/merge。**
   - endpoint 后可等待一个很短 grace window，例如 300~500ms。
   - 如果马上又有明显 speech，可合并为同一 utterance。
   - 但这只是改善切句体验，不能替代“一轮只接受一个 final”的状态机保护。

结论：`onAsrFinal` 加 bargeIn 是必要止血，但根治是 **turn lock + native stop-on-endpoint + stale response discard**。

---

## 3. bug2：底部按钮一直红、脉冲环常转

### 根因

`recording = pressed || listeningByWake` 这个定义在云 ASR 中成立，因为 `listeningByWake` 等价于“Web 正在录这一轮”。

端侧 continuous 模式下，`listeningByWake` 被设为 true 后不再清除，变成“对话会话中”标志，导致 UI 永远认为在录音。

### 正确做法

端侧需要区分两个概念：

1. **conversation active**：当前处在小可对话会话里。
2. **accepting speech / recording UI**：当前这一轮正在收孩子说话。

按钮红色和脉冲环应该绑定第二个，而不是第一个。

建议：

```ts
recording =
  pressed ||
  (
    deviceAsrMode &&
    deviceTurnArmed &&
    voiceStatus === 'listening' &&
    !isThinking &&
    !isSpeaking
  );
```

或者更清晰：

```ts
recording = pressed || acceptingSpeech;
```

其中：

```text
beginTurn/startAsr        → acceptingSpeech = true
endpoint/final/PTT release → acceptingSpeech = false
thinking                  → false
speaking                  → false
idle/KWS                  → false
exit/cancel               → false
```

如果继续复用 `listeningByWake`，也必须在端侧 endpoint/final 时清掉：

```text
onAsrEndpoint/onAsrFinal/closeTurn
  → listeningByWake = false
```

但更推荐语义上拆成 `acceptingSpeech`，避免 `listeningByWake` 同时承担“唤醒对话中”和“正在录音”的双重含义。

---

## 4. bug3：小可说话时喊“小可小可”打不断

### 本质冲突

TTS 期间 gate KWS 可以防自唤醒，但副作用是：

> 同一麦克风被 TTS gate 掉后，孩子喊唤醒词也被丢了。

这是真实冲突，不能靠单纯“永远 gate KWS”解决。

### demo 阶段可落地方案

建议分两层做。

---

### 方案 A：文本感知 KWS gating

不是所有 TTS 都全程 gate KWS，而是按 TTS 文本风险决定。

#### 规则

1. 如果 TTS 文本包含“小可”“小可小可”或近似唤醒词：
   - 对该词附近的播放窗口强 gate KWS。
   - demo 简化版可以整句 gate。
   - 防止小可自己说“小可”把自己唤醒。

2. 如果 TTS 文本不包含唤醒词：
   - KWS 不完全关闭，而是降敏运行。
   - 提高唤醒阈值。
   - 要求连续命中。
   - 要求近端人声能量明显高于当前播放回声。

示意：

```text
TTS contains wake word:
  KWS gate strong

TTS does not contain wake word:
  KWS keep running with stricter threshold
  if wake detected:
    bargeIn TTS
    beginTurn()
```

这样大部分普通 TTS 期间可以语音打断；只有小可自己说到“小可”时重点防自唤醒。

---

### 方案 B：能量门 barge-in

即使 KWS 被 gate，也保留一个轻量级“有人插话”的检测。

规则：

```text
TTS playing
  → 监听 mic RMS/near-end energy
  → 如果连续 200~300ms 明显高于播放回声/环境基线
  → 判定 barge-in
  → 立即 stop TTS / client.bargeIn()
  → setVoiceStatus('listening')
  → startAsr(new turn)
```

demo 阶段不要求精准识别“小可小可”，只要孩子大声说话时能打断小可即可。

可加保护：

1. TTS 开始后前 300ms 不触发，避免启动瞬态。
2. 需要能量超过环境基线 N dB。
3. 如果能拿到播放音量/AudioTrack 能量，则要求 mic 能量与播放包络不强相关。
4. Android 侧尽量启用 `AcousticEchoCanceler` / `NoiseSuppressor`，降低自声误触发。

---

### 组合推荐

demo 期最稳组合：

```text
普通 TTS：
  KWS 降敏继续运行 + 能量门 barge-in

TTS 文本含“小可”：
  KWS 强 gate，避免自唤醒
  但能量门仍可触发打断

用户喊“小可小可”：
  如果 KWS 命中 → bargeIn + beginTurn
  如果 KWS 被 gate 但能量门命中 → 先停 TTS，再进入 listening
```

这样既能保住“防自唤醒”，又能恢复基本语音打断能力。

---

## 三个 bug 的修复摘要

### bug1：双声音叠

必须修：

```text
onAsrFinal:
  - turnId 校验
  - finalAccepted 去重
  - client.bargeIn()/abort stale response
  - sendChatTrigger only once
```

同时 native：

```text
endpoint final 后 pause，不 reset 后继续产出下一句。
stopAsr 默认不 emit final。
```

体验优化：

```text
auto endpoint rule2 从 1.1s 调长到约 1.6~2.0s。
```

---

### bug2：按钮一直红

不要用“原生还在连续监听”驱动红色按钮。

按钮红/脉冲应表示：

```text
当前 turn 正在接受孩子说话
```

而不是：

```text
会话还没结束 / AudioRecord 线程还活着 / KWS 正在听
```

建议新增或重定义：

```ts
acceptingSpeech = true only between beginTurn and endpoint/final/PTT release;
recording = pressed || acceptingSpeech;
```

---

### bug3：语音打断丢失

TTS 期间不要全局无脑 gate KWS。

demo 推荐：

```text
TTS 不含“小可”：KWS 降敏继续跑。
TTS 含“小可”：只对高风险窗口强 gate。
任何 TTS：保留能量门 barge-in，大声插话可先停 TTS。
```

触发后：

```text
client.bargeIn()
stop current TTS
discard stale TTS chunks
beginTurn(new turn)
```

---

## demo 一句话结论

端侧 ASR 不应让原生 continuous mode 自己驱动多轮对话；应回到 Web 统一的一轮一轮状态机：**一轮只收一个 final、endpoint 后暂停等 Web re-arm、final 前必 bargeIn、按钮只表示当前 turn 正在收音，TTS 期间用“文本感知 KWS gating + 能量门 barge-in”兼顾防自唤醒和语音打断。**

署名：codex（OpenAI）
