package cc.hahaxiong.kidshub

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Log
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
import kotlin.concurrent.thread

/**
 * AudioEngine —— 端侧 ASR/KWS 统一音频引擎（单一 AudioRecord）
 *
 * 核心职责（严格遵守 docs/32 §11 硬约束）：
 * 1. 唯一 AudioRecord（VOICE_RECOGNITION, 16k, MONO, PCM16）
 * 2. 状态机：IDLE（仅 KWS） / ASR（OnlineRecognizer） / TTS_PLAYING（ASR 物理丢帧，KWS 继续打断）
 * 3. 常驻 ~800ms ring buffer：KWS 命中时把历史帧+实时帧回灌给新建 ASR stream（防首字截断）
 * 4. KWS↔ASR 无缝切换：不释放 AudioRecord，只换 stream + 喂目标
 * 5. TTS gating：notifyTtsState(true) → ASR 物理丢帧（不喂 stream）；false 时延迟 ~250ms 恢复
 *    （吸收 JS 异步 + 功放余振；不依赖 AcousticEchoCanceler 对 STREAM_MUSIC 生效）
 * 6. ASR endpointing：enableEndpoint=true；rule2.minTrailingSilence=1.1s（童声宽容）
 *    命中 → onAsrEndpoint() + onAsrFinal(text) + reset
 * 7. partial 节流：≥120ms 且文本变化才推
 * 8. 两种模式：startAsr("ptt") 忽略 endpoint（松手 stopAsr 收尾）；"auto" 用 endpoint 自动收尾
 * 9. 优雅降级：模型缺失/init失败 → isOnDeviceAsrAvailable()=false，Web 自动回退云端
 * 10. 线程安全：录音单后台线程；currentAsrStream 跨线程访问由 asrLock 互斥（防 use-after-release）
 *
 * 麦克风互斥契约保留：pauseWakeListening / startWakeListening 仍控制录音线程启停。
 */
class AudioEngine(private val context: Context) {

    companion object {
        private const val TAG = "AudioEngine"
        private const val SAMPLE_RATE = 16000
        private const val PRE_ROLL_MS = 800
        private const val PRE_ROLL_SAMPLES = PRE_ROLL_MS * SAMPLE_RATE / 1000 // 12800
        private const val PARTIAL_MIN_INTERVAL_MS = 120L
        private const val TTS_RESUME_DELAY_MS = 250L
        // KWS gating 恢复延迟（防 TTS 自声自唤醒，team 三发共识 300-500ms）：比 ASR 长，
        // 叠词「小可小可」对扬声器尾音/混响更敏感，恢复太早会被尾音再次自唤醒。
        private const val KWS_RESUME_DELAY_MS = 400L
        private const val CHUNK_MS = 100
        private const val CHUNK_SIZE = SAMPLE_RATE * CHUNK_MS / 1000 // 1600 samples

        // 童声宽容 endpoint：rule2 尾静音（team 三发：1.1s 太短，儿童语速慢/句中停顿长会被切成多段→多 final→双声音；调到 1.6s）
        private const val CHILD_MIN_TRAILING_SILENCE = 1.6f
    }

    // ==================== 状态与资源 ====================

    private enum class EngineState { IDLE, ASR, TTS_PLAYING }

    @Volatile private var engineState: EngineState = EngineState.IDLE
    @Volatile private var asrMode: String = "auto" // "auto" | "ptt"
    @Volatile private var ttsSpeaking: Boolean = false
    @Volatile private var ttsResumeTimestamp: Long = 0L
    // KWS gating 恢复时间戳（TTS 自唤醒修复，team 三发共识）：TTS 期 + 结束后 KWS_RESUME_DELAY_MS 尾窗内不喂 KWS。
    @Volatile private var kwsResumeTimestamp: Long = 0L

    @Volatile private var isRecordingActive: Boolean = false
    private var listeningRequested: Boolean = false

    private var audioRecord: AudioRecord? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var recordThread: Thread? = null

    private var keywordSpotter: KeywordSpotter? = null
    private var kwsStream: OnlineStream? = null

