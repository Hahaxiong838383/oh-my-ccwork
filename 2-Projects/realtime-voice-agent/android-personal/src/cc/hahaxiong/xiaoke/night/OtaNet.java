package cc.hahaxiong.xiaoke.night;

import java.io.EOFException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.URL;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

/**
 * 固定源 HTTPS 传输：禁重定向、禁压缩、限长读取、流式落盘（永不整包进内存）。
 * 下载支持 Range 续传；最终完整性由 sha256 + size 在调用方复核。
 */
final class OtaNet {
    /** 明确拒绝（策略/协议不符），重试没有意义。 */
    static final class Refused extends IOException {
        private static final long serialVersionUID = 1L;

        Refused(String reason) {
            super(reason);
        }
    }

    interface Progress {
        void written(long totalBytes);
    }

    /** 一次检查/下载的取消把手：JobService 停止时断开连接。 */
    static final class Cancel {
        private volatile boolean stopped;
        private volatile HttpsURLConnection link;

        void reset() {
            stopped = false;
            link = null;
        }

        void stop() {
            stopped = true;
            HttpsURLConnection current = link;
            if (current != null) {
                try {
                    current.disconnect();
                } catch (RuntimeException ignored) {
                }
            }
        }

        boolean stopped() {
            return stopped;
        }
    }

    private OtaNet() {}

    static OtaManifest manifest(Cancel cancel) throws IOException {
        IOException failure = null;
        for (int attempt = 1; attempt <= OtaContract.ATTEMPTS; attempt++) {
            if (cancel.stopped()) throw new InterruptedIOException("stopped");
            Response response = null;
            try {
                response = open(OtaContract.MANIFEST_URL, 0L, null, true, cancel);
                if (response.code != 200) throw new Refused("manifest response " + response.code);
                return OtaManifest.parse(read(response.stream));
            } catch (IllegalArgumentException ex) {
                throw new Refused("manifest");
            } catch (IOException ex) {
                failure = ex;
                if (ex instanceof Refused || cancel.stopped() || attempt == OtaContract.ATTEMPTS) throw ex;
                pause(attempt);
            } finally {
                if (response != null) response.close(cancel);
            }
        }
        throw failure == null ? new IOException("manifest") : failure;
    }

    static void download(OtaManifest manifest, File partial, Cancel cancel, Progress progress) throws IOException {
        if (manifest == null) throw new Refused("manifest");
        if (partial == null) throw new Refused("path");
        File directory = partial.getParentFile();
        if (directory == null || !directory.isDirectory()) throw new IOException("storage unavailable");
        long size = manifest.size;
        IOException failure = null;
        for (int attempt = 1; attempt <= OtaContract.ATTEMPTS; attempt++) {
            if (cancel.stopped()) throw new InterruptedIOException("stopped");
            long have = partial.isFile() ? partial.length() : 0L;
            if (have > size) {
                OtaFiles.deleteQuietly(partial);
                have = 0L;
            }
            if (have == size) return;
            if (directory.getUsableSpace() < size - have + OtaContract.HEADROOM_BYTES) throw new IOException("storage full");
            Response response = null;
            try {
                response = open(manifest.url, have, manifest.sha256, false, cancel);
                boolean append;
                long expected;
                if (response.code == 206) {
                    ContentRange range = ContentRange.parse(response.contentRange);
                    if (range.start != have || range.end != size - 1 || range.total != size) throw new Refused("range mismatch");
                    expected = size - have;
                    append = true;
                } else if (response.code == 200) {
                    if (response.length >= 0L && response.length != size) throw new Refused("length mismatch");
                    expected = size;
                    append = false;
                } else {
                    throw new Refused("download response " + response.code);
                }
                if (response.encoding != null && !"identity".equalsIgnoreCase(response.encoding)) throw new Refused("encoding refused");
                long base = append ? have : 0L;
                try (FileOutputStream out = new FileOutputStream(partial, append)) {
                    copy(response.stream, out, expected, base, cancel, progress);
                    out.getFD().sync();
                }
                return;
            } catch (IOException ex) {
                failure = ex;
                if (ex instanceof Refused || cancel.stopped() || attempt == OtaContract.ATTEMPTS) throw ex;
                pause(attempt);
            } finally {
                if (response != null) response.close(cancel);
            }
        }
        throw failure == null ? new IOException("download") : failure;
    }

