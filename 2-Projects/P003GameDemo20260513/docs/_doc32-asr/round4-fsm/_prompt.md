# 评审任务:小可端侧 ASR 接入后「Web 语音状态机」设计是否正确 + 三个真机 bug 修复

## 背景
P003 儿童语音陪伴 App「小可」= Android 原生壳(WebView)+ Web 核心(React hook `useMobileVoice` 管语音状态机)。
原有链路 = **云火山 ASR**:Web `getUserMedia` 录音 → 上传 server 火山 → asr.final → LLM → TTS。Web 态机管每一轮(见下「云火山态机」)。
刚加 = **端侧 ASR**:原生 `AudioEngine`(sherpa OnlineRecognizer,单 AudioRecord)流式识别 → 经 JS Bridge 把 partial/endpoint/final 喂 Web → Web 把 final 走 `chat.trigger` 入 LLM(server 近零改)。
真机测出 3 个 bug,怀疑端侧 ASR 嫁接到 Web 态机的设计有问题。请评审状态机设计 + 给修复。

## 云火山态机(原有,正确基线)
```
唤醒/PTT → beginTurn() → client.startRecording()(getUserMedia 上传火山)+ 前端能量VAD
  → 用户说完(VAD speech_end 或 PTT 松手)→ finishTurn():client.stopRecording()+audio.end+setVoiceStatus('thinking')+清 listeningByWake/pressed
  → server 火山 asr.final → LLM → tts.audio(onTtsAudio:speaking)→ tts.playback_end
  → onPlaybackEnd():若多轮未超限 → followup beginTurn()（再开一轮录音等接话）；超限→idle 恢复 KWS
listeningByWake/pressed = 录音中标志；MobileMain: recording = pressed || listeningByWake（驱动按钮红色+脉冲环）
idle 静默分级(L3):followup 等接话静默超时 → nudge「还在吗」→ 再静默 → startExit()自动告别退出
startExit/finalizeExit: pauseWakeListening()+stopRecording()+ 回 idle 恢复 KWS
```

## 端侧 ASR 态机(我刚加的,怀疑有问题)
我引入 `useDeviceAsrRef`(端侧模式标志),在云火山态机上做分叉:
```ts
// beginTurn 端侧分叉:
if (useDeviceAsrRef.current) startAsr(byWake ? 'auto' : 'ptt');  // 不 getUserMedia
else await client.startRecording();
// 端侧不 pauseWakeListening(麦由原生持有)、不起 6s 窗、不用前端 VAD

// bridge 回调(原生 AudioEngine 推):
onAsrPartial(text) → setSubtitle(text)
onAsrEndpoint() → 仅 setVoiceStatus('thinking')   // ★ 没走 finishTurn
onAsrFinal(text) → detectExitIntent? : clientRef.current?.sendChatTrigger(text) + setVoiceStatus('thinking')  // ★ 没 client.bargeIn

// onPlaybackEnd 端侧分叉:
if (useDeviceAsrRef.current) { setVoiceStatus('listening'); setXiaokeEmotion('curious'); armIdleTimers(); }  // ★ 原生连续多轮,不 followup beginTurn,listeningByWake 不动
else { followup beginTurn() 或 idle }
```
原生 AudioEngine 侧:`startAsr('auto')` 后**连续监听**——录音线程每帧喂 OnlineRecognizer,`isEndpoint()` 命中 → `notifyAsrEndpoint()` + `notifyAsrFinal(text)` + `reset(stream)` **继续下一句**(原生自己管多轮)。`stopAsr()` 会 flush stream + **也 notifyAsrFinal** + release + 回 IDLE 跑 KWS。TTS 期(notifyTtsState true)gate KWS + 物理丢帧 ASR(防自唤醒)。

## 三个真机 bug(logcat 证据)
logcat 关键时序(一次唤醒后):
```
01:46:01 唤醒命中→startAsr auto
01:46:05 notifyTtsState true   ← 第1轮 TTS
01:46:20 notifyTtsState false
01:46:24 notifyTtsState true   ← 第2轮 TTS（中间无新唤醒/startAsr）
01:46:47 stopAsr 完成
01:46:56 pauseWakeListening：录音线程停止  ← 原生被停（startExit?）
```
1. **双声音叠**:一次唤醒后两轮 TTS(01:46:05 + 01:46:24)。诊断:孩子一句话被原生 auto endpoint 按停顿(rule2=1.1s)**切成多段 → 多个 onAsrFinal → 多个 sendChatTrigger**,而 `sendChatTrigger` 无客户端 bargeIn(对比 `sayDirect` 有 bargeIn 停在途 TTS)→ 旧 TTS 没停就叠新的。
2. **底部按钮一直红(说话态)+ 脉冲环常转**:`recording = pressed || listeningByWake`。端侧 beginTurn(byWake) 设 `listeningByWake=true`,原生连续模式下**从不清**(端侧不走 finishTurn)→ 永远红。
3. **小可说话时喊「小可小可」打不断**:TTS 期 gate KWS(修自唤醒的代价,自唤醒已修好)→ 喊唤醒词不命中。点按钮能打断(speaking 时 onBarge),但语音打断丢了。

## 候选修复方向(请评估 + 给正解)
- **方向 X(端侧每轮对齐云火山)**:onAsrEndpoint → finishTurn(停这轮 + thinking + 清 listeningByWake);onAsrFinal → bargeIn + chat.trigger;onPlaybackEnd → followup beginTurn(下一轮 startAsr)。端侧完全融入云火山态机,listeningByWake/turnCount/idle/exit 全复用。**风险**:stopAsr 也 notifyAsrFinal → 与 endpoint 的 final 重复(二次 chat.trigger);原生 endpoint reset 连续 vs Web stopAsr 停的时序。
- **方向 Y(保留原生连续 + 端侧专用态)**:端侧不复用 listeningByWake(另设端侧"对话中"态,thinking/speaking 时按钮不红);onAsrFinal 加 bargeIn 防叠;startExit/idle 端侧分叉(不 pauseWakeListening 打断原生)。
- **方向 Z**:其他(比如原生 auto endpoint 后停而非 reset 连续,把每个 endpoint 当一轮硬边界)。

## 请回答
1. **状态机正解**:端侧 ASR 应该走「每轮 Web 管(方向 X)」还是「原生连续(方向 Y)」?哪个更少 bug、更一致?给明确推荐 + 理由 + 关键实现要点(尤其怎么避免 endpoint final 与 stopAsr final 的二次 chat.trigger)。
2. **双声音(bug1)**:除了 onAsrFinal 加 bargeIn,还有没有更根本的(比如端侧一轮只允许一个 final / endpoint 切句策略 / rule2 调长)?
3. **按钮态(bug2)**:recording 标志在端侧应该怎么驱动才对?
4. **语音打断(bug3)**:TTS 期 gate KWS 防自唤醒和「喊小可打断」本质冲突(同一麦克风)。demo 阶段如何兼顾(上轮 team 提过 gemini「TTS 含『小可』句才 gate、其余句 KWS 降敏继续」的文本感知 gating,以及能量门 barge-in)?给可落地的。

输出:状态机正解(X/Y/Z + 理由)+ 三 bug 修复要点 + demo 一句话结论。
