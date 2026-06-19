package cc.hahaxiong.kidshub

import android.content.Context
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import ai.picovoice.porcupine.PorcupineManager
import ai.picovoice.porcupine.PorcupineException

/**
 * WakeWordBridge
 *
 * 职责：
 * 1. 封装 Picovoice Porcupine Android SDK，实现「小可小可」中文唤醒词前台监听
 * 2. 严格实现与 Web 约定的 JS Bridge：
 *    - window.KidshubNative (addJavascriptInterface 注入)
 *    - isWakeWordAvailable / startWakeListening / pauseWakeListening
 * 3. 唤醒命中后：原生先停止 Porcupine（立即释放麦克风）→ 通过 evaluateJavascript 通知 Web
 * 4. 优雅降级：无 AccessKey 或初始化失败 → isWakeWordAvailable() 永久返回 false
 *    Web 端应自动切换为 PTT-only 模式
 *
 * 麦克风互斥规则（关键流程）：
 * - Web 空闲时调用 startWakeListening() → 原生独占麦克风跑 Porcupine
 * - 命中唤醒：原生 stop + evaluate "window.KidshubWeb.onWakeWord()"
 * - Web 要录音（PTT/对话）前必须先调用 pauseWakeListening()
 * - 录音结束后 Web 再调用 startWakeListening() 恢复
 *
 * 注意：
 * - 所有 @JavascriptInterface 方法必须在主线程安全调用
 * - evaluateJavascript 必须通过 runOnUiThread / WebView.post
 * - Porcupine 只做前台唤醒（demo 不实现 ForegroundService）
 */
class WakeWordBridge(private val context: Context) {

    companion object {
        private const val TAG = "WakeWordBridge"

        // Porcupine 模型文件名（放在 app/src/main/assets/ 下）
        // 用户必须从 Picovoice Console 下载对应中文模型
        private const val MODEL_FILE = "porcupine_params_zh.pv"

        // 关键词文件（用户训练「小可小可」后导出的 .ppn 文件名）
        // TODO: 替换为实际文件名！通常形如 "小可小可_zh_android_v3_0_0.ppn"
        private const val KEYWORD_FILE = "小可小可_zh_android_v3_0_0.ppn"

        // 灵敏度（0.0 ~ 1.0，值越大越敏感）
        // 5-10 岁童声基频较高，识别率可能偏低，建议真机 0.5~0.8 范围反复测试
        // 灵敏度过高容易误唤醒，PTT 永远是可靠兜底
        private const val SENSITIVITY = 0.65f
    }

    private var porcupineManager: PorcupineManager? = null
    private var webView: WebView? = null

    /**
     * Porcupine 是否成功初始化并可用
     * 无 key、模型文件缺失、初始化异常 → 永久 false（优雅降级）
     */
    private var wakeWordAvailable: Boolean = false

    /**
     * Web 是否期望我们在前台监听（用于 onResume 恢复）
     */
    private var listeningRequested: Boolean = false

    init {
        initializePorcupine()
    }

    /**
     * 初始化 Porcupine（必须 try-catch，失败绝不崩溃 App）
     */
    private fun initializePorcupine() {
        val accessKey = BuildConfig.PORCUPINE_ACCESS_KEY

        if (accessKey.isBlank()) {
            Log.w(TAG, "PORCUPINE_ACCESS_KEY 为空，唤醒词功能禁用（优雅降级）")
            wakeWordAvailable = false
            return
        }

        try {
            porcupineManager = PorcupineManager.Builder()
                .setAccessKey(accessKey)
                .setModelPath(MODEL_FILE)
                .setKeywordPath(KEYWORD_FILE)
                .setSensitivity(SENSITIVITY)
                .build(context) { _ ->
                    // === 唤醒词命中回调（Porcupine 内部线程）===
                    // 1. 立即停止 Porcupine，释放麦克风
                    stopListeningInternal()

                    // 2. 通知 Web（必须在 UI 线程）
                    notifyWakeWordDetected()
                }

            wakeWordAvailable = true
            Log.i(TAG, "Porcupine 初始化成功，唤醒词可用")

        } catch (e: PorcupineException) {
            wakeWordAvailable = false
            porcupineManager = null
            Log.e(TAG, "Porcupine 初始化失败（可能是 key 无效、模型缺失或网络校验失败）: ${e.message}")
        } catch (e: Exception) {
            wakeWordAvailable = false
            porcupineManager = null
            Log.e(TAG, "Porcupine 初始化未知异常（优雅降级）", e)
        }
    }

