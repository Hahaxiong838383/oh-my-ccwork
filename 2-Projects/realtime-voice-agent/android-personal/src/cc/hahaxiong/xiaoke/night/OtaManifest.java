package cc.hahaxiong.xiaoke.night;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.Map;

/**
 * 协议 manifest：{packageName,versionCode,versionName,sha256,size,url}。
 * 每个字段都必须与固定契约严格一致，url 必须落在同源 /mobile/night/ 下。
 */
final class OtaManifest {
    final long versionCode;
    final long size;
    final String versionName;
    final String sha256;
    final String url;

    private OtaManifest(long versionCode, String versionName, String sha256, long size, String url) {
        this.versionCode = versionCode;
        this.versionName = versionName;
        this.sha256 = sha256;
        this.size = size;
        this.url = url;
    }

    String label() {
        return versionName + " (" + versionCode + ")";
    }

    static OtaManifest parse(String json) {
        Map<String, Object> body = OtaJson.object(json);
        if (!OtaContract.PACKAGE.equals(body.get("packageName"))) throw new IllegalArgumentException("packageName");
        long versionCode = positive(body.get("versionCode"), "versionCode");
        long size = positive(body.get("size"), "size");
        if (size > OtaContract.MAX_APK_BYTES) throw new IllegalArgumentException("size");
        return new OtaManifest(versionCode, versionName(body.get("versionName")),
                sha256(body.get("sha256")), size, url(body.get("url")));
    }

    private static long positive(Object value, String key) {
        if (!(value instanceof Long)) throw new IllegalArgumentException(key);
        long number = (Long) value;
        if (number < 1L || number > Integer.MAX_VALUE) throw new IllegalArgumentException(key);
        return number;
    }

    private static String versionName(Object value) {
        if (!(value instanceof String)) throw new IllegalArgumentException("versionName");
        String text = (String) value;
        if (text.isEmpty() || text.length() > OtaContract.MAX_VERSION_NAME) throw new IllegalArgumentException("versionName");
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < 0x20 || c == 0x7f) throw new IllegalArgumentException("versionName");
        }
        return text;
    }

    private static String sha256(Object value) {
        if (!(value instanceof String) || !lowerHex((String) value)) throw new IllegalArgumentException("sha256");
        return (String) value;
    }

    /** 绝对 https URL，主机、端口、目录、文件名全部锁死；不接受 userinfo、query、fragment、反斜杠。 */
    static String url(Object value) {
        if (!(value instanceof String)) throw new IllegalArgumentException("url");
        String text = (String) value;
        if (text.isEmpty() || text.length() > OtaContract.MAX_URL) throw new IllegalArgumentException("url");
        if (text.indexOf('\\') >= 0 || text.indexOf('@') >= 0 || text.indexOf('?') >= 0 || text.indexOf('#') >= 0)
            throw new IllegalArgumentException("url");
        URL parsed;
        try {
            parsed = new URL(text);
        } catch (MalformedURLException ex) {
            throw new IllegalArgumentException("url");
        }
        if (!"https".equals(parsed.getProtocol())) throw new IllegalArgumentException("url");
        if (!OtaContract.HOST.equals(parsed.getHost())) throw new IllegalArgumentException("url");
        if (parsed.getPort() != OtaContract.PORT) throw new IllegalArgumentException("url");
        if (parsed.getUserInfo() != null) throw new IllegalArgumentException("url");
        String rebuilt = parsed.getProtocol() + "://" + parsed.getHost() + ":" + parsed.getPort();
        if (!OtaContract.ORIGIN.equals(rebuilt)) throw new IllegalArgumentException("url");
        String path = parsed.getPath();
        if (path == null || !path.matches(OtaContract.APK_PATH_REGEX)) throw new IllegalArgumentException("url");
        if (!path.equals(text.substring(OtaContract.ORIGIN.length()))) throw new IllegalArgumentException("url");
        return text;
    }

    static boolean lowerHex(String value) {
        if (value == null || value.length() != 64) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) return false;
        }
        return true;
    }
}
