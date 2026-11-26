package cc.hahaxiong.xiaoke.night;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import javax.net.ssl.HttpsURLConnection;

/**
 * 固定 TLS Origin 诊断回传通道。
 *
 * 硬约束：
 * - 目标固定为编译期常量 https://pa.hahaxiong.cc:8666/mobile/night/diagnostics；
 * - 强制 HTTPS、严格校验 scheme/host/port/path，禁止重定向（3xx 立即拒绝）；
 * - 仅接受调用方临时传入的 Authorization Bearer 凭据，绝不缓存、不写日志、不外泄；
 * - 请求体严格限定 {schema:1,events:[{id,kind,ts,versionCode}]}；
 * - 响应体严格校验 {acked:[id...]}，且只认可本批次实际发送过的 eventId。
 */
interface NightDiagTransport {

    UploadResult send(String bearerKey, List<NightDiagEvent> batch);

    void abort();

    final class UploadResult {
        final boolean ok;
        final boolean retryable;
        final String statusCode;
        final Set<String> ackedIds;

        private UploadResult(boolean ok, boolean retryable, String statusCode, Set<String> ackedIds) {
            this.ok = ok;
            this.retryable = retryable;
            this.statusCode = statusCode;
            this.ackedIds = ackedIds == null
                    ? Collections.<String>emptySet()
                    : Collections.unmodifiableSet(ackedIds);
        }

        static UploadResult acked(Set<String> ackedIds) {
            return new UploadResult(true, false, "ok", ackedIds);
        }

        static UploadResult fail(String statusCode, boolean retryable) {
            return new UploadResult(false, retryable, statusCode, Collections.<String>emptySet());
        }
    }

    final class HttpsTransport implements NightDiagTransport {

        static final String EXPECTED_SCHEME = "https";
        static final String EXPECTED_HOST = "pa.hahaxiong.cc";
        static final int EXPECTED_PORT = 8666;
        static final String EXPECTED_PATH = "/mobile/night/diagnostics";
        static final String ENDPOINT = "https://pa.hahaxiong.cc:8666/mobile/night/diagnostics";

        private static final int CONNECT_TIMEOUT_MS = 8000;
        private static final int READ_TIMEOUT_MS = 12000;
        private static final int MAX_RESPONSE_BYTES = 64 * 1024;

        private final AtomicReference<HttpsURLConnection> inflight = new AtomicReference<HttpsURLConnection>();

        @Override
        public UploadResult send(String bearerKey, List<NightDiagEvent> batch) {
            if (!SecureStore.isAcceptableKey(bearerKey)) {
                return UploadResult.fail("unpaired", false);
            }
            if (batch == null || batch.isEmpty()) {
                return UploadResult.acked(Collections.<String>emptySet());
            }

            final byte[] bodyBytes;
            final Set<String> sentIds = new LinkedHashSet<String>(batch.size());
            try {
                bodyBytes = encodePayload(batch, sentIds);
            } catch (JSONException e) {
                return UploadResult.fail("bad-payload", false);
            }
            if (sentIds.isEmpty()) {
                return UploadResult.acked(Collections.<String>emptySet());
            }

            HttpsURLConnection connection = null;
            try {
                URL url = new URL(ENDPOINT);
                if (!isAllowedEndpoint(url)) {
                    return UploadResult.fail("origin-refused", false);
                }
                java.net.URLConnection rawConn = url.openConnection();
                if (!(rawConn instanceof HttpsURLConnection)) {
                    return UploadResult.fail("tls-required", false);
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
                    return UploadResult.fail("origin-refused", false);
                }
                if (status >= 300 && status < 400) {
                    return UploadResult.fail("redirect-refused", false);
                }
                if (status == 401 || status == 403) {
                    return UploadResult.fail("http-" + status, false);
                }
                if (status == 400 || status == 413 || status == 422) {
                    return UploadResult.fail("http-" + status, false);
                }
                if (status < 200 || status >= 300) {
                    return UploadResult.fail("http-" + status, true);
                }

                String responseBody = readBodyBounded(connection.getInputStream(), MAX_RESPONSE_BYTES);
                if (responseBody == null) {
                    return UploadResult.fail("bad-response", true);
                }
                Set<String> acked = parseAckedIds(responseBody, sentIds);
                if (acked == null) {
                    return UploadResult.fail("bad-ack", true);
                }
                return UploadResult.acked(acked);
            } catch (SocketTimeoutException timeout) {
                return UploadResult.fail("timeout", true);
            } catch (IOException io) {
                return UploadResult.fail("network", true);
            } catch (Throwable unexpected) {
                return UploadResult.fail("transport-fail", true);
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

        static byte[] encodePayload(List<NightDiagEvent> batch, Set<String> outSentIds) throws JSONException {
            JSONArray events = new JSONArray();
            for (NightDiagEvent ev : batch) {
                if (ev == null || !NightDiagEvent.isAllowedKind(ev.kind) || !NightDiagEvent.isValidId(ev.id)) {
                    continue;
                }
                if (outSentIds.add(ev.id)) {
                    events.put(ev.toJson());
                }
            }
            JSONObject body = new JSONObject();
            body.put("schema", NightDiagEvent.SCHEMA_VERSION);
            body.put("events", events);
            return body.toString().getBytes(StandardCharsets.UTF_8);
        }

        /** 解析 {acked:[id...]}，仅保留属于 sentIds 且合法的 eventId；结构非法返回 null。 */
        static Set<String> parseAckedIds(String responseBody, Set<String> sentIds) {
            if (responseBody == null || responseBody.trim().isEmpty()) {
                return null;
            }
            try {
                JSONObject json = new JSONObject(responseBody);
                JSONArray ackedArr = json.optJSONArray("acked");
                if (ackedArr == null) {
                    return null;
                }
                Set<String> acked = new LinkedHashSet<String>(ackedArr.length());
                for (int i = 0; i < ackedArr.length(); i++) {
                    Object item = ackedArr.opt(i);
                    if (item instanceof String) {
                        String id = (String) item;
                        if (NightDiagEvent.isValidId(id) && sentIds.contains(id)) {
                            acked.add(id);
                        }
                    }
                }
                return acked;
            } catch (Throwable ignored) {
                return null;
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
}
