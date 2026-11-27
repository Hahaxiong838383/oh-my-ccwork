package cc.hahaxiong.xiaoke.night;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;

/**
 * 固定 HTTPS POST 双向同步通道：https://pa.hahaxiong.cc:8666/mobile/night/sync 。
 *
 * 硬约束：
 * - 固定编译期 HTTPS 端点，严格校验 scheme/host/port/path，禁止重定向（3xx 直接拒绝）；
 * - 有限连接/读取超时与响应体大小上限（64 KiB）；
 * - Bearer 凭据仅在请求头临时使用，绝不缓存、不落盘、不写日志、不暴露给 JS；
 * - 请求体严格限定 {versionCode,phase,muted,accent,appliedRevision,ack}，绝不传原话或字幕；
 * - 响应严格校验 {device,revision,accent,command}，命令白名单仅放行 sync_logs / check_update。
 */
final class NightSyncClient {

    static final String EXPECTED_SCHEME = "https";
    static final String EXPECTED_HOST = "pa.hahaxiong.cc";
    static final int EXPECTED_PORT = 8666;
    static final String EXPECTED_PATH = "/mobile/night/sync";
    static final String ENDPOINT = "https://pa.hahaxiong.cc:8666/mobile/night/sync";

    static final long DEFAULT_VERSION_CODE = 1000011L;
    static final String DEFAULT_ACCENT = "#4F7DF3";
    static final String ACTION_SYNC_LOGS = "sync_logs";
    static final String ACTION_CHECK_UPDATE = "check_update";

    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 12000;
    private static final int MAX_RESPONSE_BYTES = 64 * 1024;
    private static final long MIN_RETRY_AFTER_MS = 10_000L;
    private static final long MAX_RETRY_AFTER_MS = 300_000L;
    private static final long DEFAULT_RETRY_AFTER_MS = 60_000L;

    private static final Set<String> ALLOWED_PHASES = Collections.unmodifiableSet(
            new HashSet<String>(Arrays.asList(
                    "idle",
                    "listening",
                    "speaking",
                    "thinking",
                    "searching",
                    "muted",
                    "connecting",
                    "error"
            ))
    );

    private static final Pattern HEX6 = Pattern.compile("^#[0-9a-fA-F]{6}$");
    private static final Pattern HEX3 = Pattern.compile("^#[0-9a-fA-F]{3}$");
    private static final Pattern DEVICE_PATTERN = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$");
    private static final Pattern COMMAND_ID_PATTERN = Pattern.compile("^[A-Za-z0-9._:-]{1,64}$");

    interface Transport {
        SyncResult send(String bearerKey, SyncRequest request);
        void abort();
    }

    static final class SyncRequest {
        final long versionCode;
        final String phase;
        final boolean muted;
        final String accent;
        final long appliedRevision;
        final String ack;

        SyncRequest(long versionCode, String phase, boolean muted, String accent,
                    long appliedRevision, String ack) {
            this.versionCode = (versionCode > 0L && versionCode <= 2_100_000_000L)
                    ? versionCode
                    : DEFAULT_VERSION_CODE;
            this.phase = normalizePhase(phase);
            this.muted = muted;
            String normAccent = normalizeAccent(accent);
            this.accent = normAccent == null ? DEFAULT_ACCENT : normAccent;
            this.appliedRevision = Math.max(0L, appliedRevision);
            this.ack = isValidCommandId(ack) ? ack : "";
        }
    }

    static final class SyncCommand {
        final String id;
        final String action;

        SyncCommand(String id, String action) {
            this.id = id;
            this.action = action;
        }
    }

    static final class SyncResponse {
        final String device;
        final long revision;
        final String accent; // null or "#RRGGBB"
        final SyncCommand command; // null or whitelisted command
        final boolean ignoredUnsupportedCommand;

        SyncResponse(String device, long revision, String accent,
                     SyncCommand command, boolean ignoredUnsupportedCommand) {
            this.device = device;
            this.revision = revision;
            this.accent = accent;
            this.command = command;
            this.ignoredUnsupportedCommand = ignoredUnsupportedCommand;
        }
    }

    static final class SyncResult {
        final boolean ok;
        final boolean retryable;
        final int httpStatus;
        final long retryAfterMs;
        final String errorCode;
        final SyncResponse response;

        private SyncResult(boolean ok, boolean retryable, int httpStatus, long retryAfterMs,
                           String errorCode, SyncResponse response) {
            this.ok = ok;
            this.retryable = retryable;
            this.httpStatus = httpStatus;
            this.retryAfterMs = retryAfterMs;
            this.errorCode = errorCode;
            this.response = response;
        }

