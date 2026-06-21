# P1 任务:小可手机端「原生 AudioEngine + AsrBridge」(on-device ASR 核心)

## 背景
P003「小可」儿童语音陪伴 App = Android 原生薄壳(WebView)+ Web 核心。要把 ASR 从云火山改成**端侧 sherpa-onnx 流式 Zipformer**。
**P0 已真机验证通过(三星 S24 Ultra)**:单 `libsherpa-onnx-jni.so` 能跑 `OnlineRecognizer`、KeywordSpotter+OnlineRecognizer 同进程共存 OK、type15 small-ctc 模型 decode RTF 0.025。现在实现原生层核心。

## 选型(已定,不要再讨论)
- ASR 模型:**type15** = `assets/asr-model-v15/model.int8.onnx`(zipformer2 CTC)+ `assets/asr-model-v15/tokens.txt`。纯 demo,不纠结童声 CER。
- 唤醒:现有 `assets/kws-model/`(sherpa KeywordSpotter,"小可小可")。

## 目标(★只动 android-shell 原生 Kotlin 层,绝不碰 apps/web 和 apps/server —— 那是 P2)
实现单一 `AudioEngine` 管理**唯一一个** `AudioRecord`,按状态把 16k PCM 分发给 KWS 或 ASR;`AsrBridge` 作 JS 门面;重构 `WakeWordBridge` 委托给 `AudioEngine`;`MainActivity` 注入。

## 硬设计约束(team 四发评审收敛 docs/32 §11,逐条必须满足)
1. **单一 AudioRecord**(`MediaRecorder.AudioSource.VOICE_RECOGNITION`, 16000, CHANNEL_IN_MONO, ENCODING_PCM_16BIT),`AudioEngine` 唯一持有者。**绝不双开**——KWS 和 ASR 不能各开一个 AudioRecord(否则麦克风句柄冲突 + 切换 gap)。
2. **状态机**:`IDLE`(跑 KWS 监听唤醒)/ `ASR`(跑 OnlineRecognizer 转写)/ `TTS_PLAYING`(物理静音 ASR,但 KWS 继续监听打断)。状态切换线程安全。
3. **ring buffer pre-roll ~800ms**:常驻环形缓冲最近 PCM 帧。KWS 命中后,把「命中点附近的历史帧 + 后续实时帧」一并喂给新建的 ASR `OnlineStream`,**回溯式启动**,防唤醒后孩子紧接的首字被截断(team 一致 A2)。
4. **KWS↔ASR 无缝切换**:**不释放 AudioRecord**,只切换 PCM 帧的「喂给谁」+ 切 stream 对象(`KeywordSpotter.createStream()` ↔ `OnlineRecognizer.createStream()`)。
5. **TTS gating(AEC 自激防护,致命坑)**:`notifyTtsState(true)` → ASR 输入**物理丢帧**(收到的 PCM 直接不喂 OnlineStream);但 KWS 继续跑,让"小可小可"能打断。`notifyTtsState(false)` → **延迟 ~250ms 再恢复** ASR 喂帧(吸收 JS→原生异步延迟 50-120ms + TTS 尾音功放余振)。⚠️ 不要指望硬件 AcousticEchoCanceler 滤 TTS 自声(它对 WebView 的 STREAM_MUSIC 输出不生效),自声抑制只靠物理丢帧。
6. **ASR endpointing 判停**:`OnlineRecognizer` `enableEndpoint=true`;`EndpointConfig` 的 `rule2.minTrailingSilence` 做成**可配**(童声宽容,起点 ~1.0–1.2s,别照搬激进的 0.3s)。循环里 `isEndpoint(stream)` 命中 → 回调 `onAsrEndpoint()` + `getResult(stream).text` → `onAsrFinal(text)` + `reset(stream)`。
7. **partial 节流**:`onAsrPartial(text)` 推送间隔 **≥120ms 且仅文本变化才推**;`onAsrFinal`/`onAsrEndpoint` 不节流(立即)。防高频 evaluateJavascript 压垮 WebView 主线程。
8. **两种模式**:`startAsr("ptt")` 关闭 auto-endpoint(松手 `stopAsr()` 收尾);`startAsr("auto")` 用 `isEndpoint` 自动收尾(唤醒/多轮)。
9. **优雅降级**:模型缺失 / init 失败(try-catch Throwable)→ `isOnDeviceAsrAvailable()` 永久 false(Web 据此自动回退云火山,绝不崩 App)。
10. **线程/资源**:录音单后台线程;`@Volatile` + 必要锁防竞态;release 不泄漏(参考现有 `WakeWordBridge.stopRecordingInternal/cleanup` 的 join+release 模式)。麦克风互斥契约保留:`pauseWakeListening`/`startWakeListening` 语义不破坏。

## JS Bridge 协议(扩展现有契约,保留旧的)
**NativeBridge**(原生 `@JavascriptInterface`,注入名 `KidshubNative`):
- 新增:`isOnDeviceAsrAvailable(): Boolean` / `startAsr(mode: String)`(mode = "auto"|"ptt")/ `stopAsr()` / `notifyTtsState(speaking: Boolean)`
- 保留:`isWakeWordAvailable()` / `startWakeListening()` / `pauseWakeListening()`

**WebBridge**(原生 `evaluateJavascript` 调 `window.KidshubWeb.*`):
- 新增:`onAsrPartial(text)` / `onAsrEndpoint()` / `onAsrFinal(text)`
- 保留:`onWakeWord()` / `onNativeReady({wakeWordAvailable})`

## 现有代码接口(已验证,照此用)

