package cc.hahaxiong.xiaoke.night;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * app 私有目录里的下载件与状态：流式落 partial → 复核 → 原子改名 → 原子写状态。
 * 目录取 noBackupFilesDir，排除符号链接与越界路径。
 */
final class OtaFiles {
    static final String DIR = "night-ota";
    static final String PARTIAL = "update.partial";
    static final String READY = "update.apk";
    static final String STATE = "state.txt";
    private static final String SCHEMA = "night-ota-state-1";
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private OtaFiles() {}

    static File dir(Context context) throws IOException {
        File base = context.getNoBackupFilesDir();
        if (base == null || Files.isSymbolicLink(base.toPath())) throw new IOException("storage refused");
        File directory = new File(base, DIR);
        if (Files.isSymbolicLink(directory.toPath())) throw new IOException("storage refused");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("storage unavailable");
        if (!directory.getCanonicalFile().toPath().startsWith(base.getCanonicalFile().toPath()))
            throw new IOException("storage refused");
        return directory;
    }

    static File partial(Context context) throws IOException {
        return file(context, PARTIAL);
    }

    static File ready(Context context) throws IOException {
        return file(context, READY);
    }

    static File stateFile(Context context) throws IOException {
        return file(context, STATE);
    }

    private static File file(Context context, String name) throws IOException {
        File directory = dir(context);
        File file = new File(directory, name);
        if (Files.isSymbolicLink(file.toPath())) throw new IOException("storage refused");
        if (!directory.getCanonicalFile().equals(file.getCanonicalFile().getParentFile()))
            throw new IOException("storage refused");
        return file;
    }