        static SyncResult success(SyncResponse response) {
            return new SyncResult(true, false, 200, 0L, "ok", response);
        }

        static SyncResult fail(String errorCode, int httpStatus, boolean retryable, long retryAfterMs) {
            return new SyncResult(false, retryable, httpStatus, retryAfterMs, errorCode, null);
        }
    }

    static final class HttpsTransport implements Transport {

        private final AtomicReference<HttpsURLConnection> inflight =
                new AtomicReference<HttpsURLConnection>();

        @Override
        public SyncResult send(String bearerKey, SyncRequest request) {
            if (!SecureStore.isAcceptableKey(bearerKey)) {
                return SyncResult.fail("unpaired", 0, false, 0L);
            }
            if (request == null) {
                return SyncResult.fail("bad-request", 0, false, 0L);
            }

            final byte[] bodyBytes;
            try {
                bodyBytes = encodePayload(request);
            } catch (JSONException e) {
                return SyncResult.fail("bad-payload", 0, false, 0L);
            }

            HttpsURLConnection connection = null;
            try {
                URL url = new URL(ENDPOINT);
                if (!isAllowedEndpoint(url)) {
                    return SyncResult.fail("origin-refused", 0, false, 0L);
                }
                URLConnection rawConn = url.openConnection();
                if (!(rawConn instanceof HttpsURLConnection)) {
                    return SyncResult.fail("tls-required", 0, false, 0L);
                }
                connection = (HttpsURLConnection) rawConn;
                inflight.set(connection);

                connection.setRequestMethod("POST");
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setDoOutput(true);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setFixedLengthStreamingMode(bodyBytes.length);
                connection.setRequestProperty("Authorization", "Bearer " + bearerKey.trim());
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Connection", "close");

                OutputStream out = connection.getOutputStream();
                try {
                    out.write(bodyBytes);
                    out.flush();
                } finally {
                    try {
                        out.close();
                    } catch (IOException ignored) {
                    }
                }

                int status = connection.getResponseCode();
                if (!isAllowedEndpoint(connection.getURL())) {
                    return SyncResult.fail("origin-refused", status, false, 0L);
                }
                if (status >= 300 && status < 400) {
                    return SyncResult.fail("redirect-refused", status, false, 0L);
                }
                if (status == 401 || status == 403) {
                    return SyncResult.fail("http-" + status, status, false, 0L);
                }
                if (status == 429) {
                    long retryAfter = parseRetryAfterMs(connection.getHeaderField("Retry-After"));
                    return SyncResult.fail("http-429", status, true, retryAfter);
                }
                if (status == 400 || status == 404 || status == 405 || status == 413 || status == 415 || status == 422) {
                    return SyncResult.fail("http-" + status, status, false, 0L);
                }
                if (status < 200 || status >= 300) {
                    return SyncResult.fail("http-" + status, status, true, 0L);
                }

                String responseBody = readBodyBounded(connection.getInputStream(), MAX_RESPONSE_BYTES);
                if (responseBody == null) {
                    return SyncResult.fail("bad-response", status, true, 0L);
                }
                SyncResponse parsed = parseResponse(responseBody);
                if (parsed == null) {
                    return SyncResult.fail("bad-json", status, true, 0L);
                }
                return SyncResult.success(parsed);
            } catch (SocketTimeoutException timeout) {
                return SyncResult.fail("timeout", 0, true, 0L);
            } catch (IOException io) {
                return SyncResult.fail("network", 0, true, 0L);
            } catch (Throwable unexpected) {
                return SyncResult.fail("transport-fail", 0, true, 0L);
            } finally {
                inflight.compareAndSet(connection, null);
                if (connection != null) {
                    try {
                        connection.disconnect();
                    } catch (Throwable ignored) {
                    }
                }
            }
        }