    /**
     * 通知 Web 层唤醒命中
     * 约定：原生必须在调用前已停止 Porcupine
     */
    private fun notifyWakeWordDetected() {
        webView?.post {
            try {
                webView?.evaluateJavascript(
                    "if (window.KidshubWeb && typeof window.KidshubWeb.onWakeWord === 'function') { window.KidshubWeb.onWakeWord(); }",
                    null
                )
                Log.d(TAG, "已调用 Web onWakeWord()")
            } catch (e: Exception) {
                Log.e(TAG, "调用 onWakeWord 失败", e)
            }
        }
    }

    /**
     * 通知 Web 初始化完成 + 当前可用状态
     * 推荐在 WebView onPageFinished 时调用
     */
    fun notifyNativeReady() {
        webView?.post {
            try {
                val js = """
                    if (window.KidshubWeb && typeof window.KidshubWeb.onNativeReady === 'function') {
                        window.KidshubWeb.onNativeReady({ wakeWordAvailable: $wakeWordAvailable });
                    }
                """.trimIndent()
                webView?.evaluateJavascript(js, null)
            } catch (e: Exception) {
                Log.e(TAG, "调用 onNativeReady 失败", e)
            }
        }
    }

    // ==================== JS Bridge（暴露给 Web） ====================

    /**
     * Web 调用：Porcupine 是否就绪？
     * 无 key 或初始化失败时永远返回 false → Web 自动走 PTT
     */
    @JavascriptInterface
    fun isWakeWordAvailable(): Boolean {
        return wakeWordAvailable
    }

    /**
     * Web 调用：开始唤醒监听（Web 空闲时调用）
     * 原生将独占麦克风运行 Porcupine
     */
    @JavascriptInterface
    fun startWakeListening() {
        if (!wakeWordAvailable || porcupineManager == null) return

        listeningRequested = true
        try {
            porcupineManager?.start()
            Log.d(TAG, "Porcupine 监听已启动")
        } catch (e: Exception) {
            Log.e(TAG, "start 失败", e)
        }
    }

    /**
     * Web 调用：暂停唤醒监听（PTT/对话录音前必须调用）
     * 立即释放麦克风给 Web 的 getUserMedia
     */
    @JavascriptInterface
    fun pauseWakeListening() {
        listeningRequested = false
        stopListeningInternal()
        Log.d(TAG, "Porcupine 监听已暂停（麦克风释放给 Web）")
    }

    // ==================== 内部控制 ====================

    private fun stopListeningInternal() {
        try {
            porcupineManager?.stop()
        } catch (e: Exception) {
            // 忽略 stop 时的异常
        }
    }

    // ==================== WebView 绑定 & 生命周期 ====================

    fun attachWebView(webView: WebView) {
        this.webView = webView
    }

    /**
     * Activity onResume 时调用
     */
    fun onResume() {
        if (listeningRequested && wakeWordAvailable && porcupineManager != null) {
            try {
                porcupineManager?.start()
            } catch (e: Exception) {
                Log.e(TAG, "onResume start 失败", e)
            }
        }
    }

    /**
     * Activity onPause / onStop 时调用（前台唤醒策略）
     */
    fun onPause() {
        stopListeningInternal()
    }

    /**
     * 彻底释放资源（Activity onDestroy）
     */
    fun cleanup() {
        try {
            listeningRequested = false
            porcupineManager?.stop()
            porcupineManager?.delete()
        } catch (e: Exception) {
            Log.e(TAG, "cleanup 异常", e)
        } finally {
            porcupineManager = null
            webView = null
        }
    }
}