    private var onlineRecognizer: OnlineRecognizer? = null
    private var currentAsrStream: OnlineStream? = null

    private var webView: WebView? = null

    @Volatile private var wakeWordAvailable: Boolean = false
    @Volatile private var asrAvailable: Boolean = false

    // 节流
    private var lastPartialText: String = ""
    private var lastPartialTs: Long = 0L

    // 常驻环形缓冲（KWS 命中回灌用）
    private val ringBuffer = AudioRingBuffer(PRE_ROLL_SAMPLES)

    // currentAsrStream 跨线程（Bridge 线程 startAsr/stopAsr ↔ 录音线程 decode）生命周期互斥锁。
    // 防 use-after-release：Bridge 线程 release stream 时录音线程正 acceptWaveform/decode 同一 stream → native crash。
    private val asrLock = Any()

    init {
        initKws()
        initAsr()
    }

    // ==================== 初始化（优雅降级） ====================

    private fun initKws() {
        try {
            val config = KeywordSpotterConfig(
                featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
                modelConfig = OnlineModelConfig(
                    transducer = OnlineTransducerModelConfig(
                        encoder = "kws-model/encoder.onnx",
                        decoder = "kws-model/decoder.onnx",
                        joiner = "kws-model/joiner.onnx",
                    ),
                    tokens = "kws-model/tokens.txt",
                    modelType = "zipformer2",
                    numThreads = 1,
                    provider = "cpu",
                ),
                keywordsFile = "kws-model/keywords.txt",
                keywordsThreshold = 0.20f,
                keywordsScore = 2.0f,
            )
            keywordSpotter = KeywordSpotter(assetManager = context.assets, config = config)
            wakeWordAvailable = true
            Log.i(TAG, "KeywordSpotter 初始化成功")
        } catch (e: Throwable) {
            wakeWordAvailable = false
            keywordSpotter = null
            Log.e(TAG, "KeywordSpotter 初始化失败（优雅降级）", e)
        }
    }

    private fun initAsr() {
        try {
            val config = OnlineRecognizerConfig(
                featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
                modelConfig = OnlineModelConfig(
                    zipformer2Ctc = OnlineZipformer2CtcModelConfig(
                        model = "asr-model-v15/model.int8.onnx",
                    ),
                    tokens = "asr-model-v15/tokens.txt",
                    numThreads = 2,
                    provider = "cpu",
                ),
                endpointConfig = EndpointConfig(
                    rule1 = EndpointRule(false, 2.4f, 0f),
                    rule2 = EndpointRule(true, CHILD_MIN_TRAILING_SILENCE, 0f),
                    rule3 = EndpointRule(false, 0f, 20f),
                ),
                enableEndpoint = true,
                decodingMethod = "greedy_search",
            )
            onlineRecognizer = OnlineRecognizer(assetManager = context.assets, config = config)
            asrAvailable = true
            Log.i(TAG, "OnlineRecognizer (type15) 初始化成功")
        } catch (e: Throwable) {
            asrAvailable = false
            onlineRecognizer = null
            Log.e(TAG, "OnlineRecognizer 初始化失败（isOnDeviceAsrAvailable 将返回 false）", e)
        }
    }

    // ==================== 公共 API（供 Bridge 调用） ====================

    fun isWakeWordAvailable(): Boolean = wakeWordAvailable

    fun isOnDeviceAsrAvailable(): Boolean = asrAvailable

    fun startWakeListening() {
        if (!wakeWordAvailable && !asrAvailable) return
        listeningRequested = true
        if (!isRecordingActive) {
            startRecordingInternal()
        }
    }

    fun pauseWakeListening() {
        listeningRequested = false
        stopRecordingInternal()
        Log.d(TAG, "pauseWakeListening：录音线程停止，麦克风释放")
    }

