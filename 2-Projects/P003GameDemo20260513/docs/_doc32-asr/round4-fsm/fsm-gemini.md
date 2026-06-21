# 评审报告：小可端侧 ASR 接入与语音状态机设计评审及 Bug 修复方案

## 1. 状态机正解评估

**明确推荐：采用「方向 X（Web 掌控每轮生命周期，端侧对齐云火山）」**

### 理由：
1. **单一真源原则**：儿童陪伴场景的状态机极其复杂（包含：多轮对话计数、多级静默超时 nudge、自动告别退出等）。若采用方向 Y（原生连续监听），相当于在 Native 和 Web 侧维护了两个并行的生命周期，极易出现状态不同步。Web 必须作为整场对话的“大脑”（State Machine Controller），Native 仅作为“流式输入与切句设备”（Sensor）。
2. **状态自然对齐**：采用方向 X，Web 侧的 `listeningByWake`、`pressed`、`recording`、按钮 UI 脉冲环等状态可以直接复用原有逻辑，无需为端侧开发另一套不红的“对话中”过渡态，代码修改量最小且最不易退化。
3. **消除二次触发隐患**：通过 Web 显式控制每轮的启动（`startAsr`）与结束（`stopAsr`），可以从物理上切断 Native 在非录音阶段（如 TTS 播报期）产生多余 Endpoint / Final 回调的可能。

---

### 关键实现要点与时序设计

为了彻底避免 `onAsrEndpoint`、`onAsrFinal` 和 `stopAsr` 之间的二次触发冲突，推荐采用以下收口协议：

```
[用户说话] 
   ↓
Native: 判定静音检测命中 
   ↓
Native: notifyAsrEndpoint() 
   ↓
Web: onAsrEndpoint() -> setVoiceStatus('thinking') [仅做 UI 切换，不调 finishTurn]
   ↓
Native: 完成最后一帧解码 
   ↓
Native: notifyAsrFinal(text) 
   ↓
Web: onAsrFinal(text) -> 
     1. 立即执行 finishTurn() -> 内部触发 Native: stopAsr() 释放麦克风
     2. 执行 clientRef.current.sendChatTrigger(text) 开启 LLM 请求
   ↓
[TTS 播放完毕] 
   ↓
Web: onPlaybackEnd() -> 若多轮未超限 -> followup beginTurn() -> 内部触发 Native: startAsr() 重启下一轮
```

#### 避免二次 final 触发的防卷机制：
* **Native 侧保障**：Native 接收到 `stopAsr()` 时，若当前流已经被 `isEndpoint()` 触发过 reset/notify，则直接释放资源，**不再**二次回调 `notifyAsrFinal`。
* **Web 侧兜底**：Web 侧在 `useDeviceAsrRef` 逻辑中引入 `turnActiveRef.current` 哨兵变量。`beginTurn` 时置为 `true`，首次收到 `onAsrFinal` 并进入 `finishTurn` 时置为 `false`。在 `false` 状态下拒绝任何后续的 `onAsrFinal` 回调。

---

## 2. 三个真机 Bug 修复方案

### Bug 1: 双声音叠加（TTS 重叠）
* **根本原因**：
  1. 端侧 ASR 在连续监听模式下，由于儿童停顿（Rule2 仅 1.1s）频繁切句，导致短时间内触发了多次 `onAsrFinal` -> 产生多个 `sendChatTrigger` 请求。
  2. 端侧 `onAsrFinal` 触发 LLM 请求时，未像云端火山链路那样调用 `client.bargeIn()` 抢占打断在途的 TTS 播报。
* **修复要点**：
  1. **采用方向 X**：一旦命中 Endpoint 并输出 Final，立即在 Web 侧执行 `finishTurn()` 并调用 Native `stopAsr()` 关停 ASR，从根本上杜绝在一轮对话中产生第二个 Final 请求。
  2. **调优切句参数**：由于服务对象是儿童（语速慢、停顿长），Native 侧 `sherpa-onnx` 的 Endpoint `rule2`（检测到有说话后的静音退屏时间）应从 1.1s **调长至 1.5s ~ 1.8s**，防止儿童说话中间停顿被误切句。
  3. **补充打断逻辑**：在 Web 侧 `onAsrFinal` 触发 `sendChatTrigger` 之前，强制调用 `tts.stop()` / `client.bargeIn()` 以确保清理任何未播完的旧 TTS 音频。

### Bug 2: 底部按钮一直红 / 脉冲环常转
* **根本原因**：
  端侧 beginTurn 时设置了 `listeningByWake = true`，但端侧未走 `finishTurn()`，导致该标志位在对话建立后从未被置为 `false`，从而导致 `recording = pressed || listeningByWake` 恒为 `true`。
* **修复要点**：
  依照方向 X，在 Web 端接收到 `onAsrFinal` 之后，必须完整执行 `finishTurn()`。在 `finishTurn` 内部，需确保清除 `listeningByWake` 和 `pressed` 标记，使按钮状态机回归正常收口逻辑。

### Bug 3: 语音打断失效（TTS 期间喊「小可小可」打不断）
* **根本原因**：
  为防止 TTS 自唤醒，Native 侧在播放 TTS 时（`notifyTtsState true`）粗暴地丢弃了 ASR 物理帧并关停了 KWS，导致真人在 TTS 期间喊唤醒词同样被物理屏蔽。
* **修复要点（Demo 阶段落地建议）**：
  1. **系统 AEC 降噪（首选原生修复）**：Native 侧 `AudioEngine` 在构建 `AudioRecord` 时，输入源应指定为 `MediaRecorder.AudioSource.VOICE_COMMUNICATION`。这会强制启用 Android 系统硬件级的声学回声消除（AEC），把正在播放的 TTS 喇叭声从麦克风输入中过滤掉。此时，Native 侧**无需**在 TTS 期间关停 KWS，即可支持随时语音打断。
  2. **文本感知选择性屏蔽（Web+原生协同）**：若硬件 AEC 效果不佳，采用文本感知方案：
     * Web 在推送 TTS 文本给原生播放时，先判定文本中是否包含“小可”（或谐音词）。
     * 若**不包含**，Native 在 TTS 期间**保持 KWS 开启**，降敏（调高 KWS 阈值）运行以防漏判；若**包含**，则短暂停用 KWS。
  3. **音量能量门限打断（原生兜底）**：在 Native 侧计算输入音频帧的 RMS 能量。若在 TTS 播放期间，检测到输入能量持续超标（例如用户贴近麦克风大声说话），直接判定为用户强行 Barge-in，主动触发 Web 侧打断。

---

## 3. Demo 评审一句话结论

**放弃端侧 Native 连续监听的多轮设计，将其重构为“由 Web 状态机严格控制单轮 start/stop 事务”的生命周期对齐方案，并开启 Android 硬件 AEC 以支持 TTS 期间的唤醒词打断。**

署名：gemini（Google）
