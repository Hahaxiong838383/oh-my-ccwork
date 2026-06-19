package cc.hahaxiong.kidshub

import android.Manifest
import android.content.pm.PackageManager
import android.net.http.SslError
import android.os.Bundle
import android.webkit.*
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 小可 Android 薄壳主 Activity
 *
 * 目标：
 * - 仅作为 WebView 容器 + 权限托管 + Porcupine 唤醒词前台壳
 * - 全部业务逻辑（WebSocket 语音、形象、字幕、登录）由 Web 侧（/m 路由）复用
 * - 原生只做「全屏 / 麦克风权限 / 唤醒词」三件事
 *
 * 技术要点：
 * 1. 沉浸式全屏（WindowCompat + WindowInsetsController）
 * 2. WebView 关键配置：
 *    - javaScriptEnabled
 *    - domStorageEnabled（复用登录态）
 *    - mediaPlaybackRequiresUserGesture = false（TTS 自动播）
 *    - WebChromeClient 托管 onPermissionRequest（getUserMedia 一次授权）
 * 3. 动态申请 RECORD_AUDIO（拒绝不崩溃，给友好提示）
 * 4. SSL 错误处理：仅 DEBUG 放行自签证书（局域网 Vite dev）
 * 5. JS Bridge：
 *    - addJavascriptInterface(name = "KidshubNative")
 *    - 启动后通过 onPageFinished 通知 Web onNativeReady
 * 6. Porcupine 通过 WakeWordBridge 封装，优雅降级
 *
 * 重要约束：
 * - 麦克风互斥：Porcupine 监听时 Web 不能录音，反之亦然
 * - 唤醒命中必须「先 stop Porcupine → 再 evaluateJavascript 通知 Web」
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var wakeWordBridge: WakeWordBridge

    // 麦克风权限请求
    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (!isGranted) {
            // 拒绝后仍继续加载 Web，Web 端有自己的 PTT 兜底
            Toast.makeText(
                this,
                "麦克风权限被拒绝，语音唤醒与录音功能将受限。请在系统设置中开启。",
                Toast.LENGTH_LONG
            ).show()
        }
        // 无论是否授权都继续初始化 WebView（Web 有兜底）
        setupWebView()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // ========== 1. 沉浸式全屏 ==========
        // 不让系统 UI 占据空间
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        // ========== 2. 初始化 Porcupine Bridge（最先做，优雅降级） ==========
        wakeWordBridge = WakeWordBridge(this)

        // ========== 3. 申请麦克风权限 ==========
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED
        ) {
            setupWebView()
        } else {
            requestPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    /**
     * 配置并加载 WebView
     * 在权限回调或已有权限时调用
     */
    private fun setupWebView() {
        setContent {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    WebView(ctx).apply {
                        webView = this

                        // ========== WebView 核心配置 ==========
                        settings.apply {
                            javaScriptEnabled = true
                            domStorageEnabled = true          // 复用 localStorage/sessionStorage 登录态
                            mediaPlaybackRequiresUserGesture = false  // 允许 TTS 自动播放
                            allowFileAccess = false
                            allowContentAccess = false
                            // 混合内容（局域网 https 自签时偶尔需要）
                            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                        }

                        // 托管 Web 权限请求（getUserMedia 麦克风）
                        webChromeClient = object : WebChromeClient() {
                            override fun onPermissionRequest(request: PermissionRequest) {
                                // 直接授权请求的资源（主要是 AUDIO_CAPTURE）
                                // 这样 Web getUserMedia 只弹一次（原生已弹过权限）
                                if (request.resources.any { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }) {
                                    request.grant(request.resources)
                                } else {
                                    request.deny()
                                }
                            }
                        }

                        // WebViewClient：处理页面完成 + SSL 错误
                        webViewClient = object : WebViewClient() {

                            override fun onPageFinished(view: WebView?, url: String?) {
                                super.onPageFinished(view, url)

                                // 页面加载完后通知 Web 原生就绪状态（包含 wakeWordAvailable）
                                // Web 侧可用此信息决定是否显示「唤醒词可用」或只用 PTT
                                wakeWordBridge.notifyNativeReady()
                            }

                            // ========== 自签证书放行（仅 debug，用于局域网 dev） ==========
                            // 生产 release 版本必须走 handler.cancel()，否则存在安全风险
                            override fun onReceivedSslError(
                                view: WebView?,
                                handler: SslErrorHandler?,
                                error: SslError?
                            ) {
                                if (BuildConfig.DEBUG) {
                                    // 仅开发调试放行（192.168.x.x 或 localhost 自签证书）
                                    handler?.proceed()
                                } else {
                                    handler?.cancel()
                                }
                            }

                            // 可选：拦截所有请求做日志（生产删除）
                            // override fun shouldInterceptRequest(...) ...
                        }

                        // ========== 注入 Native Bridge ==========
                        // Web 通过 window.KidshubNative.xxx() 调用
                        addJavascriptInterface(wakeWordBridge, "KidshubNative")

                        // 绑定给 Bridge（用于 evaluateJavascript 回调）
                        wakeWordBridge.attachWebView(this)

                        // ========== 加载目标页面 ==========
                        // 可在 BuildConfig 里修改
                        loadUrl(BuildConfig.WEBVIEW_URL)
                    }
                }
            )
        }
    }

    // ========== 生命周期：管理 Porcupine 监听 ==========

    override fun onResume() {
        super.onResume()
        // 如果 Web 之前请求过监听，且当前可用，则恢复
        if (::wakeWordBridge.isInitialized) {
            wakeWordBridge.onResume()
        }
    }

    override fun onPause() {
        super.onPause()
        if (::wakeWordBridge.isInitialized) {
            wakeWordBridge.onPause()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::wakeWordBridge.isInitialized) {
            wakeWordBridge.cleanup()
        }
    }

    // 可选：按返回键时如果 Web 可以后退则后退，否则默认
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
