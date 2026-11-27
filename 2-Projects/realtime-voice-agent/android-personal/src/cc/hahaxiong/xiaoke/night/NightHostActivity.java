package cc.hahaxiong.xiaoke.night;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * 宿主 Activity：
 *  - 只加载本源 https://appassets.androidplatform.net/index.html（assets 内资源）；
 *  - Web 能力只放行本源麦克风，且必须已获得系统 RECORD_AUDIO；
 *  - 前台通话：MODE_IN_COMMUNICATION + 外放 + 音频焦点，退出时完整恢复；
 *  - 失焦 / 后台 / 返回键 / ACTION_BACK：先让页面 window.Voice.stop()，宽限后原生强制释放采集与音频。
 */
public final class NightHostActivity extends Activity {

    static final String ACTION_BACK = "cc.hahaxiong.xiaoke.night.ACTION_BACK";
    /** 兼容语音端/遥控把“返回”当通用 action 下发的情形。 */
    private static final String ACTION_BACK_GENERIC = "android.intent.action.BACK";

    private static final String TAG = "NightHost";
    private static final int REQ_MIC = 4101;
    /** 给页面 JS 一点时间自行断开后再强拆采集。 */
    private static final long RELEASE_GRACE_MS = 280L;
    private static final long WEBVIEW_PAUSE_DELAY_MS = 360L;
    private static final long EXIT_DELAY_MS = 340L;

    private final ArrayDeque<String> pendingMicIds = new ArrayDeque<String>();

    private Handler main;
    private WebView web;
    private NightAssets assets;
    private SecureStore store;
    private TicketClient tickets;
    private NightSync sync;
    private NightBridge bridge;
    private AudioGuard audio;

    private PermissionRequest activeCapture;
    private boolean micDialogOpen;
    private boolean foreground;
    private boolean pageLoaded;
    private boolean openUpdates;
    private volatile boolean trustedPage;
    private volatile boolean finishing;
    private volatile boolean callActive;

    private final Runnable hardRelease = new Runnable() {
        @Override
        public void run() {
            releaseCapture();
            if (audio != null) {
                audio.exitCall();
            }
            callActive = false;
            try {
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } catch (Throwable ignored) {
            }
        }
    };

    private final Runnable webViewPause = new Runnable() {
        @Override
        public void run() {
            if (!foreground && web != null) {
                try {
                    web.onPause();
                } catch (Throwable ignored) {
                }
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        main = new Handler(Looper.getMainLooper());
        assets = new NightAssets(this);
        store = new SecureStore(this);
        tickets = new TicketClient();
        sync = new NightSync(this, store);
        audio = new AudioGuard(this);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF07080C);
        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(web);
        setContentView(root);

        configureWebView();

        bridge = new NightBridge(this, web, store, tickets, sync);
        sync.attachGateway(new NightSync.HostGateway() {
            @Override
            public boolean isPageTrusted() {
                return pageTrusted();
            }

            @Override
            public void deliverSyncAccent(String hex) {
                if (bridge != null) {
                    bridge.deliverSyncAccent(hex);
                }
            }

            @Override
            public void triggerSyncLogs() {
                NightDiagnostics.flush(NightHostActivity.this);
            }

            @Override
            public void triggerCheckUpdate() {
                NightDiagnostics.event(NightHostActivity.this, "ota_check");
                NightOta.check(NightHostActivity.this);
                if (bridge != null) {
                    bridge.notifyOtaChange();
                }
            }
        });
        web.addJavascriptInterface(bridge, "NightHost");
        web.loadUrl(NightAssets.START_URL);

        handleIntent(getIntent());
    }

    // ------------------------------------------------------------ webview 配置

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setSafeBrowsingEnabled(true);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " XiaokeNightHost/1.0.0");

