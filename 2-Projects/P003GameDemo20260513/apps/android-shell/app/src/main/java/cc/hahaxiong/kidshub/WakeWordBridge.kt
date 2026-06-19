package cc.hahaxiong.kidshub

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import kotlin.concurrent.thread

/**
 * WakeWordBridge —— 基于 sherpa-onnx 的端侧离线唤醒词（替换 Picovoice Porcupine）
 *
 * 为什么换 sherpa-onnx：纯开源 Apache-2.0、完全离线、无账号、无海外激活、
 * 自定义中文唤醒词「小可小可」免重训（keywords.txt + 拼音 token）。
 * 模型：sherpa-onnx-kws-zipformer-wenetspeech-3.3M（assets/kws-model/）。
 *
 * 严格保持原 JS Bridge 契约（MainActivity / Web 端零改动）：
 *   - window.KidshubNative.{isWakeWordAvailable, startWakeListening, pauseWakeListening}
 *   - 命中唤醒 → window.KidshubWeb.onWakeWord()
 *   - notifyNativeReady → window.KidshubWeb.onNativeReady({ wakeWordAvailable })
 *
 * 麦克风互斥（关键流程）：
 *   - Web 空闲时调 startWakeListening() → 原生 AudioRecord 独占麦克风跑 KWS
 *   - 命中唤醒：原生先停录音（立即释放麦克风）→ 再 evaluate onWakeWord()
 *   - Web 录音（PTT/对话）前必须先调 pauseWakeListening() 释放麦
 *   - 录音结束后 Web 再调 startWakeListening() 恢复
 *
 * 优雅降级：模型缺失 / 初始化失败 → isWakeWordAvailable() 永久 false，Web 自动走 PTT-only。
 */
class WakeWordBridge(private val context: Context) {

    companion object {
        private const val TAG = "WakeWordBridge"
        private const val SAMPLE_RATE = 16000
        private const val FEATURE_DIM = 80
        // 5-10 岁童声基频高、咬字不清，识别率偏低 → 阈值调低（默认 0.25）以增召回；
        // 误唤醒由 PTT 兜底始终可靠。真机童声实测后再细调（team 调参环节）。
        private const val KEYWORDS_THRESHOLD = 0.20f
        private const val KEYWORDS_SCORE = 2.0f
    }

    private var keywordSpotter: KeywordSpotter? = null
    private var audioRecord: AudioRecord? = null
    private var recordThread: Thread? = null
    private var webView: WebView? = null

    @Volatile private var isListening = false
    private var wakeWordAvailable = false
    private var listeningRequested = false

    init {
        initSpotter()
    }

