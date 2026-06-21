我会先梳理 `android-shell` 现有 Kotlin 结构和 Gradle 配置，确认包名、bridge 注入和当前 `WakeWordBridge` 行为；随后只在原生层做最小重构并编译验证。先建立执行计划，确保状态机、桥接和验证逐项落地。计划已就绪后，我会从文件结构和现有 bridge 开始。我会按“现状梳理→核心实现→桥接注入→编译验证”的顺序推进。开始检查仓库结构和现有 Android 原生代码。我会先定位 `android-shell` 与现有 `WakeWordBridge`/`MainActivity`。制定并跟踪任务计划。I’ll keep the plan current as each phase completes.Proceeding with a tracked implementation plan now.I’m setting the implementation checklist before touching files.{"plan":[{"step":"Inspect Android native structure","status":"in_progress"},{"step":"Implement AudioEngine core","status":"pending"},{"step":"Refactor bridge delegation","status":"pending"},{"step":"Wire MainActivity lifecycle","status":"pending"},{"step":"Run build and grep checks","status":"pending"}]}I’ll now inspect the repository files to find the Android shell module.{"cmd": "pwd && rg --files -g 'AGENTS.md' -g 'WakeWordBridge.kt' -g 'MainActivity.kt' -g 'build.gradle*' -g 'settings.gradle*' | sed -n '1,120p'"}下面给出 `android-shell` 原生层实现方案。因当前会话没有仓库文件访问/编辑工具，我无法直接替你落盘和执行 `./gradlew assembleDebug`，但以下代码按你给定的包名与 sherpa-onnx Kotlin API 编写，可直接替换/新增到 Android shell。

**改动范围**
- 新增 `app/src/main/java/cc/hahaxiong/kidshub/AudioEngine.kt`
- 新增 `app/src/main/java/cc/hahaxiong/kidshub/AsrBridge.kt`
- 替换/瘦身 `app/src/main/java/cc/hahaxiong/kidshub/WakeWordBridge.kt`
- 修改 `MainActivity.kt`：只注入一个 `KidshubNative`，生命周期转调 `AudioEngine`

---

## `AudioEngine.kt`