    fun startAsr(mode: String) {
        if (!asrAvailable || onlineRecognizer == null) {
            Log.w(TAG, "startAsr 被调用但 ASR 不可用（优雅降级）")
            return
        }
        val m = if (mode == "ptt") "ptt" else "auto"
        asrMode = m

        // 确保录音线程在跑（同一 AudioRecord）。在锁外调用——startRecordingInternal 会 join 录音线程，
        // 若持 asrLock 调用，录音线程正等 asrLock 处理 ASR 帧 → 死锁。
        if (!isRecordingActive) {
            startRecordingInternal()
        }

        synchronized(asrLock) {
            // 停止旧 ASR stream
            currentAsrStream?.let {
                try { it.release() } catch (_: Throwable) {}
                currentAsrStream = null
            }

            // 新建 stream（pre-roll 回灌已禁用：ring buffer 的 800ms 恰含「小可小可」唤醒词本身，
            // 回灌会让 ASR 识别唤醒词→当成用户输入→自答，真机实测 bug1。牺牲极少首字换不自答）。
            val stream = try {
                onlineRecognizer!!.createStream()
            } catch (e: Throwable) {
                Log.e(TAG, "createStream 失败", e)
                return
            }

            currentAsrStream = stream
            lastPartialText = ""
            lastPartialTs = 0L
            engineState = EngineState.ASR
            Log.i(TAG, "startAsr mode=$m（pre-roll 已禁用防自答唤醒词）")
        }
    }

    fun stopAsr() {
        synchronized(asrLock) {
            val rec = onlineRecognizer ?: return
            val stream = currentAsrStream ?: return

            try {
                // flush 尾部
                try { stream.inputFinished() } catch (_: Throwable) {}
                var guard = 0
                while (rec.isReady(stream) && guard++ < 60) {
                    rec.decode(stream)
                }
                val text = rec.getResult(stream).text
                if (text.isNotBlank()) {
                    notifyAsrFinal(text)
                }
                // 收尾清 partial 状态（同时让 try 块以 Unit 赋值结尾，避免 synchronized 把无-else 的 if 当表达式返回值）
                lastPartialText = ""
                lastPartialTs = 0L
            } catch (e: Throwable) {
                Log.w(TAG, "stopAsr flush 异常", e)
            } finally {
                try { stream.release() } catch (_: Throwable) {}
                currentAsrStream = null
                engineState = EngineState.IDLE
                Log.d(TAG, "stopAsr 完成")
            }
        }
    }

    fun notifyTtsState(speaking: Boolean) {
        val prevSpeaking = ttsSpeaking
        ttsSpeaking = speaking
        val now = System.currentTimeMillis()
        if (speaking) {
            ttsResumeTimestamp = 0L
            kwsResumeTimestamp = 0L
            if (engineState == EngineState.ASR) {
                engineState = EngineState.TTS_PLAYING
            }
        } else {
            ttsResumeTimestamp = now + TTS_RESUME_DELAY_MS
            // KWS 恢复延迟更长（防扬声器尾音余振再次触发「小可小可」自唤醒）。
            kwsResumeTimestamp = now + KWS_RESUME_DELAY_MS
            // 恢复：有 active ASR stream 才回 ASR 态，否则回 IDLE（纯待唤醒被 TTS gate 过的情况）。
            if (engineState == EngineState.TTS_PLAYING) {
                engineState = if (currentAsrStream != null) EngineState.ASR else EngineState.IDLE
            }
        }
        if (prevSpeaking != speaking) {
            Log.d(TAG, "notifyTtsState: $speaking (asrResume@$ttsResumeTimestamp kwsResume@$kwsResumeTimestamp)")
        }
    }

    // ==================== 录音线程（唯一 AudioRecord） ====================

    private fun startRecordingInternal() {
        stopRecordingInternal() // 确保上一轮退出

        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )

