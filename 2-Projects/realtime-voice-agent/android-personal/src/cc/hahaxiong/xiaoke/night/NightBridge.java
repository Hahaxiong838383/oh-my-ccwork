package cc.hahaxiong.xiaoke.night;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.regex.Pattern;

/**
 * window.NightHost 的实现（addJavascriptInterface 暴露给页面）。
 *
 * 契约：
 *   paired(): boolean
 *   pair(key): boolean
 *   forget(): void
 *   ticket(requestId): void            -> window.Voice.onTicket(requestId, {url,token,room} | {error})
 *   setCall(active: boolean): void
 *   micPermission(requestId): void     -> window.Voice.onPermission(requestId, granted:boolean)
 *
 * 约束：
 *   - 只有本地 origin（https://appassets.androidplatform.net）的页面能调；
 *   - requestId 必须匹配 [A-Za-z0-9._-]{1,64}，否则直接丢弃（不回显，避免 JS 注入）；
 *   - 凭据没有任何 getter；票据只在原生侧取，明文不进入 WebView 上下文；
 *   - 所有 WebView/UI 操作都切回主线程。
 */
public final class NightBridge {

    private static final String TAG = "NightBridge";
    private static final Pattern REQUEST_ID = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    private final NightHostActivity host;
    private final WebView web;
    private final SecureStore store;
    private final TicketClient tickets;
    private final Handler main = new Handler(Looper.getMainLooper());

    NightBridge(NightHostActivity host, WebView web, SecureStore store, TicketClient tickets) {
        this.host = host;
        this.web = web;
        this.store = store;
        this.tickets = tickets;
    }

    @JavascriptInterface public void event(String kind) {
        if (host.pageTrusted()) NightDiagnostics.event(host, kind);
    }
    @JavascriptInterface public String diagnostics() {
        return host.pageTrusted() ? NightDiagnostics.summaryText(host) : "";
    }
    @JavascriptInterface public void syncDiagnostics() {
        if (host.pageTrusted()) NightDiagnostics.flush(host);
    }
    @JavascriptInterface public String updateSnapshot() {
        return host.pageTrusted() ? NightOta.snapshot(host).toString() : "{}";
    }
    @JavascriptInterface public String updateStatus() {
        return host.pageTrusted() ? NightOta.status(host) : "";
    }
    @JavascriptInterface public void checkUpdate() {
        if (host.pageTrusted()) main.post(() -> {
            NightDiagnostics.event(host, "ota_check");
            NightOta.check(host);
        });
    }
    @JavascriptInterface public void installUpdate() {
        if (host.pageTrusted()) main.post(() -> {
            if (!host.isInVoiceCall()) NightOta.install(host);
        });
    }

    // ---------------------------------------------------------------- pairing

    @JavascriptInterface
    public boolean paired() {
        if (!host.pageTrusted()) {
            return false;
        }
        return store.isPaired();
    }

    @JavascriptInterface
    public boolean pair(String key) {
        if (!host.pageTrusted()) {
            return false;
        }
        boolean ok = store.save(key);
        if (ok) {
            Log.i(TAG, "pairing stored");
        }
        return ok;
    }

    @JavascriptInterface
    public void forget() {
        if (!host.pageTrusted()) {
            return;
        }
        store.clear();
        Log.i(TAG, "pairing cleared");
    }

    // ----------------------------------------------------------------- ticket

    @JavascriptInterface
    public void ticket(final String requestId) {
        if (!host.pageTrusted()) {
            return;
        }
        if (!isValidRequestId(requestId)) {
            Log.w(TAG, "ticket: rejected requestId");
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                if (!store.isPaired()) {
                    deliverTicketError(requestId, "not-paired");
                    return;
                }
                final String bearer = store.loadKey();
                if (bearer == null) {
                    deliverTicketError(requestId, "keystore-unavailable");
                    return;
                }
                tickets.request(bearer, requestId, new TicketClient.Callback() {
                    @Override
                    public void onSuccess(final String rid, final String url, final String token, final String room) {
                        main.post(new Runnable() {
                            @Override
                            public void run() {
                                JSONObject payload = new JSONObject();
                                try {
                                    payload.put("url", url);
                                    payload.put("token", token);
                                    payload.put("room", room == null ? "" : room);
                                } catch (Throwable t) {
                                    deliverTicketError(rid, "internal");
                                    return;
                                }
                                evalVoice("onTicket", quote(rid) + "," + payload.toString());
                            }
                        });
                    }

                    @Override
                    public void onError(final String rid, final String code) {
                        main.post(new Runnable() {
                            @Override
                            public void run() {
                                deliverTicketError(rid, code);
                            }
                        });
                    }
                });
            }
        });
    }

    // ------------------------------------------------------------------- call

    @JavascriptInterface
    public void setCall(final boolean active) {
        if (!host.pageTrusted()) {
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                host.applyCallState(active);
            }
        });
    }

    // ------------------------------------------------------------- mic prompt

    @JavascriptInterface
    public void micPermission(final String requestId) {
        if (!host.pageTrusted()) {
            return;
        }
        if (!isValidRequestId(requestId)) {
            Log.w(TAG, "micPermission: rejected requestId");
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                host.requestMicPermission(requestId);
            }
        });
    }

    // ----------------------------------------------------------- host -> page

    void deliverPermission(final String requestId, final boolean granted) {
        if (!isValidRequestId(requestId)) {
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                evalVoice("onPermission", quote(requestId) + (granted ? ",true" : ",false"));
            }
        });
    }

    /** 原生侧要求页面停止：window.Voice.stop()。 */
    void notifyStop() {
        main.post(new Runnable() {
            @Override
            public void run() {
                evalVoice("stop", "");
            }
        });
    }

    private void deliverTicketError(String requestId, String code) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("error", code);
        } catch (Throwable ignored) {
            return;
        }
        evalVoice("onTicket", quote(requestId) + "," + payload.toString());
    }

    // ---------------------------------------------------------------- helpers

    private static boolean isValidRequestId(String requestId) {
        return requestId != null && REQUEST_ID.matcher(requestId).matches();
    }

    private static String quote(String value) {
        return JSONObject.quote(value);
    }

    /** 只允许固定的 window.Voice 方法名，参数由调用方自行拼装成合法 JS 字面量。 */
    private void evalVoice(String method, String args) {
        if (web == null) {
            return;
        }
        StringBuilder js = new StringBuilder(128);
        js.append("(function(){try{var v=window.Voice;if(v&&typeof v.")
                .append(method)
                .append("==='function'){v.")
                .append(method)
                .append('(')
                .append(args)
                .append(");}}catch(e){}})();");
        try {
            web.evaluateJavascript(js.toString(), null);
        } catch (Throwable t) {
            Log.w(TAG, "evaluateJavascript failed: " + t.getClass().getSimpleName());
        }
    }
}