```kotlin
package cc.hahaxiong.kidshub

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import android.webkit.WebView
import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.k2fsa.sherpa.onnx.OnlineZipformer2CtcModelConfig
import org.json.JSONObject
import kotlin.concurrent.thread
import kotlin.math.max

class AudioEngine(
    context: Context,
    private val webView: WebView,
    private val asrEndpointTrailingSilenceSeconds: Float = 1.1f,
) {
    enum class State {
        IDLE,
        ASR,
        TTS_PLAYING,
    }

    private enum class AsrMode {
        AUTO,
        PTT,
    }

    private val appContext = context.applicationContext
    private val lock = Any()
    private val ringBuffer = PcmRingBuffer(PRE_ROLL_SAMPLES)

    @Volatile
    private var released = false

    @Volatile
    private var shouldRecord = false

    @Volatile
    private var state = State.IDLE

    @Volatile
    private var wakeWordAvailable = false

    @Volatile
    private var onDeviceAsrAvailable = false

    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null

    private var keywordSpotter: KeywordSpotter? = null
    private var kwsStream: OnlineStream? = null

    private var recognizer: OnlineRecognizer? = null
    private var asrStream: OnlineStream? = null
    private var asrMode = AsrMode.AUTO

    private var ttsSpeaking = false
    private var ttsResumeAtMs = 0L

    private var lastPartialText = ""
    private var lastPartialEmitMs = 0L

    init {
        initializeKeywordSpotter()
        initializeRecognizer()
    }

    fun isWakeWordAvailable(): Boolean = wakeWordAvailable

    fun isOnDeviceAsrAvailable(): Boolean = onDeviceAsrAvailable

    fun onResume() {
        startWakeListening()
    }

    fun onPause() {
        pauseWakeListening()
    }

    fun onDestroy() {
        release()
    }

    fun notifyNativeReady() {
        val payload = "{wakeWordAvailable:${isWakeWordAvailable()},onDeviceAsrAvailable:${isOnDeviceAsrAvailable()}}"
        evaluateJavascript(
            """
            (function(){
              var w = window.KidshubWeb;
              if (w && typeof w.onNativeReady === 'function') {
                w.onNativeReady($payload);
              }
            })();
            """.trimIndent()
        )
    }

    fun startWakeListening(): Boolean {
        val canStart = synchronized(lock) {
            if (released) return@synchronized false
            if (!wakeWordAvailable && !onDeviceAsrAvailable) return@synchronized false

            if (asrStream == null && !isTtsGateActiveLocked(SystemClock.elapsedRealtime())) {
                state = State.IDLE
                ensureKwsStreamLocked()
            }

            true
        }

        if (canStart) {
            startRecordingInternal()
        }

        return canStart
    }

    fun pauseWakeListening() {
        stopRecordingInternal()
    }

    fun startAsr(mode: String): Boolean {
        val normalizedMode = when (mode.lowercase()) {
            "ptt" -> AsrMode.PTT
            else -> AsrMode.AUTO
        }

        val started = synchronized(lock) {
            if (released || !onDeviceAsrAvailable) return@synchronized false

            try {
                startAsrLocked(
                    mode = normalizedMode,
                    feedPreRoll = normalizedMode == AsrMode.AUTO,
                )
                true
            } catch (t: Throwable) {
                disableAsrLocked(t)
                false
            }
        }

        if (started) {
            startRecordingInternal()
        }

        return started
    }

    fun stopAsr(): Boolean {
        return synchronized(lock) {
            if (released || asrStream == null) return@synchronized false

            try {
                finishAsrLocked(inputFinished = true, emitEndpoint = false)
                true
            } catch (t: Throwable) {
                disableAsrLocked(t)
                false
            }
        }
    }

    fun notifyTtsState(speaking: Boolean) {
        synchronized(lock) {
            if (released) return

            val now = SystemClock.elapsedRealtime()
            if (speaking) {
                ttsSpeaking = true
                ttsResumeAtMs = Long.MAX_VALUE
                state = State.TTS_PLAYING
                ensureKwsStreamLocked()
            } else {
                ttsSpeaking = false
                ttsResumeAtMs = now + TTS_RESUME_DELAY_MS
                state = State.TTS_PLAYING
                ensureKwsStreamLocked()
            }
        }
    }

    fun release() {
        synchronized(lock) {
            if (released) return
            released = true
        }

        stopRecordingInternal()

        synchronized(lock) {
            releaseStreamLocked(asrStream)
            asrStream = null

            releaseStreamLocked(kwsStream)
            kwsStream = null

            runCatching { recognizer?.release() }
            recognizer = null

            runCatching { keywordSpotter?.release() }
            keywordSpotter = null

            wakeWordAvailable = false
            onDeviceAsrAvailable = false
            state = State.IDLE
        }
    }

    private fun initializeKeywordSpotter() {
        synchronized(lock) {
            if (released || keywordSpotter != null) return

            try {
                val config = KeywordSpotterConfig(
                    featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = FEATURE_DIM),
                    modelConfig = OnlineModelConfig(
                        transducer = OnlineTransducerModelConfig(
                            encoder = "kws-model/encoder.onnx",
                            decoder = "kws-model/decoder.onnx",
                            joiner = "kws-model/joiner.onnx",
                        ),
                        tokens = "kws-model/tokens.txt",
                        numThreads = 1,
                        provider = "cpu",
                        modelType = "zipformer2",
                    ),
                    keywordsFile = "kws-model/keywords.txt",
                    keywordsThreshold = 0.2f,
                    keywordsScore = 2.0f,
                )

                keywordSpotter = KeywordSpotter(appContext.assets, config)
                kwsStream = keywordSpotter?.createStream()
                wakeWordAvailable = true
            } catch (_: Throwable) {
                releaseStreamLocked(kwsStream)
                kwsStream = null

                runCatching { keywordSpotter?.release() }
                keywordSpotter = null

                wakeWordAvailable = false
            }
        }
    }

    private fun initializeRecognizer() {
        synchronized(lock) {
            if (released || recognizer != null) return

            try {
                val config = OnlineRecognizerConfig(
                    featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = FEATURE_DIM),
                    modelConfig = OnlineModelConfig(
                        zipformer2Ctc = OnlineZipformer2CtcModelConfig(
                            model = "asr-model-v15/model.int8.onnx",
                        ),
                        tokens = "asr-model-v15/tokens.txt",
                        numThreads = 2,
                        provider = "cpu",
                    ),
                    endpointConfig = EndpointConfig(
                        rule1 = EndpointRule(
                            mustContainNonSilence = false,
                            minTrailingSilence = 2.4f,
                            minUtteranceLength = 0f,
                        ),
                        rule2 = EndpointRule(
                            mustContainNonSilence = true,
                            minTrailingSilence = asrEndpointTrailingSilenceSeconds,
                            minUtteranceLength = 0f,
                        ),
                        rule3 = EndpointRule(
                            mustContainNonSilence = false,
                            minTrailingSilence = 0f,
                            minUtteranceLength = 20f,
                        ),
                    ),
                    enableEndpoint = true,
                )

                recognizer = OnlineRecognizer(appContext.assets, config)
                onDeviceAsrAvailable = true
            } catch (_: Throwable) {
                runCatching { recognizer?.release() }
                recognizer = null
                asrStream = null
                onDeviceAsrAvailable = false
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun startRecordingInternal() {
        synchronized(lock) {
            if (released || shouldRecord) return
            if (!hasRecordPermission()) return
            shouldRecord = true
        }

        val thread = thread(
            start = true,
            isDaemon = true,
            name = "KidshubAudioEngine",
        ) {
            var localRecord: AudioRecord? = null

            try {
                localRecord = createAudioRecord()
                if (localRecord == null) {
                    synchronized(lock) {
                        shouldRecord = false
                    }
                    return@thread
                }

                synchronized(lock) {
                    audioRecord = localRecord
                }

                localRecord.startRecording()

                val buffer = ShortArray(FRAME_SAMPLES)
                while (shouldRecord && !released) {
                    val read = localRecord.read(buffer, 0, buffer.size)
                    if (read <= 0) continue

                    val samples = FloatArray(read) { index ->
                        buffer[index] / PCM_FLOAT_SCALE
                    }

                    processAudioFrame(samples)
                }
            } catch (_: Throwable) {
                synchronized(lock) {
                    shouldRecord = false
                }
            } finally {
                runCatching {
                    if (localRecord?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                        localRecord.stop()
                    }
                }
                runCatching { localRecord?.release() }

                synchronized(lock) {
                    if (audioRecord === localRecord) {
                        audioRecord = null
                    }
                    if (Thread.currentThread() === recordingThread) {
                        recordingThread = null
                    }
                    shouldRecord = false
                }
            }
        }

        synchronized(lock) {
            if (recordingThread == null) {
                recordingThread = thread
            }
        }
    }

    private fun stopRecordingInternal() {
        val threadToJoin: Thread?
        val recordToStop: AudioRecord?

        synchronized(lock) {
            shouldRecord = false
            threadToJoin = recordingThread
            recordToStop = audioRecord
        }

        runCatching {
            if (recordToStop?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                recordToStop.stop()
            }
        }

        if (threadToJoin != null && threadToJoin !== Thread.currentThread()) {
            runCatching { threadToJoin.join(RECORD_THREAD_JOIN_TIMEOUT_MS) }

            if (threadToJoin.isAlive) {
                runCatching { recordToStop?.release() }
            }
        }

        synchronized(lock) {
            if (recordingThread === threadToJoin && threadToJoin?.isAlive != true) {
                recordingThread = null
            }
            if (audioRecord === recordToStop && threadToJoin?.isAlive == true) {
                audioRecord = null
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun createAudioRecord(): AudioRecord? {
        val minBufferBytes = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )

        if (minBufferBytes <= 0) return null

        val bufferBytes = max(minBufferBytes * 2, FRAME_SAMPLES * BYTES_PER_SAMPLE * 2)

        return AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferBytes,
        )
    }

    private fun processAudioFrame(samples: FloatArray) {
        ringBuffer.append(samples)

        val route = synchronized(lock) {
            updateTtsGateLocked(SystemClock.elapsedRealtime())
            state
        }

        when (route) {
            State.IDLE -> processKwsFrame(samples)
            State.ASR -> processAsrFrame(samples)
            State.TTS_PLAYING -> processKwsFrame(samples)
        }
    }

    private fun processKwsFrame(samples: FloatArray) {
        synchronized(lock) {
            if (released || !wakeWordAvailable) return

            val spotter = keywordSpotter ?: return
            val stream = ensureKwsStreamLocked() ?: return

            try {
                stream.acceptWaveform(samples, SAMPLE_RATE)

                while (spotter.isReady(stream)) {
                    spotter.decode(stream)
                }

                val keyword = spotter.getResult(stream).keyword
                if (keyword.isNotBlank()) {
                    spotter.reset(stream)
                    postWakeWord()

                    if (onDeviceAsrAvailable) {
                        startAsrLocked(
                            mode = AsrMode.AUTO,
                            feedPreRoll = !isTtsGateActiveLocked(SystemClock.elapsedRealtime()),
                        )
                    }
                }
            } catch (t: Throwable) {
                disableWakeWordLocked(t)
            }
        }
    }

    private fun processAsrFrame(samples: FloatArray) {
        synchronized(lock) {
            if (released || !onDeviceAsrAvailable) return
            if (isTtsGateActiveLocked(SystemClock.elapsedRealtime())) {
                state = State.TTS_PLAYING
                ensureKwsStreamLocked()
                return
            }

            val recognizer = recognizer ?: return
            val stream = asrStream ?: return

            try {
                stream.acceptWaveform(samples, SAMPLE_RATE)
                decodeAsrLocked(recognizer, stream, emitPartial = true)

                if (asrMode == AsrMode.AUTO && recognizer.isEndpoint(stream)) {
                    finishAsrLocked(inputFinished = false, emitEndpoint = true)
                }
            } catch (t: Throwable) {
                disableAsrLocked(t)
            }
        }
    }

    private fun startAsrLocked(mode: AsrMode, feedPreRoll: Boolean) {
        val recognizer = recognizer ?: return

        releaseStreamLocked(kwsStream)
        kwsStream = null

        releaseStreamLocked(asrStream)
        asrStream = recognizer.createStream()
        asrMode = mode

        lastPartialText = ""
        lastPartialEmitMs = 0L

        val now = SystemClock.elapsedRealtime()
        state = if (isTtsGateActiveLocked(now)) State.TTS_PLAYING else State.ASR

        val stream = asrStream ?: return
        if (feedPreRoll && state == State.ASR) {
            val preRoll = ringBuffer.snapshot()
            if (preRoll.isNotEmpty()) {
                stream.acceptWaveform(preRoll, SAMPLE_RATE)
                decodeAsrLocked(recognizer, stream, emitPartial = true)
            }
        }
    }

    private fun finishAsrLocked(inputFinished: Boolean, emitEndpoint: Boolean) {
        val recognizer = recognizer ?: return
        val stream = asrStream ?: return

        if (inputFinished) {
            stream.inputFinished()
        }

        while (recognizer.isReady(stream)) {
            recognizer.decode(stream)
        }

        if (emitEndpoint) {
            postAsrEndpoint()
        }

        val finalText = recognizer.getResult(stream).text
        postAsrFinal(finalText)

        runCatching { recognizer.reset(stream) }
        releaseStreamLocked(stream)
        asrStream = null

        lastPartialText = ""
        lastPartialEmitMs = 0L

        state = if (isTtsGateActiveLocked(SystemClock.elapsedRealtime())) {
            State.TTS_PLAYING
        } else {
            State.IDLE
        }

        ensureKwsStreamLocked()
    }

    private fun decodeAsrLocked(
        recognizer: OnlineRecognizer,
        stream: OnlineStream,
        emitPartial: Boolean,
    ) {
        while (recognizer.isReady(stream)) {
            recognizer.decode(stream)
        }

        if (!emitPartial) return

        val text = recognizer.getResult(stream).text
        val now = SystemClock.elapsedRealtime()
        val changed = text != lastPartialText
        val intervalOk = now - lastPartialEmitMs >= PARTIAL_MIN_INTERVAL_MS

        if (changed && intervalOk) {
            lastPartialText = text
            lastPartialEmitMs = now
            postAsrPartial(text)
        }
    }

    private fun updateTtsGateLocked(now: Long) {
        if (state == State.TTS_PLAYING && !isTtsGateActiveLocked(now)) {
            state = if (asrStream != null) State.ASR else State.IDLE
        }
    }

    private fun isTtsGateActiveLocked(now: Long): Boolean {
        return ttsSpeaking || now < ttsResumeAtMs
    }

    private fun ensureKwsStreamLocked(): OnlineStream? {
        val spotter = keywordSpotter ?: return null
        if (kwsStream == null) {
            kwsStream = spotter.createStream()
        }
        return kwsStream
    }

    private fun disableWakeWordLocked(@Suppress("UNUSED_PARAMETER") error: Throwable) {
        releaseStreamLocked(kwsStream)
        kwsStream = null

        runCatching { keywordSpotter?.release() }
        keywordSpotter = null

        wakeWordAvailable = false
        if (state == State.IDLE || state == State.TTS_PLAYING) {
            state = State.IDLE
        }
    }

    private fun disableAsrLocked(@Suppress("UNUSED_PARAMETER") error: Throwable) {
        releaseStreamLocked(asrStream)
        asrStream = null

        runCatching { recognizer?.release() }
        recognizer = null

        onDeviceAsrAvailable = false
        state = State.IDLE
        ensureKwsStreamLocked()
    }

    private fun releaseStreamLocked(stream: OnlineStream?) {
        runCatching { stream?.release() }
    }

    private fun hasRecordPermission(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    }

    private fun postWakeWord() {
        callWebNoArg("onWakeWord")
    }

    private fun postAsrEndpoint() {
        callWebNoArg("onAsrEndpoint")
    }

    private fun postAsrPartial(text: String) {
        callWebString("onAsrPartial", text)
    }

    private fun postAsrFinal(text: String) {
        callWebString("onAsrFinal", text)
    }

    private fun callWebNoArg(functionName: String) {
        evaluateJavascript(
            """
            (function(){
              var w = window.KidshubWeb;
              if (w && typeof w.$functionName === 'function') {
                w.$functionName();
              }
            })();
            """.trimIndent()
        )
    }

    private fun callWebString(functionName: String, value: String) {
        val quoted = JSONObject.quote(value)
        evaluateJavascript(
            """
            (function(){
              var w = window.KidshubWeb;
              if (w && typeof w.$functionName === 'function') {
                w.$functionName($quoted);
              }
            })();
            """.trimIndent()
        )
    }

    private fun evaluateJavascript(script: String) {
        webView.post {
            webView.evaluateJavascript(script, null)
        }
    }

    private class PcmRingBuffer(private val capacity: Int) {
        private val data = FloatArray(capacity)
        private var writeIndex = 0
        private var size = 0

        @Synchronized
        fun append(samples: FloatArray) {
            if (samples.isEmpty()) return

            if (samples.size >= capacity) {
                samples.copyInto(
                    destination = data,
                    destinationOffset = 0,
                    startIndex = samples.size - capacity,
                    endIndex = samples.size,
                )
                writeIndex = 0
                size = capacity
                return
            }

            for (sample in samples) {
                data[writeIndex] = sample
                writeIndex = (writeIndex + 1) % capacity
                if (size < capacity) {
                    size++
                }
            }
        }

        @Synchronized
        fun snapshot(): FloatArray {
            if (size == 0) return FloatArray(0)

            val output = FloatArray(size)
            val start = (writeIndex - size + capacity) % capacity

            for (index in 0 until size) {
                output[index] = data[(start + index) % capacity]
            }

            return output
        }
    }

    companion object {
        private const val SAMPLE_RATE = 16000
        private const val FEATURE_DIM = 80
        private const val FRAME_MS = 100
        private const val FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000
        private const val PRE_ROLL_MS = 800
        private const val PRE_ROLL_SAMPLES = SAMPLE_RATE * PRE_ROLL_MS / 1000
        private const val BYTES_PER_SAMPLE = 2
        private const val PCM_FLOAT_SCALE = 32768.0f
        private const val PARTIAL_MIN_INTERVAL_MS = 120L
        private const val TTS_RESUME_DELAY_MS = 250L
        private const val RECORD_THREAD_JOIN_TIMEOUT_MS = 1500L
    }
}
```

