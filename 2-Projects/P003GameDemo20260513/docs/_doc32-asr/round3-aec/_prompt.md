# 评审任务:小可端侧 ASR 的「TTS 自声触发唤醒词(自唤醒)」修复方案

## 背景
P003 儿童语音陪伴 App「小可」,Android 原生壳(WebView)+ 端侧 sherpa-onnx ASR(刚落地 AudioEngine,单一 AudioRecord)。
唤醒词「小可小可」由 sherpa KeywordSpotter 端侧检测。**TTS 播放时 KWS 也持续跑**——目的是让孩子能喊「小可小可」打断小可说话(barge-in,这是已确认的产品需求,不要轻易砍)。

## 问题(P1 真机暴露)
TTS 播放时(小可的声音从手机扬声器播,WebView 用 STREAM_MUSIC 播放),麦克风录到小可自己的声音;小可说到「小可」时 KWS 命中 → **自唤醒**(小可把自己唤醒,自己跟自己对话)。体验很差,必须修。

## 已知约束/事实(都已验证)
1. 唤醒词模型是「小可小可」叠词,KWS 阈值 0.2(为童声召回调低)。小可 TTS 会说到「小可」(自我介绍/世界观),触发自唤醒。
2. **硬件 AcousticEchoCanceler 对 WebView TTS 的 STREAM_MUSIC 输出不生效**:AEC 通常只在录音源 VOICE_COMMUNICATION + 播放走通话声道(VOICE_CALL)时才消回声。现状 AudioEngine 绑了 AcousticEchoCanceler 但没真正消除 TTS 自声(本问题即印证)。
3. 录音源现状 = MediaRecorder.AudioSource.VOICE_RECOGNITION(刻意不用 VOICE_COMMUNICATION——它进通话模式会把媒体路由到听筒+限 16kHz,毁 TTS 音色,上轮已确认)。
4. 现有时序信号:AudioEngine 有 `notifyTtsState(speaking: Boolean)`,Web 在 TTS 开始/结束时调(onTtsAudio→true / onPlaybackEnd→false)。ASR 已用它做物理丢帧(TTS 期不喂 ASR)。但 **KWS 目前不受 notifyTtsState 影响,一直跑**。
5. 纯 demo 阶段,不追求极致音质,但自唤醒必须修。低端机也要能跑(不能上重型实时 DSP)。

## 候选方案(请评估 + 补更优的)
- **A. TTS 播放期 gate KWS**:notifyTtsState(true) 时 KWS 也暂停喂帧/忽略命中;notifyTtsState(false)+延迟恢复。彻底防自唤醒,但失去「TTS 时语音打断」(barge-in)。兜底:保留 PTT 按钮打断 + TTS 说完很快恢复 KWS。
- **B. TTS+播放搬原生 + 软件 AEC**:TTS 从 WebView 搬到原生播放(原生同时有 TTS 参考信号 + mic 输入),用 WebRTC AEC / speexdsp AEC 自适应消除自声。保留语音打断,但 TTS 链路大改 + 实时 AEC 低端机负担。
- **C. AudioManager 通话模式**:MODE_IN_COMMUNICATION + 播放走 VOICE_CALL 让硬件 AEC 生效。代价:毁 TTS 音色/路由听筒(已知坑)。
- **D. TTS 期 KWS 继续 + 自声判别(启发式)**:notifyTtsState(true) 的时间窗内临时提高 KWS 阈值;或「小可 TTS 文本即将说到『小可』」的短窗内屏蔽 KWS;或唤醒命中后等 ~300ms 看是否有持续人声二次确认(自声短峰 vs 孩子持续说)。不彻底但保留语音打断。
- **E. 组合/其他**:比如 A 为主(TTS 期 gate KWS 防自唤醒)+ 用「mic 能量突增且不匹配 TTS 包络」作为粗粒度 barge-in 信号(不依赖唤醒词,孩子一开口就打断)。

## 请回答
1. **demo 阶段最优解**是哪个(权衡:防自唤醒效果 / 是否保留 TTS 时语音打断 / 工程量 / 低端机负担)?给明确推荐 + 理由。
2. 若选 A(gate KWS):TTS 说完恢复 KWS 的**延迟取多少**防扬声器尾音余振再次自唤醒?「TTS 时语音打断」如何兜底最不伤体验?
3. 有没有比 A-D 更聪明的**低成本解法**(利用 notifyTtsState 时间窗 + 短延迟 + 能量门的组合)?
4. 长期(非 demo)正解。

输出:按推荐度排序的方案 + 每个实现要点(具体到改 AudioEngine 哪里)+ demo 阶段一句话结论。
