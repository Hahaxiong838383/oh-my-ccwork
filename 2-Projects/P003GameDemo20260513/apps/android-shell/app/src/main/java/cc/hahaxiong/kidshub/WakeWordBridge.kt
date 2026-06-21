package cc.hahaxiong.kidshub

import android.content.Context
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * WakeWordBridge —— 委托层（P1 重构）
 *
 * 录音 / KWS / ASR / TTS gating 全部逻辑已迁移至 AudioEngine（单一 AudioRecord）。
 * 本类退化为纯委托 + 兼容壳，保留原有方法签名，注入名仍为 KidshubNative。
 *
 * 目的：MainActivity / 现有调用零破坏，同时满足 "只动 android-shell 原生" + P1 验收。
 *
 * 推荐用法（MainActivity）：
 *   val engine = AudioEngine(this)
 *   val wakeBridge = WakeWordBridge(engine)   // 委托构造
 *   val asrBridge  = AsrBridge(engine)        // 作为 JS 门面注入
 */
class WakeWordBridge {

    private val engine: AudioEngine
    private val tag = "WakeWordBridge"

    /** 兼容旧 ctor：内部自建 engine（仅在独立测试时使用，生产请传共享 engine） */
    constructor(context: Context) {
        this.engine = AudioEngine(context)
        Log.i(tag, "WakeWordBridge 自建 AudioEngine（建议改用共享实例）")
    }

    /** 委托构造：与 AsrBridge / AudioEngine 共享同一实例（推荐） */
    constructor(engine: AudioEngine) {
        this.engine = engine
    }

    // ==================== 保留的 JS Bridge（完全委托） ====================

    @JavascriptInterface
    fun isWakeWordAvailable(): Boolean = engine.isWakeWordAvailable()

    @JavascriptInterface
    fun startWakeListening() {
        engine.startWakeListening()
    }

    @JavascriptInterface
    fun pauseWakeListening() {
        engine.pauseWakeListening()
    }

    // ==================== P1 新增（也暴露，保持 KidshubNative 完整） ====================

    @JavascriptInterface
    fun isOnDeviceAsrAvailable(): Boolean = engine.isOnDeviceAsrAvailable()

    @JavascriptInterface
    fun startAsr(mode: String) {
        engine.startAsr(mode)
    }

    @JavascriptInterface
    fun stopAsr() {
        engine.stopAsr()
    }

    @JavascriptInterface
    fun notifyTtsState(speaking: Boolean) {
        engine.notifyTtsState(speaking)
    }

    // ==================== 生命周期 / WebView 桥接（委托） ====================

    fun attachWebView(webView: WebView) {
        engine.attachWebView(webView)
    }

    fun notifyNativeReady() {
        engine.notifyNativeReady()
    }

    fun onResume() {
        engine.onResume()
    }

    fun onPause() {
        engine.onPause()
    }

    fun cleanup() {
        engine.cleanup()
    }
}