    static String sha256(File file) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[OtaContract.BUFFER];
            int size;
            while ((size = in.read(buffer)) >= 0) digest.update(buffer, 0, size);
        }
        return hex(digest.digest());
    }

    static String sha256(byte[] value) {
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private static String hex(byte[] raw) {
        char[] out = new char[raw.length * 2];
        for (int i = 0; i < raw.length; i++) {
            int value = raw[i] & 0xff;
            out[i * 2] = HEX[value >>> 4];
            out[i * 2 + 1] = HEX[value & 0xf];
        }
        return new String(out);
    }

    @SuppressWarnings("deprecation")
    static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    static long installedVersionCode(Context context) {
        try {
            return versionCode(context.getPackageManager().getPackageInfo(context.getPackageName(), 0));
        } catch (PackageManager.NameNotFoundException | RuntimeException ex) {
            return Long.MAX_VALUE;
        }
    }

    static String installedSigner(Context context) {
        try {
            PackageManager manager = context.getPackageManager();
            return signer(manager.getPackageInfo(context.getPackageName(), signatureFlags()));
        } catch (PackageManager.NameNotFoundException | RuntimeException ex) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private static int signatureFlags() {
        return PackageManager.GET_SIGNING_CERTIFICATES | PackageManager.GET_SIGNATURES;
    }

    /** 单一签名才返回证书 SHA-256；多签名或读不到时返回 null（一律拒绝更新）。 */
    @SuppressWarnings("deprecation")
    static String signer(PackageInfo info) {
        if (info == null) return null;
        Signature[] signs = null;
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            if (info.signingInfo.hasMultipleSigners()) return null;
            signs = info.signingInfo.getApkContentsSigners();
        } else if (info.signatures != null) {
            signs = info.signatures;
        }
        if (signs == null || signs.length != 1 || signs[0] == null) return null;
        return sha256(signs[0].toByteArray());
    }

    /** 安装前复核：包名、versionCode、签名、体积、摘要全部严格一致。返回 null 表示通过。 */
    static String identity(Context context, File apk, State state) {
        if (state == null) return "manifest";
        if (apk == null || !apk.isFile()) return "length";
        if (apk.length() != state.size) return "length";
        try {
            if (!state.sha256.equals(sha256(apk))) return "sha256";
        } catch (IOException ex) {
            return "length";
        }
        PackageManager manager = context.getPackageManager();
        try {
            PackageInfo installed = manager.getPackageInfo(context.getPackageName(), signatureFlags());
            PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), signatureFlags());
            if (installed == null || archive == null) return "package";
            if (!OtaContract.PACKAGE.equals(installed.packageName) || !OtaContract.PACKAGE.equals(archive.packageName))
                return "package";
            if (versionCode(archive) != state.versionCode) return "version";
            if (versionCode(archive) <= versionCode(installed)) return "already current";
            String installedSigner = signer(installed);
            String archiveSigner = signer(archive);
            if (installedSigner == null || !installedSigner.equals(archiveSigner)) return "signer";
            if (!installedSigner.equals(state.signer)) return "signer";
            return null;
        } catch (PackageManager.NameNotFoundException | RuntimeException ex) {
            return "package";
        }
    }

    /** 下载完成：先在 partial 上验身份，再原子改名，最后原子写状态。 */
    static void commitDownload(Context context, OtaManifest manifest) throws IOException {
        File directory = dir(context);
        File partial = new File(directory, PARTIAL);
        File target = new File(directory, READY);
        String signer = installedSigner(context);
        if (signer == null) throw new IOException("signer");
        PackageManager manager = context.getPackageManager();
        PackageInfo archive = manager.getPackageArchiveInfo(partial.getAbsolutePath(), signatureFlags());
        if (archive == null) throw new IOException("package");
        if (!OtaContract.PACKAGE.equals(archive.packageName)) throw new IOException("package");
        if (versionCode(archive) != manifest.versionCode) throw new IOException("version");
        String archiveSigner = signer(archive);
        if (archiveSigner == null || !signer.equals(archiveSigner)) throw new IOException("signer");
        State state = new State(manifest.versionCode, manifest.versionName, manifest.sha256,
                manifest.size, signer, manifest.url, true);
        moveAtomic(partial, target);
        try {
            storeState(context, state);
        } catch (IOException ex) {
            deleteQuietly(target);
            throw ex;
        }
    }

    /** 清掉已下载件与状态（服务器没有更高版本、或换了 offer）。 */
    static void clearDownload(Context context) {
        try {
            File directory = dir(context);
            deleteQuietly(new File(directory, PARTIAL));
            deleteQuietly(new File(directory, READY));
            deleteQuietly(new File(directory, STATE));
        } catch (IOException ignored) {
        }
    }

    static void moveAtomic(File from, File to) throws IOException {
        if (Files.isSymbolicLink(from.toPath()) || Files.isSymbolicLink(to.toPath())) throw new IOException("storage refused");
        try {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException ex) {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }

    static void deleteQuietly(File file) {
        if (file == null || !file.exists()) return;
        try {
            if (Files.isSymbolicLink(file.toPath())) return;
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        } catch (RuntimeException ignored) {
        }
    }

    static State loadState(Context context) {
        try {
            File file = stateFile(context);
            if (!file.isFile() || file.length() > OtaContract.MAX_STATE_BYTES) return null;
            byte[] raw = Files.readAllBytes(file.toPath());
            Map<String, String> lines = new LinkedHashMap<>();
            for (String line : new String(raw, StandardCharsets.UTF_8).split("\n")) {
                if (line.isEmpty()) continue;
                int split = line.indexOf('=');
                if (split <= 0) return null;
                if (lines.put(line.substring(0, split), line.substring(split + 1)) != null) return null;
            }
            if (!SCHEMA.equals(lines.get("schema"))) return null;
            long size = Long.parseLong(required(lines, "size"));
            if (size < 1L || size > OtaContract.MAX_APK_BYTES) return null;
            OtaManifest checked = OtaManifest.parse(json(lines, size));
            String signer = required(lines, "signer");
            if (!OtaManifest.lowerHex(signer)) return null;
            return new State(checked.versionCode, checked.versionName, checked.sha256, checked.size,
                    signer, checked.url, "1".equals(lines.get("verified")));
        } catch (IOException | RuntimeException ex) {
            return null;
        }
    }

    /** 复用 manifest 解析器校验状态里的 versionCode/versionName/sha256/url，避免第二套校验。 */
    private static String json(Map<String, String> lines, long size) {
        StringBuilder out = new StringBuilder();
        out.append("{\"packageName\":\"").append(OtaContract.PACKAGE).append("\",")
                .append("\"versionCode\":").append(required(lines, "versionCode")).append(',')
                .append("\"versionName\":\"").append(escape(required(lines, "versionName"))).append("\",")
                .append("\"sha256\":\"").append(required(lines, "sha256")).append("\",")
                .append("\"size\":").append(size).append(',')
                .append("\"url\":\"").append(required(lines, "url")).append("\"}");
        return out.toString();
    }

    private static String escape(String value) {
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else out.append(c);
        }
        return out.toString();
    }

    private static String required(Map<String, String> lines, String key) {
        String value = lines.get(key);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException(key);
        return value;
    }

    static void storeState(Context context, State state) throws IOException {
        File file = stateFile(context);
        String body = "schema=" + SCHEMA + '\n'
                + "versionCode=" + state.versionCode + '\n'
                + "versionName=" + state.versionName + '\n'
                + "size=" + state.size + '\n'
                + "sha256=" + state.sha256 + '\n'
                + "signer=" + state.signer + '\n'
                + "url=" + state.url + '\n'
                + "verified=" + (state.verified ? "1" : "0") + '\n';
        byte[] raw = body.getBytes(StandardCharsets.UTF_8);
        if (raw.length > OtaContract.MAX_STATE_BYTES) throw new IOException("state too large");
        File tmp = new File(file.getParentFile(), STATE + ".tmp");
        if (Files.isSymbolicLink(tmp.toPath())) throw new IOException("storage refused");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(raw);
            out.getFD().sync();
        }
        try {
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException ex) {
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /** 固定文案，绝不回显服务器文本。 */
    static String userNote(String reason) {
        String text = reason == null ? "" : reason;
        if (text.contains("cancelled") || text.contains("stopped")) return "这次检查被系统停掉了，下次前台再试";
        if (text.contains("redirect")) return "服务器要求跳转，已拒绝";
        if (text.contains("sha256")) return "安装包摘要不符，已拒绝";
        if (text.contains("range")) return "续传范围不符，已拒绝";
        if (text.contains("truncated") || text.contains("EOF")) return "下载中断，下次会续传";
        if (text.contains("storage")) return "手机空间不足或私有目录不可写，没有下载";
        if (text.contains("permission")) return "需要先在系统设置里允许本应用安装未知来源";
        if (text.contains("signer")) return "签名与当前应用不一致，已拒绝";
        if (text.contains("already current")) return "已是最新";
        if (text.contains("version") || text.contains("package") || text.contains("manifest") || text.contains("path"))
            return "版本信息或包名不符，已拒绝";
        if (text.contains("encoding") || text.contains("length") || text.contains("too large") || text.contains("range"))
            return "服务器响应不符合约定，已拒绝";
        if (text.contains("https")) return "更新源必须走 HTTPS，已拒绝";
        return "这次没有完成，没有安装";
    }

    static final class State {
        final long versionCode;
        final long size;
        final String versionName;
        final String sha256;
        final String signer;
        final String url;
        final boolean verified;

        State(long versionCode, String versionName, String sha256, long size, String signer, String url, boolean verified) {
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.sha256 = sha256;
            this.size = size;
            this.signer = signer;
            this.url = url;
            this.verified = verified;
        }

        boolean matches(OtaManifest manifest) {
            return manifest != null && versionCode == manifest.versionCode && size == manifest.size
                    && sha256.equals(manifest.sha256) && url.equals(manifest.url);
        }

        String label() {
            return versionName + " (" + versionCode + ")";
        }
    }
}