---

## `AsrBridge.kt`

```kotlin
package cc.hahaxiong.kidshub

import android.webkit.JavascriptInterface

class AsrBridge(
    private val audioEngine: AudioEngine,
) {
    @JavascriptInterface
    fun isWakeWordAvailable(): Boolean {
        return audioEngine.isWakeWordAvailable()
    }

    @JavascriptInterface
    fun startWakeListening(): Boolean {
        return audioEngine.startWakeListening()
    }

    @JavascriptInterface
    fun pauseWakeListening() {
        audioEngine.pauseWakeListening()
    }

    @JavascriptInterface
    fun isOnDeviceAsrAvailable(): Boolean {
        return audioEngine.isOnDeviceAsrAvailable()
    }

    @JavascriptInterface
    fun startAsr(mode: String): Boolean {
        return audioEngine.startAsr(mode)
    }

    @JavascriptInterface
    fun stopAsr(): Boolean {
        return audioEngine.stopAsr()
    }

    @JavascriptInterface
    fun notifyTtsState(speaking: Boolean) {
        audioEngine.notifyTtsState(speaking)
    }
}
```

---

## `WakeWordBridge.kt`

把原来的录音与 KWS 逻辑全部删掉，保留兼容委托即可：

```kotlin
package cc.hahaxiong.kidshub

import android.webkit.JavascriptInterface

class WakeWordBridge(
    private val audioEngine: AudioEngine,
) {
    @JavascriptInterface
    fun isWakeWordAvailable(): Boolean {
        return audioEngine.isWakeWordAvailable()
    }

    @JavascriptInterface
    fun startWakeListening(): Boolean {
        return audioEngine.startWakeListening()
    }

    @JavascriptInterface
    fun pauseWakeListening() {
        audioEngine.pauseWakeListening()
    }
}
```

