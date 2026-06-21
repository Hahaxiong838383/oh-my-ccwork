package cc.hahaxiong.kidshub

import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * AsrBridge —— KidshubNative JS 门面（单一注入名）
 *
 * 暴露给 Web 的全部 @JavascriptInterface：
 * - 保留：isWakeWordAvailable / startWakeListening / pauseWakeListening
 * - 新增：isOnDeviceAsrAvailable / startAsr(mode) / stopAsr / notifyTtsState
 *
 * 全部委托给 AudioEngine（唯一 AudioRecord 持有者）。
 * 注入名仍为 "KidshubNative"，Web 无感知即可调用新增接口。
 */
class AsrBridge(private val engine: AudioEngine) {

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

    // ==================== 内部桥接（MainActivity 生命周期调用） ====================

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
