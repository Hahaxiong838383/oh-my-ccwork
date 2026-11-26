package cc.hahaxiong.xiaoke.night;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * 严格白名单诊断事件模型。
 *
 * 硬约束：
 * - 只允许 13 个固定事件类型，不携带对话文本、录音密钥、IP 或任意扩展字段；
 * - 序列化与反序列化均严格限定为 4 个字段：{id, kind, ts, versionCode}；
 * - eventId 为随机 UUIDv4，在本地持久化与重试间保持不变以保证服务端幂等去重。
 */
final class NightDiagEvent {

    static final int SCHEMA_VERSION = 1;

    static final String KIND_CALL_START = "call_start";
    static final String KIND_CONNECTED = "connected";
    static final String KIND_MIC_ON = "mic_on";
    static final String KIND_MIC_OFF = "mic_off";
    static final String KIND_RX_AUDIO = "rx_audio";
    static final String KIND_RX_CAPTION = "rx_caption";
    static final String KIND_TX_CAPTION = "tx_caption";
    static final String KIND_SPOKEN_INTERRUPT = "spoken_interrupt";
    static final String KIND_CANCEL_ACK = "cancel_ack";
    static final String KIND_TRANSPORT_ERROR = "transport_error";
    static final String KIND_CALL_END = "call_end";
    static final String KIND_PAIRED = "paired";
    static final String KIND_OTA_CHECK = "ota_check";

    static final Set<String> ALLOWED_KINDS;

    static {
        LinkedHashSet<String> set = new LinkedHashSet<String>(16);
        set.add(KIND_CALL_START);
        set.add(KIND_CONNECTED);
        set.add(KIND_MIC_ON);
        set.add(KIND_MIC_OFF);
        set.add(KIND_RX_AUDIO);
        set.add(KIND_RX_CAPTION);
        set.add(KIND_TX_CAPTION);
        set.add(KIND_SPOKEN_INTERRUPT);
        set.add(KIND_CANCEL_ACK);
        set.add(KIND_TRANSPORT_ERROR);
        set.add(KIND_CALL_END);
        set.add(KIND_PAIRED);
        set.add(KIND_OTA_CHECK);
        ALLOWED_KINDS = Collections.unmodifiableSet(set);
    }

    private static final Pattern EVENT_ID_PATTERN = Pattern.compile("^[A-Za-z0-9._-]{8,64}$");

    final String id;
    final String kind;
    final long ts;
    final long versionCode;

    NightDiagEvent(String id, String kind, long ts, long versionCode) {
        if (!isValidId(id)) {
            throw new IllegalArgumentException("invalid event id");
        }
        if (!isAllowedKind(kind)) {
            throw new IllegalArgumentException("disallowed event kind");
        }
        if (ts <= 0L) {
            throw new IllegalArgumentException("invalid timestamp");
        }
        if (versionCode < 0L) {
            throw new IllegalArgumentException("invalid versionCode");
        }
        this.id = id;
        this.kind = kind;
        this.ts = ts;
        this.versionCode = versionCode;
    }

    static NightDiagEvent create(String kind, long ts, long versionCode) {
        if (!isAllowedKind(kind)) {
            return null;
        }
        long safeTs = ts > 0L ? ts : System.currentTimeMillis();
        long safeVersion = versionCode >= 0L ? versionCode : 0L;
        return new NightDiagEvent(UUID.randomUUID().toString(), kind, safeTs, safeVersion);
    }

    static boolean isAllowedKind(String kind) {
        return kind != null && ALLOWED_KINDS.contains(kind);
    }

    static boolean isValidId(String id) {
        return id != null && EVENT_ID_PATTERN.matcher(id).matches();
    }

    JSONObject toJson() throws JSONException {
        JSONObject obj = new JSONObject();
        obj.put("id", id);
        obj.put("kind", kind);
        obj.put("ts", ts);
        obj.put("versionCode", versionCode);
        return obj;
    }

    String toJsonLine() throws JSONException {
        return toJson().toString() + "\n";
    }

    /** 解析并严格校验单行 JSONL；损坏行或越界事件返回 null（不抛给上层）。 */
    static NightDiagEvent fromJsonLine(String line) {
        if (line == null) {
            return null;
        }
        String trimmed = line.trim();
        if (trimmed.isEmpty() || trimmed.charAt(0) != '{') {
            return null;
        }
        try {
            JSONObject obj = new JSONObject(trimmed);
            if (obj.length() != 4) {
                return null;
            }
            Object rawId = obj.opt("id");
            Object rawKind = obj.opt("kind");
            if (!(rawId instanceof String) || !(rawKind instanceof String)) {
                return null;
            }
            String id = (String) rawId;
            String kind = (String) rawKind;
            if (!isValidId(id) || !isAllowedKind(kind)) {
                return null;
            }
            long ts = obj.optLong("ts", -1L);
            long versionCode = obj.optLong("versionCode", -1L);
            if (ts <= 0L || versionCode < 0L) {
                return null;
            }
            return new NightDiagEvent(id, kind, ts, versionCode);
        } catch (Throwable ignored) {
            return null;
        }
    }
}