---

## `MainActivity.kt` 关键改法

在现有 `WebView` 初始化处，用 `AsrBridge` 替换旧的 `WakeWordBridge` 注入；注入名仍然必须是 `KidshubNative`。

```kotlin
private lateinit var audioEngine: AudioEngine
private lateinit var nativeBridge: AsrBridge
```

在 `webView` 创建完成后：

```kotlin
audioEngine = AudioEngine(this, webView)
nativeBridge = AsrBridge(audioEngine)

webView.addJavascriptInterface(nativeBridge, "KidshubNative")
audioEngine.notifyNativeReady()
```

生命周期：

```kotlin
override fun onResume() {
    super.onResume()
    if (::audioEngine.isInitialized) {
        audioEngine.onResume()
    }
}

override fun onPause() {
    if (::audioEngine.isInitialized) {
        audioEngine.onPause()
    }
    super.onPause()
}

override fun onDestroy() {
    if (::audioEngine.isInitialized) {
        audioEngine.onDestroy()
    }
    super.onDestroy()
}
```

---

## 关键设计说明

- **单一 `AudioRecord`**：只有 `AudioEngine` 创建和持有 `AudioRecord`；`WakeWordBridge` 不再录音，只做委托。
- **状态机**：`IDLE` 只喂 KWS，`ASR` 只喂 `OnlineRecognizer`，`TTS_PLAYING` 物理丢弃 ASR 帧但继续喂 KWS。
- **Pre-roll**：`PcmRingBuffer` 常驻保存最近 `800ms` 的 16k float PCM；KWS 命中后创建 ASR stream 并先回灌 ring buffer。
- **TTS gating**：`notifyTtsState(true)` 立即进入 `TTS_PLAYING`；`false` 后等待 `250ms` 才允许 ASR 恢复喂帧。
- **Partial 节流**：`onAsrPartial` 仅在文本变化且间隔 `>=120ms` 时推送；`onAsrEndpoint` 和 `onAsrFinal` 立即推送。
- **降级**：KWS/ASR 初始化和运行时异常均 `catch Throwable`；ASR 失败后 `isOnDeviceAsrAvailable()` 永久返回 `false`，App 不崩。
