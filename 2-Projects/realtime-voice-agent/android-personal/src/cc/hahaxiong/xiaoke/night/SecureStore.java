package cc.hahaxiong.xiaoke.night;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 设备配对凭据仓库。
 *
 * - 明文只存在于内存中的短暂字符串；落盘为 Android Keystore(AES-256-GCM) 加密后的 blob。
 * - 密钥不可导出（AndroidKeyStore，setUserAuthenticationRequired(false)，随机 IV）。
 * - 不向 JS 暴露任何 getter：桥接层只有 paired()/pair()/forget() 三个动作，
 *   票据请求在原生侧直接读凭据，明文永不进入 WebView 上下文。
 */
final class SecureStore {

    private static final String PREFS_NAME = "night_secure_v1";
    private static final String FIELD_BLOB = "paired_key_blob_v1";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "cc.hahaxiong.xiaoke.night.paired.v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int MIN_KEY_LEN = 16;
    private static final int MAX_KEY_LEN = 512;

    private final SharedPreferences prefs;

    SecureStore(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** 凭据可解、长度合规才算已配对。 */
    boolean isPaired() {
        String key = loadKey();
        if (key == null) {
            return false;
        }
        boolean ok = isAcceptableKey(key);
        // 明文不要在堆里久留（Java 字符串无法擦除，但可尽早丢弃引用）
        key = null;
        return ok;
    }

    /** 校验并加密保存。返回是否成功；失败不改变已有状态。 */
    boolean save(String key) {
        if (!isAcceptableKey(key)) {
            return false;
        }
        try {
            byte[] blob = encrypt(key.getBytes(StandardCharsets.UTF_8));
            if (blob == null) {
                return false;
            }
            return prefs.edit().putString(FIELD_BLOB, Base64.encodeToString(blob, Base64.NO_WRAP)).commit();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 只在本进程内、原生线程使用；绝不经过 JS。 */
    String loadKey() {
        String stored = prefs.getString(FIELD_BLOB, null);
        if (stored == null || stored.isEmpty()) {
            return null;
        }
        try {
            byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
            byte[] plain = decrypt(blob);
            if (plain == null) {
                return null;
            }
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
    }

    void clear() {
        prefs.edit().remove(FIELD_BLOB).commit();
    }

    static boolean isAcceptableKey(String key) {
        if (key == null) {
            return false;
        }
        String trimmed = key.trim();
        int len = trimmed.length();
        if (len < MIN_KEY_LEN || len > MAX_KEY_LEN) {
            return false;
        }
        for (int i = 0; i < len; i++) {
            char c = trimmed.charAt(i);
            // 可见 ASCII（0x21..0x7E）：Bearer 凭据不接受空白/控制字符/非 ASCII
            if (c < 0x21 || c > 0x7E) {
                return false;
            }
        }
        return true;
    }

    private byte[] encrypt(byte[] plain) {
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, ensureKey());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(plain);
            if (iv == null || iv.length == 0 || ct == null) {
                return null;
            }
            byte[] out = new byte[1 + iv.length + ct.length];
            out[0] = (byte) iv.length;
            System.arraycopy(iv, 0, out, 1, iv.length);
            System.arraycopy(ct, 0, out, 1 + iv.length, ct.length);
            return out;
        } catch (Throwable t) {
            return null;
        }
    }

    private byte[] decrypt(byte[] blob) {
        if (blob == null || blob.length < 2) {
            return null;
        }
        try {
            int ivLen = blob[0] & 0xFF;
            if (ivLen <= 0 || blob.length <= 1 + ivLen) {
                return null;
            }
            byte[] iv = new byte[ivLen];
            System.arraycopy(blob, 1, iv, 0, ivLen);
            byte[] ct = new byte[blob.length - 1 - ivLen];
            System.arraycopy(blob, 1 + ivLen, ct, 0, ct.length);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, ensureKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            return cipher.doFinal(ct);
        } catch (Throwable t) {
            return null;
        }
    }

    private SecretKey ensureKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build();
        generator.init(spec);
        return generator.generateKey();
    }
}