    private static Response open(String url, long from, String ifRange, boolean manifest, Cancel cancel) throws IOException {
        URL requested = new URL(url);
        URLConnection opened = requested.openConnection();
        if (!(opened instanceof HttpsURLConnection)) throw new Refused("https required");
        HttpsURLConnection connection = (HttpsURLConnection) opened;
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(OtaContract.CONNECT_MS);
            connection.setReadTimeout(OtaContract.READ_MS);
            connection.setUseCaches(false);
            connection.setAllowUserInteraction(false);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", manifest ? "application/json" : "application/vnd.android.package-archive");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setHostnameVerifier(HttpsURLConnection.getDefaultHostnameVerifier());
            if (from > 0L) {
                if (ifRange == null || !OtaManifest.lowerHex(ifRange)) throw new Refused("range mismatch");
                connection.setRequestProperty("Range", "bytes=" + from + "-");
                connection.setRequestProperty("If-Range", "\"" + ifRange + "\"");
            }
            cancel.link = connection;
            int code = connection.getResponseCode();
            if (code >= 300 && code < 400) throw new Refused("redirect refused");
            if (!requested.equals(connection.getURL())) throw new Refused("redirect refused");
            InputStream stream = code == 200 || code == 206 ? connection.getInputStream() : null;
            return new Response(code, connection.getContentLengthLong(), connection.getHeaderField("Content-Range"),
                    connection.getContentEncoding(), stream, connection);
        } catch (IOException | RuntimeException ex) {
            disconnect(connection);
            throw ex;
        }
    }

    private static void copy(InputStream in, FileOutputStream out, long expected, long base,
                             Cancel cancel, Progress progress) throws IOException {
        byte[] buffer = new byte[OtaContract.BUFFER];
        long got = 0L;
        while (got < expected) {
            if (cancel.stopped()) throw new InterruptedIOException("stopped");
            int read = in.read(buffer, 0, (int) Math.min(buffer.length, expected - got));
            if (read < 0) throw new EOFException("truncated");
            out.write(buffer, 0, read);
            got += read;
            if (progress != null) progress.written(base + got);
        }
        if (in.read() >= 0) throw new Refused("response too large");
    }

    private static String read(InputStream in) throws IOException {
        byte[] buffer = new byte[4096];
        byte[] out = new byte[OtaContract.MAX_MANIFEST_BYTES];
        int total = 0;
        int size;
        while ((size = in.read(buffer)) >= 0) {
            if (total + size > out.length) throw new Refused("response too large");
            System.arraycopy(buffer, 0, out, total, size);
            total += size;
        }
        return new String(out, 0, total, StandardCharsets.UTF_8);
    }

    private static void pause(int attempt) throws IOException {
        try {
            Thread.sleep(400L * attempt);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new InterruptedIOException("stopped");
        }
    }

    private static void disconnect(HttpsURLConnection connection) {
        try {
            connection.disconnect();
        } catch (RuntimeException ignored) {
        }
    }

    /** bytes start-end/total，只接受严格十进制。 */
    static final class ContentRange {
        final long start;
        final long end;
        final long total;

        private ContentRange(long start, long end, long total) {
            this.start = start;
            this.end = end;
            this.total = total;
        }

        static ContentRange parse(String header) throws IOException {
            if (header == null || header.length() < 12 || !header.regionMatches(true, 0, "bytes ", 0, 6))
                throw new Refused("range mismatch");
            String rest = header.substring(6);
            int dash = rest.indexOf('-');
            int slash = rest.indexOf('/');
            if (dash <= 0 || slash <= dash + 1 || slash != rest.lastIndexOf('/') || slash == rest.length() - 1)
                throw new Refused("range mismatch");
            long start = decimal(rest.substring(0, dash));
            long end = decimal(rest.substring(dash + 1, slash));
            long total = decimal(rest.substring(slash + 1));
            if (end < start || total <= end) throw new Refused("range mismatch");
            return new ContentRange(start, end, total);
        }

        private static long decimal(String text) throws IOException {
            if (text.isEmpty() || (text.length() > 1 && text.charAt(0) == '0')) throw new Refused("range mismatch");
            long value = 0L;
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (c < '0' || c > '9') throw new Refused("range mismatch");
                try {
                    value = Math.addExact(Math.multiplyExact(value, 10L), c - '0');
                } catch (ArithmeticException ex) {
                    throw new Refused("range mismatch");
                }
            }
            return value;
        }
    }

    private static final class Response {
        final int code;
        final long length;
        final String contentRange;
        final String encoding;
        final InputStream stream;
        final HttpsURLConnection connection;

        Response(int code, long length, String contentRange, String encoding, InputStream stream, HttpsURLConnection connection) {
            this.code = code;
            this.length = length;
            this.contentRange = contentRange;
            this.encoding = encoding;
            this.stream = stream;
            this.connection = connection;
        }

        void close(Cancel cancel) {
            if (stream != null) {
                try {
                    stream.close();
                } catch (IOException ignored) {
                }
            }
            if (code >= 400) {
                try {
                    InputStream error = connection.getErrorStream();
                    if (error != null) error.close();
                } catch (IOException | RuntimeException ignored) {
                }
            }
            if (cancel.link == connection) cancel.link = null;
            disconnect(connection);
        }
    }
}