        @Override
        public void abort() {
            HttpsURLConnection conn = inflight.getAndSet(null);
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private NightSyncClient() {
    }

    static boolean isAllowedEndpoint(URL url) {
        if (url == null) {
            return false;
        }
        return EXPECTED_SCHEME.equalsIgnoreCase(url.getProtocol())
                && EXPECTED_HOST.equalsIgnoreCase(url.getHost())
                && url.getPort() == EXPECTED_PORT
                && EXPECTED_PATH.equals(url.getPath())
                && url.getQuery() == null
                && url.getRef() == null
                && url.getUserInfo() == null;
    }

    static String normalizePhase(String raw) {
        if (raw == null) {
            return "idle";
        }
        String candidate = raw.trim().toLowerCase(Locale.ROOT);
        return ALLOWED_PHASES.contains(candidate) ? candidate : "idle";
    }

    static String normalizeAccent(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim();
        if (HEX6.matcher(s).matches()) {
            return s.toUpperCase(Locale.ROOT);
        }
        if (HEX3.matcher(s).matches()) {
            char r = s.charAt(1);
            char g = s.charAt(2);
            char b = s.charAt(3);
            return ("#" + r + r + g + g + b + b).toUpperCase(Locale.ROOT);
        }
        return null;
    }

    static boolean isValidDevice(String raw) {
        return raw != null && DEVICE_PATTERN.matcher(raw).matches();
    }

    static boolean isValidCommandId(String raw) {
        return raw != null && COMMAND_ID_PATTERN.matcher(raw).matches();
    }

    static boolean isAllowedAction(String raw) {
        return ACTION_SYNC_LOGS.equals(raw) || ACTION_CHECK_UPDATE.equals(raw);
    }

    static byte[] encodePayload(SyncRequest req) throws JSONException {
        JSONObject obj = new JSONObject();
        obj.put("versionCode", req.versionCode);
        obj.put("phase", req.phase);
        obj.put("muted", req.muted);
        obj.put("accent", req.accent);
        obj.put("appliedRevision", req.appliedRevision);
        obj.put("ack", req.ack);
        return obj.toString().getBytes(StandardCharsets.UTF_8);
    }

    static SyncResponse parseResponse(String responseBody) {
        if (responseBody == null || responseBody.trim().isEmpty()) {
            return null;
        }
        try {
            JSONObject json = new JSONObject(responseBody);

            Object devObj = json.opt("device");
            if (!(devObj instanceof String)) {
                return null;
            }
            String device = (String) devObj;
            if (!isValidDevice(device)) {
                return null;
            }

            Object revObj = json.opt("revision");
            if (!(revObj instanceof Integer) && !(revObj instanceof Long)) {
                return null;
            }
            long revision = ((Number) revObj).longValue();
            if (revision < 0L) {
                return null;
            }

            String accent = null;
            if (json.has("accent") && !json.isNull("accent")) {
                Object accentObj = json.opt("accent");
                if (!(accentObj instanceof String)) {
                    return null;
                }
                String rawAccent = ((String) accentObj).trim();
                if (!HEX6.matcher(rawAccent).matches()) {
                    return null;
                }
                accent = rawAccent.toUpperCase(Locale.ROOT);
            }

            SyncCommand command = null;
            boolean ignoredUnsupported = false;
            if (json.has("command") && !json.isNull("command")) {
                Object cmdObj = json.opt("command");
                if (!(cmdObj instanceof JSONObject)) {
                    return null;
                }
                JSONObject cmdJson = (JSONObject) cmdObj;
                Object idObj = cmdJson.opt("id");
                Object actionObj = cmdJson.opt("action");
                if (!(idObj instanceof String) || !(actionObj instanceof String)) {
                    return null;
                }
                String cmdId = (String) idObj;
                String action = (String) actionObj;
                if (!isValidCommandId(cmdId)) {
                    return null;
                }
                if (isAllowedAction(action)) {
                    command = new SyncCommand(cmdId, action);
                } else {
                    ignoredUnsupported = true;
                }
            }

            return new SyncResponse(device, revision, accent, command, ignoredUnsupported);
        } catch (Throwable ignored) {
            return null;
        }
    }

    static long parseRetryAfterMs(String headerValue) {
        if (headerValue == null) {
            return DEFAULT_RETRY_AFTER_MS;
        }
        try {
            long seconds = Long.parseLong(headerValue.trim());
            long ms = seconds * 1000L;
            if (ms < MIN_RETRY_AFTER_MS) {
                return MIN_RETRY_AFTER_MS;
            }
            if (ms > MAX_RETRY_AFTER_MS) {
                return MAX_RETRY_AFTER_MS;
            }
            return ms;
        } catch (NumberFormatException ignored) {
            return DEFAULT_RETRY_AFTER_MS;
        }
    }

    private static String readBodyBounded(InputStream in, int maxBytes) {
        if (in == null) {
            return null;
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream(256);
            byte[] buf = new byte[4096];
            int total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > maxBytes) {
                    return null;
                }
                out.write(buf, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Throwable ignored) {
            return null;
        } finally {
            try {
                in.close();
            } catch (Throwable ignored) {
            }
        }
    }
}