    /** 初始化 KeywordSpotter（必须 try-catch，失败绝不崩溃 App） */
    private fun initSpotter() {
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
                    modelType = "zipformer2",
                    numThreads = 1,
                    provider = "cpu",
                ),
                keywordsFile = "kws-model/keywords.txt",
                keywordsThreshold = KEYWORDS_THRESHOLD,
                keywordsScore = KEYWORDS_SCORE,
            )
            keywordSpotter = KeywordSpotter(assetManager = context.assets, config = config)
            wakeWordAvailable = true
            Log.i(TAG, "sherpa-onnx KeywordSpotter 初始化成功，唤醒词可用")
        } catch (e: Throwable) {
            wakeWordAvailable = false
            keywordSpotter = null
            Log.e(TAG, "KeywordSpotter 初始化失败（优雅降级 PTT-only）", e)
        }
    }

    // ==================== JS Bridge（暴露给 Web） ====================

    @JavascriptInterface
    fun isWakeWordAvailable(): Boolean = wakeWordAvailable

    @JavascriptInterface
    fun startWakeListening() {
        if (!wakeWordAvailable || keywordSpotter == null) return
        listeningRequested = true
        if (isListening) return
        startRecordingInternal()
    }

    @JavascriptInterface
    fun pauseWakeListening() {
        listeningRequested = false
        stopRecordingInternal()
        Log.d(TAG, "唤醒监听已暂停（麦克风释放给 Web）")
    }

    // ==================== 内部：录音 + KWS 流式检测 ====================

    private fun startRecordingInternal() {
        val spotter = keywordSpotter ?: return
        // 确保上一轮录音线程已彻底退出，避免麦克风/线程竞态
        stopRecordingInternal()

        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        val record: AudioRecord
        try {
            record = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf * 2,
            )
        } catch (e: Throwable) {
            Log.e(TAG, "创建 AudioRecord 失败", e)
            return
        }

        val stream: OnlineStream = spotter.createStream()
        if (stream.ptr == 0L) {
            Log.e(TAG, "createStream 失败（keywords.txt 格式错误？）")
            try { record.release() } catch (_: Throwable) {}
            return
        }

        try {
            record.startRecording()
        } catch (e: Throwable) {
            Log.e(TAG, "startRecording 失败", e)
            stream.release()
            try { record.release() } catch (_: Throwable) {}
            return
        }

        audioRecord = record
        isListening = true
        recordThread = thread(start = true) {
            val bufSize = (0.1 * SAMPLE_RATE).toInt() // 100ms / 帧
            val buffer = ShortArray(bufSize)
            var hit = false
            while (isListening) {
                val n = record.read(buffer, 0, buffer.size)
                if (n > 0) {
                    val samples = FloatArray(n) { buffer[it] / 32768.0f }
                    stream.acceptWaveform(samples, sampleRate = SAMPLE_RATE)
                    while (spotter.isReady(stream)) {
                        spotter.decode(stream)
                        val keyword = spotter.getResult(stream).keyword
                        if (keyword.isNotBlank()) {
                            spotter.reset(stream) // 命中后必须 reset
                            Log.i(TAG, "唤醒命中: $keyword")
                            hit = true
                            isListening = false
                            break
                        }
                    }
                }
            }
            // 先彻底释放麦克风，再通知 Web（契约：通知前麦克风必须已释放）
            stream.release()
            try { record.stop() } catch (_: Throwable) {}
            try { record.release() } catch (_: Throwable) {}
            if (audioRecord === record) audioRecord = null
            if (hit) notifyWakeWordDetected()
        }
        Log.d(TAG, "唤醒监听已启动")
    }

    /** 停止录音并等待线程退出（线程内部负责释放 AudioRecord，这里不重复 release） */
    private fun stopRecordingInternal() {
        isListening = false
        recordThread?.let {
            try { it.join(800) } catch (_: InterruptedException) {}
        }
        recordThread = null
    }

    // ==================== 通知 Web ====================

    private fun notifyWakeWordDetected() {
        webView?.post {
            try {
                webView?.evaluateJavascript(
                    "if (window.KidshubWeb && typeof window.KidshubWeb.onWakeWord === 'function') { window.KidshubWeb.onWakeWord(); }",
                    null,
                )
                Log.d(TAG, "已调用 Web onWakeWord()")
            } catch (e: Exception) {
                Log.e(TAG, "调用 onWakeWord 失败", e)
            }
        }
    }

    fun notifyNativeReady() {
        webView?.post {
            try {
                webView?.evaluateJavascript(
                    "if (window.KidshubWeb && typeof window.KidshubWeb.onNativeReady === 'function') { window.KidshubWeb.onNativeReady({ wakeWordAvailable: $wakeWordAvailable }); }",
                    null,
                )
            } catch (e: Exception) {
                Log.e(TAG, "调用 onNativeReady 失败", e)
            }
        }
    }

    // ==================== WebView 绑定 & 生命周期 ====================

    fun attachWebView(webView: WebView) {
        this.webView = webView
    }

    fun onResume() {
        if (listeningRequested && wakeWordAvailable && !isListening) {
            startRecordingInternal()
        }
    }

    fun onPause() {
        stopRecordingInternal()
    }

    fun cleanup() {
        listeningRequested = false
        stopRecordingInternal()
        try { keywordSpotter?.release() } catch (_: Throwable) {}
        keywordSpotter = null
        webView = null
    }
}
