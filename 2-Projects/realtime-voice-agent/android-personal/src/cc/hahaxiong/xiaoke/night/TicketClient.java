package cc.hahaxiong.xiaoke.night;

import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.HttpsURLConnection;

/**
 * 语音票据客户端：只允许固定宿主 https://pa.hahaxiong.cc:8666/api/voice/ticket。
 *
 * 硬约束：
 *  - 目标 URL 是编译期常量，JS 无法改目标；
 *  - 不跟随重定向（3xx 直接失败），避免被踢到别的宿主；
 *  - 连接/读取超时；响应体上限 64 KiB；
 *  - Bearer 凭据来自 SecureStore，只出现在请求头，不落日志、不回传 JS；
 *  - 返回给 JS 的只有该次通话的临时票据（url/token/room）。
 */
final class TicketClient {

    private static final String TAG = "NightTicket";
    static final String ENDPOINT = "https://pa.hahaxiong.cc:8666/api/voice/ticket";
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 12000;
    private static final int MAX_BODY_BYTES = 64 * 1024;

    interface Callback {
        void onSuccess(String requestId, String url, String token, String room);

        void onError(String requestId, String code);
    }

    private final ExecutorService executor;

    TicketClient() {
        this.executor = Executors.newSingleThreadExecutor(new ThreadFactory() {
            private final AtomicInteger seq = new AtomicInteger(1);

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "night-ticket-" + seq.getAndIncrement());
                t.setDaemon(true);
                return t;
            }
        });
    }

    void request(final String bearerKey, final String requestId, final Callback callback) {
        executor.execute(new Runnable() {
            @Override
            public void run() {
                perform(bearerKey, requestId, callback);
            }
        });
    }

    void shutdown() {
        executor.shutdownNow();
    }

    private void perform(String bearerKey, String requestId, Callback callback) {
        HttpsURLConnection connection = null;
        try {
            URL url = new URL(ENDPOINT);
            connection = (HttpsURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setDoOutput(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Origin", NightAssets.ORIGIN);
            connection.setRequestProperty("Authorization", "Bearer " + bearerKey);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Content-Length", "0");
            connection.setRequestProperty("Connection", "close");

            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                callback.onError(requestId, "redirect-refused");
                return;
            }
            if (status < 200 || status >= 300) {
                callback.onError(requestId, "http-" + status);
                return;
            }
            String body = readBody(connection.getInputStream());
            if (body == null) {
                callback.onError(requestId, "bad-response");
                return;
            }
            JSONObject json;
            try {
                json = new JSONObject(body);
            } catch (Throwable t) {
                callback.onError(requestId, "bad-json");
                return;
            }
            String room = json.optString("url", "");
            String token = json.optString("token", "");
            String roomName = json.optString("room", "");
            // 与 web/personal 的口径一致：必须是 wss:// 且带 token
            if (!room.startsWith("wss://") || token.isEmpty()) {
                callback.onError(requestId, "insecure-ticket");
                return;
            }
            callback.onSuccess(requestId, room, token, roomName);
        } catch (SocketTimeoutException e) {
            callback.onError(requestId, "timeout");
        } catch (Throwable t) {
            Log.w(TAG, "ticket request failed: " + t.getClass().getSimpleName());
            callback.onError(requestId, "network");
        } finally {
            if (connection != null) {
                try {
                    connection.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private static String readBody(InputStream in) {
        if (in == null) {
            return null;
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream(512);
            byte[] buf = new byte[4096];
            int total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_BODY_BYTES) {
                    return null;
                }
                out.write(buf, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Throwable t) {
            return null;
        } finally {
            try {
                in.close();
            } catch (Throwable ignored) {
            }
        }
    }
}
