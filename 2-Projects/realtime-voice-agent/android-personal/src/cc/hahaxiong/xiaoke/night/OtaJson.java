package cc.hahaxiong.xiaoke.night;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 极简严格 JSON 对象读取器：只允许一层对象，值是字符串 / 整数 / 布尔 / null。
 * 拒绝数组、嵌套对象、浮点、指数、重复键、尾随内容，避免宽松解析被拿来绕过校验。
 */
final class OtaJson {
    private static final int MAX_CHARS = OtaContract.MAX_MANIFEST_BYTES;

    private final String text;
    private int at;

    private OtaJson(String text) {
        this.text = text;
    }

    static Map<String, Object> object(String json) {
        if (json == null || json.isEmpty() || json.length() > MAX_CHARS) throw new IllegalArgumentException("json");
        OtaJson reader = new OtaJson(json);
        reader.space();
        reader.expect('{');
        Map<String, Object> body = new LinkedHashMap<>();
        reader.space();
        if (reader.peek() == '}') {
            reader.at++;
        } else {
            while (true) {
                reader.space();
                String key = reader.string();
                if (body.containsKey(key)) throw new IllegalArgumentException("duplicate");
                reader.space();
                reader.expect(':');
                reader.space();
                body.put(key, reader.value());
                reader.space();
                char separator = reader.next();
                if (separator == '}') break;
                if (separator != ',') throw new IllegalArgumentException("json");
            }
        }
        reader.space();
        if (reader.at != json.length()) throw new IllegalArgumentException("trailing");
        return body;
    }

    private Object value() {
        char c = peek();
        if (c == '"') return string();
        if (c == '-' || (c >= '0' && c <= '9')) return number();
        if (text.startsWith("true", at)) {
            at += 4;
            return Boolean.TRUE;
        }
        if (text.startsWith("false", at)) {
            at += 5;
            return Boolean.FALSE;
        }
        if (text.startsWith("null", at)) {
            at += 4;
            return null;
        }
        throw new IllegalArgumentException("value");
    }

    /** 只接受十进制整数；前导零、小数、指数一律拒绝。 */
    private Long number() {
        int start = at;
        if (peek() == '-') at++;
        int digits = at;
        while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') at++;
        if (at == digits) throw new IllegalArgumentException("number");
        if (at - start > 19) throw new IllegalArgumentException("number");
        if (text.charAt(digits) == '0' && at - digits > 1) throw new IllegalArgumentException("number");
        try {
            return Long.parseLong(text.substring(start, at));
        } catch (NumberFormatException ex) {
            throw new IllegalArgumentException("number");
        }
    }

    private String string() {
        expect('"');
        StringBuilder out = new StringBuilder();
        while (true) {
            char c = next();
            if (c == '"') return out.toString();
            if (c < 0x20) throw new IllegalArgumentException("string");
            if (c != '\\') {
                out.append(c);
                continue;
            }
            char escape = next();
            switch (escape) {
                case '"': out.append('"'); break;
                case '\\': out.append('\\'); break;
                case '/': out.append('/'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'u': out.append(unicode()); break;
                default: throw new IllegalArgumentException("string");
            }
            if (out.length() > MAX_CHARS) throw new IllegalArgumentException("string");
        }
    }

    private char unicode() {
        if (at + 4 > text.length()) throw new IllegalArgumentException("string");
        int value = 0;
        for (int i = 0; i < 4; i++) {
            int digit = Character.digit(text.charAt(at + i), 16);
            if (digit < 0) throw new IllegalArgumentException("string");
            value = value * 16 + digit;
        }
        at += 4;
        return (char) value;
    }

    private void space() {
        while (at < text.length()) {
            char c = text.charAt(at);
            if (c != ' ' && c != '\t' && c != '\n' && c != '\r') return;
            at++;
        }
    }

    private char peek() {
        if (at >= text.length()) throw new IllegalArgumentException("json");
        return text.charAt(at);
    }

    private char next() {
        char c = peek();
        at++;
        return c;
    }

    private void expect(char want) {
        if (next() != want) throw new IllegalArgumentException("json");
    }
}