        web.setBackgroundColor(0xFF07080C);
        web.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        WebView.setWebContentsDebuggingEnabled(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request == null ? null : request.getUrl();
                return blockIfForeign(uri == null ? null : uri.toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return blockIfForeign(url);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.intercept(request);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!NightAssets.START_URL.equals(url) || !pageTrusted()) return;
                pageLoaded = true;
                if (sync != null) {
                    sync.onPageReady();
                }
                showRequestedUpdate();
                maybeRequestNotifications();
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                pageLoaded = false;
                trustedPage = NightAssets.START_URL.equals(url);
                if (sync != null) {
                    sync.onPageStarted(trustedPage);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                handleWebPermission(request);
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (activeCapture == request) {
                    activeCapture = null;
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                // WebRTC diagnostics may contain signed signaling URLs. Do not log web console text.
                return true;
            }
        });
    }

    private boolean blockIfForeign(String url) {
        if (NightAssets.isLocalHttp(url)) {
            return false;
        }
        Log.w(TAG, "blocked external navigation");
        return true;
    }

    private void handleWebPermission(PermissionRequest request) {
        if (request == null) {
            return;
        }
        String origin = request.getOrigin() == null ? null : request.getOrigin().toString();
        boolean localOrigin = origin != null && NightAssets.ORIGIN.equals(stripTrailingSlash(origin));
        boolean wantsAudio = false;
        String[] resources = request.getResources();
        if (resources != null) {
            for (String resource : resources) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                    wantsAudio = true;
                }
            }
        }
        boolean allow = localOrigin && wantsAudio && foreground && !finishing && micGranted();
        if (!allow) {
            Log.i(TAG, "web permission denied (localOrigin=" + localOrigin
                    + ", audio=" + wantsAudio + ", sysMic=" + micGranted() + ")");
            try {
                request.deny();
            } catch (Throwable ignored) {
            }
            return;
        }
        // 只放行录音，绝不授予摄像头等其它资源
        try {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            activeCapture = request;
            Log.i(TAG, "web permission granted: audio capture");
        } catch (Throwable t) {
            activeCapture = null;
        }
    }

    // ------------------------------------------------------------- 宿主契约

    boolean pageTrusted() {
        if (web == null || finishing) {
            return false;
        }
        return trustedPage;
    }

    void applyCallState(boolean active) {
        if (active) {
            callActive = true;
            audio.enterCall();
            try {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } catch (Throwable ignored) {
            }
            if (!micGranted() && foreground && !micDialogOpen && pendingMicIds.isEmpty()) {
                openMicDialog();
            }
        } else {
            callActive = false;
            audio.exitCall();
            try {
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } catch (Throwable ignored) {
            }
            main.removeCallbacks(hardRelease);
            releaseCapture();
        }
    }

    boolean isInVoiceCall() { return callActive; }

    void requestMicPermission(String requestId) {
        if (micGranted()) {
            bridge.deliverPermission(requestId, true);
            return;
        }
        if (!foreground || finishing) {
            bridge.deliverPermission(requestId, false);
            return;
        }
        pendingMicIds.add(requestId);
        if (!micDialogOpen) {
            openMicDialog();
        }
    }

    private void openMicDialog() {
        micDialogOpen = true;
        try {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        } catch (Throwable t) {
            micDialogOpen = false;
            answerPendingMic(false);
        }
    }

    private void answerPendingMic(boolean granted) {
        List<String> waiting = new ArrayList<String>(pendingMicIds);
        pendingMicIds.clear();
        for (String id : waiting) {
            bridge.deliverPermission(id, granted);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_UPDATES && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            OtaNotifications.update(this, NightOta.snapshot(this));
        }
        if (requestCode != REQ_MIC) {
            return;
        }
        micDialogOpen = false;
        boolean granted = grantResults != null && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        answerPendingMic(granted && micGranted());
    }

    private static final int REQ_UPDATES = 4102;

    private void maybeRequestNotifications() {
        if (android.os.Build.VERSION.SDK_INT < 33 || !pageLoaded || !hasWindowFocus() || !foreground
                || finishing || micDialogOpen || isInVoiceCall() || OtaConfig.inCall(this)
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        android.content.SharedPreferences prefs = getSharedPreferences("night_notifications", MODE_PRIVATE);
        if (prefs.getBoolean("asked", false)) return;
        // A settings round trip may resume a pending install; let that flow keep focus.
        String phase = NightOta.snapshot(this).optString("state");
        if ("wait_permission".equals(phase) || "preparing_install".equals(phase)
                || "pending_confirmation".equals(phase) || "installing".equals(phase)) return;
        prefs.edit().putBoolean("asked", true).apply();
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_UPDATES);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) maybeRequestNotifications();
    }

    private void showRequestedUpdate() {
        if (openUpdates && pageLoaded && pageTrusted()) {
            openUpdates = false;
            web.evaluateJavascript("window.dispatchEvent(new Event('night-open-update'))", null);
        }
    }

    private boolean micGranted() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    // --------------------------------------------------------------- 释放路径

    void releaseSession(String reason) {
        if (finishing) {
            return;
        }
        callActive = false;
        if (bridge != null) {
            bridge.notifyStop();
        }
        if (audio != null) {
            audio.exitCall();
        }
        try {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } catch (Throwable ignored) {
        }
        main.removeCallbacks(hardRelease);
        main.postDelayed(hardRelease, RELEASE_GRACE_MS);
        Log.i(TAG, "release session: " + reason);
    }

    /** 掐断 WebView 侧仍在进行的录音（grant 过的 PermissionRequest 用 deny() 收口）。 */
    void releaseCapture() {
        PermissionRequest request = activeCapture;
        activeCapture = null;
        if (request != null) {
            try {
                request.deny();
                Log.i(TAG, "capture request denied to force release");
            } catch (Throwable ignored) {
            }
        }
    }

    private void exitApp(String reason) {
        if (finishing) {
            return;
        }
        if (sync != null) {
            sync.onForeground(false);
        }
        releaseSession(reason);
        finishing = true;
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                finish();
            }
        }, EXIT_DELAY_MS);
    }

    // ----------------------------------------------------------------- 生命周期

    @Override
    protected void onStart() {
        super.onStart();
        foreground = true;
        if (sync != null) {
            sync.onForeground(true);
        }
        NightOta.enter(this);
        NightDiagnostics.schedule(this);
        if (web != null) {
            try {
                web.onResume();
            } catch (Throwable ignored) {
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        NightOta.resumed(this);
    }

    @Override
    protected void onPause() {
        NightOta.paused(this);
        super.onPause();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == NightOta.CONFIRM_REQUEST) NightOta.confirmationReturned(this, resultCode);
    }

    @Override
    protected void onStop() {
        foreground = false;
        if (sync != null) {
            sync.onForeground(false);
        }
        releaseSession("background");
        if (main != null && web != null) {
            main.postDelayed(webViewPause, WEBVIEW_PAUSE_DELAY_MS);
        }
        super.onStop();
    }


    private void handleBack(String reason) {
        if (web == null) {
            exitApp(reason);
            return;
        }
        web.evaluateJavascript("Boolean(window.NightCloseAppearance && window.NightCloseAppearance())",
                handled -> { if (!"true".equals(handled)) exitApp(reason); });
    }

    @Override
    public void onBackPressed() {
        handleBack("back");
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.getRepeatCount() == 0) handleBack("back-key");
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) {
            return;
        }
        String action = intent.getAction();
        if (OtaNotifications.OPEN.equals(action)) {
            openUpdates = true;
            // Consume the intent so restoring this Activity will not reopen the panel.
            intent.setAction(null);
            showRequestedUpdate();
        }
        if (ACTION_BACK.equals(action) || ACTION_BACK_GENERIC.equals(action)) {
            main.postDelayed(new Runnable() {
                @Override
                public void run() {
                    handleBack("intent-back");
                }
            }, 120L);
        }
    }

    @Override
    protected void onDestroy() {
        if (main != null) {
            main.removeCallbacksAndMessages(null);
        }
        releaseCapture();
        if (audio != null) {
            audio.exitCall();
        }
        if (sync != null) {
            sync.shutdown();
        }
        if (tickets != null) {
            tickets.shutdown();
        }
        if (web != null) {
            try {
                web.loadUrl("about:blank");
            } catch (Throwable ignored) {
            }
            try {
                web.removeJavascriptInterface("NightHost");
            } catch (Throwable ignored) {
            }
            try {
                web.clearHistory();
            } catch (Throwable ignored) {
            }
            try {
                web.destroy();
            } catch (Throwable ignored) {
            }
            web = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------- 小工具

    private static String stripTrailingSlash(String value) {
        if (value == null) {
            return null;
        }
        String v = value.trim();
        while (v.endsWith("/")) {
            v = v.substring(0, v.length() - 1);
        }
        return v;
    }

    private static String shorten(String value) {
        if (value == null) {
            return "null";
        }
        return value.length() <= 200 ? value : value.substring(0, 200) + "…";
    }
}