        val record: AudioRecord = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf * 2
            )
        } catch (e: Throwable) {
            Log.e(TAG, "AudioRecord 创建失败", e)
            return
        }

        // AEC/NS best-effort（不依赖它防 TTS 自激，靠物理丢帧）
        val sessionId = record.audioSessionId
        if (AcousticEchoCanceler.isAvailable()) {
            try {
                echoCanceler = AcousticEchoCanceler.create(sessionId)?.also { it.enabled = true }
            } catch (e: Throwable) {
                Log.w(TAG, "AcousticEchoCanceler 绑定失败（忽略）", e)
            }
        }
        if (NoiseSuppressor.isAvailable()) {
            try {
                noiseSuppressor = NoiseSuppressor.create(sessionId)?.also { it.enabled = true }
            } catch (e: Throwable) {
                Log.w(TAG, "NoiseSuppressor 绑定失败（忽略）", e)
            }
        }

        val kws = keywordSpotter
        val kwsStr = if (kws != null) {
            try { kws.createStream() } catch (e: Throwable) {
                Log.e(TAG, "KWS createStream 失败", e); null
            }
        } else null

        try {
            record.startRecording()
        } catch (e: Throwable) {
            Log.e(TAG, "startRecording 失败", e)
            kwsStr?.release()
            try { record.release() } catch (_: Throwable) {}
            return
        }

        audioRecord = record
        kwsStream = kwsStr
        isRecordingActive = true

        recordThread = thread(name = "AudioEngine-Record", start = true) {
            val buffer = ShortArray(CHUNK_SIZE)
            var localHit = false

            while (isRecordingActive) {
                val n = try { record.read(buffer, 0, buffer.size) } catch (_: Throwable) { -1 }
                if (n <= 0) {
                    Thread.yield()
                    continue
                }

                val samples = FloatArray(n) { buffer[it] / 32768.0f }

                // 1. 永远推进 ring buffer（pre-roll 来源）
                ringBuffer.push(samples)

                // 2. KWS gating（TTS 自唤醒修复，team 三发共识）：TTS 播放期 + 结束后 KWS_RESUME_DELAY_MS
                //    尾窗内不喂 KWS，防麦克风录到小可自声「小可」→ 自唤醒（硬件 AEC 对 STREAM_MUSIC 不生效，只能物理 gate）。
                //    代价：TTS 期失去「喊小可小可打断」，靠 PTT/触控打断兜底。后续可上文本感知 gating 保留大部分语音打断。
                val kwsGated = ttsSpeaking || System.currentTimeMillis() < kwsResumeTimestamp
                if (!kwsGated) kwsStream?.let { ks ->
                    try {
                        ks.acceptWaveform(samples, SAMPLE_RATE)
                        while (kws?.isReady(ks) == true) {
                            kws.decode(ks)
                            val kw = kws.getResult(ks).keyword
                            if (kw.isNotBlank()) {
                                kws.reset(ks)
                                Log.i(TAG, "唤醒命中: $kw")
                                localHit = true
                                // 命中后切换 ASR（回灌 + 通知）
                                handleWakeHit()
                                // hit 后是否继续当前循环由上层控制，这里不立刻停线程
                                break
                            }
                        }
                    } catch (e: Throwable) {
                        Log.w(TAG, "KWS 处理异常", e)
                    }
                }

                // 3. ASR 喂帧（synchronized 防 Bridge 线程 startAsr/stopAsr 并发 release stream → use-after-release）
                synchronized(asrLock) {
                    val asrStream = currentAsrStream
                    val rec = onlineRecognizer
                    if (asrStream != null && rec != null) {
                        val now = System.currentTimeMillis()
                        // TTS 播放（含 250ms 恢复延迟窗）期间物理丢帧：不喂 ASR，防录到小可自声自激。
                        // 仅 ASR 态且不在 TTS gate 内才喂（TTS_PLAYING→ASR 的恢复由 notifyTtsState(false) 处理）。
                        val ttsDrop = ttsSpeaking || now < ttsResumeTimestamp
                        val shouldFeedAsr = !ttsDrop && engineState == EngineState.ASR

                        if (shouldFeedAsr) {
                            try {
                                asrStream.acceptWaveform(samples, SAMPLE_RATE)
                                while (rec.isReady(asrStream)) {
                                    rec.decode(asrStream)
                                }

                                // partial（节流）
                                maybeNotifyPartial(rec, asrStream)

                                // endpoint（仅 auto 模式）—— team 三发方向 X：endpoint = 一轮结束。
                                // 出 final 后**释放 stream + 回 IDLE**（不 reset 连续识别下一句），等 Web onAsrFinal→finishTurn→
                                // （followup）下一轮 startAsr 重新 createStream。根治"一句被切多段→多 final→双声音叠"。
                                // 副作用：finishTurn 的 stopAsr 此时 currentAsrStream 已 null → 自然 no-op，不会二次 emit final。
                                if (asrMode == "auto" && rec.isEndpoint(asrStream)) {
                                    val finalText = rec.getResult(asrStream).text
                                    notifyAsrEndpoint()
                                    if (finalText.isNotBlank()) {
                                        notifyAsrFinal(finalText)
                                    }
                                    try { asrStream.release() } catch (_: Throwable) {}
                                    currentAsrStream = null
                                    engineState = EngineState.IDLE
                                    lastPartialText = ""
                                    lastPartialTs = 0L
                                }
                            } catch (e: Throwable) {
                                Log.w(TAG, "ASR 处理异常", e)
                            }
                        }
                    }
                }
            }

            // 线程退出清理
            cleanupStreamsAndRecord(record, kwsStream)
            kwsStream = null
            if (localHit) {
                // 已在 handleWakeHit 里通知，此处仅兜底
            }
        }
        Log.d(TAG, "录音线程启动（单一 AudioRecord）")
    }

    /** KWS 命中：通知 Web + 放弃旧 ASR + ring buffer 回灌建新 ASR。stream 操作入 asrLock 与 Bridge 线程互斥。 */
    private fun handleWakeHit() {
        // 通知 Web（先通知，契约要求命中后尽快）
        notifyWakeWord()

        synchronized(asrLock) {
            // 放弃当前 ASR（唤醒优先启动新对话）
            currentAsrStream?.let {
                try { it.release() } catch (_: Throwable) {}
                currentAsrStream = null
            }

            // 如果 ASR 可用，立刻用 ring buffer 回灌创建新 ASR stream
            val rec = onlineRecognizer
            if (asrAvailable && rec != null) {
                try {
                    val newStream = rec.createStream()
                    // pre-roll 回灌已禁用（同 startAsr）：避免回灌唤醒词「小可小可」→ ASR 自答（真机实测 bug1）。
                    currentAsrStream = newStream
                    lastPartialText = ""
                    lastPartialTs = 0L
                    asrMode = "auto"
                    engineState = EngineState.ASR
                    Log.i(TAG, "KWS命中 → ASR 启动（pre-roll 已禁用防自答）")
                } catch (e: Throwable) {
                    Log.e(TAG, "wake后创建 ASR stream 失败", e)
                    engineState = EngineState.IDLE
                }
            } else {
                engineState = EngineState.IDLE
            }
        }
    }

    /** 节流推送 partial（调用方已持 asrLock）。 */
    private fun maybeNotifyPartial(rec: OnlineRecognizer, stream: OnlineStream) {
        val text = try { rec.getResult(stream).text.trim() } catch (_: Throwable) { return }
        if (text.isBlank()) return
        val now = System.currentTimeMillis()
        if (text != lastPartialText && now - lastPartialTs >= PARTIAL_MIN_INTERVAL_MS) {
            lastPartialText = text
            lastPartialTs = now
            notifyAsrPartial(text)
        }
    }

    private fun stopRecordingInternal() {
        isRecordingActive = false
        recordThread?.let {
            try { it.join(900) } catch (_: InterruptedException) {}
        }
        recordThread = null
    }

    private fun cleanupStreamsAndRecord(record: AudioRecord, kwsStr: OnlineStream?) {
        try { kwsStr?.release() } catch (_: Throwable) {}
        synchronized(asrLock) {
            try { currentAsrStream?.release() } catch (_: Throwable) {}
            currentAsrStream = null
        }

        try { record.stop() } catch (_: Throwable) {}
        try { record.release() } catch (_: Throwable) {}

        try { echoCanceler?.release() } catch (_: Throwable) {}
        try { noiseSuppressor?.release() } catch (_: Throwable) {}
        echoCanceler = null
        noiseSuppressor = null

        if (audioRecord === record) audioRecord = null
    }

    // ==================== Web 回调（evaluateJavascript） ====================

    private fun notifyWakeWord() {
        webView?.post {
            try {
                webView?.evaluateJavascript(
                    "if (window.KidshubWeb && typeof window.KidshubWeb.onWakeWord === 'function') { window.KidshubWeb.onWakeWord(); }",
                    null
                )
            } catch (e: Exception) {
                Log.e(TAG, "onWakeWord 调用失败", e)
            }
        }
    }

    private fun notifyAsrPartial(text: String) {
        webView?.post {
            try {
                val safe = escapeForJs(text)
                webView?.evaluateJavascript(
                    "if (window.KidshubWeb && typeof window.KidshubWeb.onAsrPartial === 'function') { window.KidshubWeb.onAsrPartial('$safe'); }",
                    null
                )
            } catch (e: Exception) {
                Log.e(TAG, "onAsrPartial 调用失败", e)
            }
        }
    }

    private fun notifyAsrEndpoint() {
        webView?.post {
            try {
                webView?.evaluateJavascript(
                    "if (window.KidshubWeb && typeof window.KidshubWeb.onAsrEndpoint === 'function') { window.KidshubWeb.onAsrEndpoint(); }",
                    null
                )
            } catch (e: Exception) {
                Log.e(TAG, "onAsrEndpoint 调用失败", e)
            }
        }
    }

    private fun notifyAsrFinal(text: String) {
        webView?.post {
            try {
                val safe = escapeForJs(text)
                webView?.evaluateJavascript(
                    "if (window.KidshubWeb && typeof window.KidshubWeb.onAsrFinal === 'function') { window.KidshubWeb.onAsrFinal('$safe'); }",
                    null
                )
            } catch (e: Exception) {
                Log.e(TAG, "onAsrFinal 调用失败", e)
            }
        }
    }

    private fun escapeForJs(s: String): String {
        return s.replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\"", "\\\"")
            .replace("\n", " ")
            .replace("\r", "")
    }

    fun notifyNativeReady() {
        webView?.post {
            try {
                webView?.evaluateJavascript(
                    "if (window.KidshubWeb && typeof window.KidshubWeb.onNativeReady === 'function') { window.KidshubWeb.onNativeReady({ wakeWordAvailable: $wakeWordAvailable, onDeviceAsrAvailable: $asrAvailable }); }",
                    null
                )
            } catch (e: Exception) {
                Log.e(TAG, "onNativeReady 调用失败", e)
            }
        }
    }

    // ==================== WebView & 生命周期 ====================

    fun attachWebView(webView: WebView) {
        this.webView = webView
    }

    fun onResume() {
        if (listeningRequested) {
            if (!isRecordingActive) startRecordingInternal()
        }
    }

    fun onPause() {
        stopRecordingInternal()
    }

    fun cleanup() {
        listeningRequested = false
        stopRecordingInternal()
        try { keywordSpotter?.release() } catch (_: Throwable) {}
        try { onlineRecognizer?.release() } catch (_: Throwable) {}
        keywordSpotter = null
        onlineRecognizer = null
        webView = null
    }

    // ==================== Ring Buffer ====================

    private class AudioRingBuffer(private val capacity: Int) {
        private val buf = FloatArray(capacity)
        private var writePos = 0
        private var filled = 0

        @Synchronized
        fun push(samples: FloatArray) {
            for (s in samples) {
                buf[writePos] = s
                writePos = (writePos + 1) % capacity
                if (filled < capacity) filled++
            }
        }

        @Synchronized
        fun snapshot(): FloatArray {
            if (filled == 0) return FloatArray(0)
            val out = FloatArray(filled)
            val start = if (filled < capacity) 0 else writePos
            for (i in 0 until filled) {
                out[i] = buf[(start + i) % capacity]
            }
            return out
        }

        @Synchronized
        fun clear() {
            writePos = 0
            filled = 0
        }
    }
}
