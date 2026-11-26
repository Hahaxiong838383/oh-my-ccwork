package cc.hahaxiong.xiaoke.night;

import android.content.Context;
import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 本地资源服务：把 https://pa.hahaxiong.cc/<path> 映射到 APK 内 assets/<path>。
 *
 * 安全边界：
 *  - 只认 https + 固定 host，其它 scheme/host 一律 403（含 file://、http://、外部域名）；
 *  - 路径规范化为纯段列表，拒绝 ".."、""、反斜杠，避免穿越；
 *  - 扩展名白名单（只发静态前端资源，不发 .dex/.so 之类）；
 *  - 响应头 no-store + nosniff，不给 WebView 缓存到可预测路径。
 *
 * 说明：ws/wss 与 WebRTC 媒体不经 shouldInterceptRequest，属预期（LiveKit 信令/媒体走自己的网络栈）。
 */
final class NightAssets {

    static final String HOST = "pa.hahaxiong.cc";
    static final String ORIGIN = "https://" + HOST + ":8666";
    static final String LOCAL_PATH = "/night-app/";
    static final String START_URL = ORIGIN + LOCAL_PATH + "index.html";

    private static final Map<String, String> MIME;

    static {
        Map<String, String> m = new HashMap<String, String>();
        m.put("html", "text/html");
        m.put("htm", "text/html");
        m.put("js", "application/javascript");
        m.put("mjs", "application/javascript");
        m.put("css", "text/css");
        m.put("json", "application/json");
        m.put("map", "application/json");
        m.put("txt", "text/plain");
        m.put("svg", "image/svg+xml");
        m.put("png", "image/png");
        m.put("jpg", "image/jpeg");
        m.put("jpeg", "image/jpeg");
        m.put("webp", "image/webp");
        m.put("gif", "image/gif");
        m.put("ico", "image/x-icon");
        m.put("woff", "font/woff");
        m.put("woff2", "font/woff2");
        m.put("wasm", "application/wasm");
        m.put("mp3", "audio/mpeg");
        m.put("wav", "audio/wav");
        m.put("mp4", "video/mp4");
        MIME = Collections.unmodifiableMap(m);
    }

    private final AssetManager assets;

    NightAssets(Context context) {
        this.assets = context.getApplicationContext().getAssets();
    }

    /** 是否属于本源（本地 HTTPS origin）。 */
    static boolean isLocalHttp(String url) {
        if (url == null) {
            return false;
        }
        return url.startsWith(ORIGIN + LOCAL_PATH);
    }

    WebResourceResponse intercept(WebResourceRequest request) {
        if (request == null || request.getUrl() == null) {
            return forbidden();
        }
        Uri uri = request.getUrl();
        String scheme = uri.getScheme();
        if (scheme == null || !"https".equalsIgnoreCase(scheme)) {
            return forbidden();
        }
        String host = uri.getHost();
        if (host == null || !HOST.equalsIgnoreCase(host)) {
            return forbidden();
        }
        if (uri.getPort() != 8666) return forbidden();
        String path = uri.getPath();
        if (!"GET".equals(request.getMethod()) || path == null) return forbidden();
        if (path.startsWith(LOCAL_PATH)) return serve(path.substring(LOCAL_PATH.length()));
        // LiveKit checks its signaling endpoint over HTTPS when diagnosing a connection.
        if (("/rtc/validate".equals(path) || "/rtc/v1/validate".equals(path)) && !request.isForMainFrame()) return null;
        return forbidden();
    }

    private WebResourceResponse serve(String rawPath) {
        String assetPath = normalize(rawPath);
        if (assetPath == null) {
            return forbidden();
        }
        String mime = MIME.get(extension(assetPath));
        if (mime == null) {
            return forbidden();
        }
        InputStream in;
        try {
            in = assets.open(assetPath, AssetManager.ACCESS_STREAMING);
        } catch (IOException e) {
            return notFound();
        }
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", "no-store");
        headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' wss://pa.hahaxiong.cc:8666; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'");
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Referrer-Policy", "no-referrer");
        boolean textual = mime.startsWith("text/")
                || mime.endsWith("javascript")
                || mime.endsWith("json")
                || mime.endsWith("xml");
        return new WebResourceResponse(mime, textual ? "utf-8" : null, 200, "OK", headers, in);
    }

    private static String normalize(String rawPath) {
        if (rawPath == null) {
            return null;
        }
        if (rawPath.indexOf('\\') >= 0 || rawPath.indexOf('\u0000') >= 0) {
            return null;
        }
        String p = rawPath.startsWith("/") ? rawPath.substring(1) : rawPath;
        if (p.isEmpty()) {
            return "index.html";
        }
        StringBuilder sb = new StringBuilder(p.length());
        for (String part : p.split("/", -1)) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) {
                return null;
            }
            if (sb.length() > 0) {
                sb.append('/');
            }
            sb.append(part);
        }
        return sb.toString();
    }

    private static String extension(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0 || dot == path.length() - 1) {
            return "";
        }
        return path.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static WebResourceResponse forbidden() {
        return error(403, "Forbidden");
    }

    private static WebResourceResponse notFound() {
        return error(404, "Not Found");
    }

    private static WebResourceResponse error(int code, String reason) {
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", "no-store");
        headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' wss://pa.hahaxiong.cc:8666; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'");
        headers.put("Content-Type", "text/plain; charset=utf-8");
        byte[] body = ("blocked: " + code + "\n").getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse("text/plain", "utf-8", code, reason, headers,
                new ByteArrayInputStream(body));
    }
}