### sherpa-onnx Kotlin API(包 com.k2fsa.sherpa.onnx)
```kotlin
// OnlineRecognizer
class OnlineRecognizer(assetManager: AssetManager? = null, val config: OnlineRecognizerConfig) {
    fun createStream(hotwords: String = ""): OnlineStream
    fun reset(stream: OnlineStream); fun decode(stream: OnlineStream)
    fun isEndpoint(stream: OnlineStream): Boolean; fun isReady(stream: OnlineStream): Boolean
    fun getResult(stream: OnlineStream): OnlineRecognizerResult /* .text: String */
    fun release()
}
data class OnlineRecognizerConfig(featConfig, modelConfig, endpointConfig=EndpointConfig(), enableEndpoint=true, decodingMethod="greedy_search", ...)
data class EndpointConfig(rule1=EndpointRule(false,2.4f,0f), rule2=EndpointRule(true,1.4f,0f), rule3=EndpointRule(false,0f,20f))
data class EndpointRule(mustContainNonSilence:Boolean, minTrailingSilence:Float, minUtteranceLength:Float)
data class OnlineModelConfig(transducer, paraformer, zipformer2Ctc, ..., tokens:String, numThreads:Int=1, provider:String="cpu", modelType:String="")
data class OnlineZipformer2CtcModelConfig(model:String="")
// OnlineStream
class OnlineStream { fun acceptWaveform(samples:FloatArray, sampleRate:Int); fun inputFinished(); fun release() }
// KeywordSpotter（同构）
class KeywordSpotter(assetManager, config:KeywordSpotterConfig) {
    fun createStream():OnlineStream; fun isReady(s); fun decode(s); fun reset(s); fun getResult(s) /* .keyword:String */; fun release()
}
```

### type15 ASR config(P0 已验证可跑,直接用)
```kotlin
OnlineRecognizerConfig(
    featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
    modelConfig = OnlineModelConfig(
        zipformer2Ctc = OnlineZipformer2CtcModelConfig(model = "asr-model-v15/model.int8.onnx"),
        tokens = "asr-model-v15/tokens.txt",
        numThreads = 2, provider = "cpu",
    ),
    enableEndpoint = true,
)
```

### 现有 WakeWordBridge.kt 的录音/KWS 模式(复用，关键片段）
```kotlin
// AudioRecord 创建（保留 VOICE_RECOGNITION，勿用 VOICE_COMMUNICATION——会进通话模式毁 TTS 音色）
val record = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000,
    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf*2)
// 录音线程：100ms/帧
val buffer = ShortArray((0.1*16000).toInt())
val n = record.read(buffer, 0, buffer.size)
val samples = FloatArray(n) { buffer[it] / 32768.0f }
stream.acceptWaveform(samples, sampleRate = 16000)
while (spotter.isReady(stream)) { spotter.decode(stream); val kw = spotter.getResult(stream).keyword; if (kw.isNotBlank()){ spotter.reset(stream); /*命中*/ } }
// 命中通知 Web：webView.post { webView.evaluateJavascript("window.KidshubWeb.onWakeWord()", null) }
// 现有麦克风互斥契约：Web 录音前 pauseWakeListening() 释放麦，录完 startWakeListening() 恢复
// KWS config: encoder/decoder/joiner = kws-model/*.onnx, tokens=kws-model/tokens.txt, modelType="zipformer2",
//             keywordsFile="kws-model/keywords.txt", keywordsThreshold=0.2f, keywordsScore=2.0f
```

### Web 侧 bridge.ts 现有契约(P2 才改它，这里仅供你理解协议对端)
```ts
window.KidshubNative?: { isWakeWordAvailable(), startWakeListening(), pauseWakeListening() }
window.KidshubWeb?: { onWakeWord(), onNativeReady({wakeWordAvailable}) }
// 纯浏览器无 KidshubNative → 降级；你新增的 isOnDeviceAsrAvailable/startAsr/... 要同样优雅。
```

## AC(验收标准)
- `./gradlew assembleDebug` 编译通过(`JAVA_HOME=/opt/homebrew/opt/openjdk@17`)。
- grep 确认全工程**只有一个 AudioRecord 实例**(AudioEngine 内),WakeWordBridge 不再自己 new AudioRecord。
- KWS→ASR 切换走 ring buffer 回灌(代码体现 pre-roll)。
- TTS_PLAYING 态 ASR 物理丢帧 + KWS 仍解码。
- onAsrPartial 有节流;onAsrFinal 立即。
- 模型 init 失败优雅降级 isOnDeviceAsrAvailable()=false。
- **不改 apps/web、apps/server 任何文件**(P2 再做 Web 对接)。

## 产出文件(android-shell 原生)
- 新建 `app/src/main/java/cc/hahaxiong/kidshub/AudioEngine.kt`(核心：单 AudioRecord + 状态机 + ring buffer + KWS/ASR/TTS-gating + 节流)
- 新建 `app/src/main/java/cc/hahaxiong/kidshub/AsrBridge.kt`(JS 门面，@JavascriptInterface，委托 AudioEngine；唤醒回调也经此或保留 WakeWordBridge 委托）
- 改 `WakeWordBridge.kt`：录音/KWS 逻辑迁入 AudioEngine，自身退化为委托（或与 AsrBridge 合并为单一 bridge，注入名仍 `KidshubNative`，保留全部现有方法签名）
- 改 `MainActivity.kt`：注入新 bridge（addJavascriptInterface 名仍 `KidshubNative`），生命周期 onResume/onPause/onDestroy 转调 AudioEngine。

请给出完整可编译的 Kotlin 实现 + 关键设计说明（状态机迁移、ring buffer 数据结构、节流实现、TTS gating 时序）。
