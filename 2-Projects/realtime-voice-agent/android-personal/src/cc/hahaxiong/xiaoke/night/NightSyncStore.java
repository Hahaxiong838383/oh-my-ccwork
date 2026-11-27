package cc.hahaxiong.xiaoke.night;

import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

/**
 * 双向同步状态的原生持久化仓库。
 *
 * 持久化内容（仅技术同步状态，绝不存凭据明文、对话原话或音频）：
 * - cred_hash: 当前配对凭据的 SHA-256 指纹（用于切换账号/重配时清空旧状态）；
 * - device: 服务端绑定的设备标识；
 * - applied_rev: 已应用的服务端修订号（非负整数）；
 * - last_accent / accent_source: 最近确认或手选的主题色及来源（local / remote）；
 * - last_cmd_id / last_cmd_action / pending_ack / recent_cmds: 幂等命令记录与待回执 ack。
 */
final class NightSyncStore {

    static final String SOURCE_LOCAL = "local";
    static final String SOURCE_REMOTE = "remote";

    private static final String PREFS_NAME = "night_sync_v1";
    private static final String KEY_CRED_HASH = "cred_hash";
    private static final String KEY_DEVICE = "device";
    private static final String KEY_APPLIED_REV = "applied_rev";
    private static final String KEY_LAST_ACCENT = "last_accent";
    private static final String KEY_ACCENT_SOURCE = "accent_source";
    private static final String KEY_LAST_CMD_ID = "last_cmd_id";
    private static final String KEY_LAST_CMD_ACTION = "last_cmd_action";
    private static final String KEY_PENDING_ACK = "pending_ack";
    private static final String KEY_RECENT_CMDS = "recent_cmds";

    private static final int MAX_RECENT_COMMANDS = 16;
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    interface Backing {
        String getString(String key, String defValue);
        long getLong(String key, long defValue);
        void saveAll(Snapshot snapshot);
        void clearAll();
    }

    static final class Snapshot {
        final String credHash;
        final String device;
        final long appliedRevision;
        final String lastAccent;
        final String accentSource;
        final String lastCommandId;
        final String lastCommandAction;
        final String pendingAck;
        final String recentCommandsCsv;

        Snapshot(String credHash, String device, long appliedRevision,
                 String lastAccent, String accentSource,
                 String lastCommandId, String lastCommandAction,
                 String pendingAck, String recentCommandsCsv) {
            this.credHash = credHash;
            this.device = device;
            this.appliedRevision = appliedRevision;
            this.lastAccent = lastAccent;
            this.accentSource = accentSource;
            this.lastCommandId = lastCommandId;
            this.lastCommandAction = lastCommandAction;
            this.pendingAck = pendingAck;
            this.recentCommandsCsv = recentCommandsCsv;
        }
    }

    private static final class PrefsBacking implements Backing {
        private final SharedPreferences prefs;

        PrefsBacking(Context context) {
            Context app = context.getApplicationContext();
            if (app == null) {
                app = context;
            }
            this.prefs = app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        }

        @Override
        public String getString(String key, String defValue) {
            return prefs.getString(key, defValue);
        }

        @Override
        public long getLong(String key, long defValue) {
            return prefs.getLong(key, defValue);
        }

        @Override
        public void saveAll(Snapshot s) {
            prefs.edit()
                    .putString(KEY_CRED_HASH, s.credHash)
                    .putString(KEY_DEVICE, s.device)
                    .putLong(KEY_APPLIED_REV, s.appliedRevision)
                    .putString(KEY_LAST_ACCENT, s.lastAccent)
                    .putString(KEY_ACCENT_SOURCE, s.accentSource)
                    .putString(KEY_LAST_CMD_ID, s.lastCommandId)
                    .putString(KEY_LAST_CMD_ACTION, s.lastCommandAction)
                    .putString(KEY_PENDING_ACK, s.pendingAck)
                    .putString(KEY_RECENT_CMDS, s.recentCommandsCsv)
                    .commit();
        }

        @Override
        public void clearAll() {
            prefs.edit().clear().commit();
        }
    }

    private final Backing backing;
    private String credHash;
    private String device;
    private long appliedRevision;
    private String lastAccent;
    private String accentSource;
    private String lastCommandId;
    private String lastCommandAction;
    private String pendingAck;
    private final List<String> recentCommandIds = new ArrayList<String>();

    NightSyncStore(Context context) {
        this(new PrefsBacking(context));
    }

    NightSyncStore(Backing backing) {
        this.backing = backing;
        loadFromBacking();
    }

    private void loadFromBacking() {
        this.credHash = safeString(backing.getString(KEY_CRED_HASH, ""));
        String rawDevice = safeString(backing.getString(KEY_DEVICE, ""));
        this.device = NightSyncClient.isValidDevice(rawDevice) ? rawDevice : "";
        long rev = backing.getLong(KEY_APPLIED_REV, 0L);
        this.appliedRevision = rev >= 0L ? rev : 0L;
        String rawAccent = NightSyncClient.normalizeAccent(backing.getString(KEY_LAST_ACCENT, ""));
        this.lastAccent = rawAccent == null ? "" : rawAccent;
        String rawSource = safeString(backing.getString(KEY_ACCENT_SOURCE, ""));
        this.accentSource = (SOURCE_LOCAL.equals(rawSource) || SOURCE_REMOTE.equals(rawSource)) ? rawSource : "";
        String rawCmd = safeString(backing.getString(KEY_LAST_CMD_ID, ""));
        this.lastCommandId = NightSyncClient.isValidCommandId(rawCmd) ? rawCmd : "";
        String rawAction = safeString(backing.getString(KEY_LAST_CMD_ACTION, ""));
        this.lastCommandAction = NightSyncClient.isAllowedAction(rawAction) ? rawAction : "";
        String rawAck = safeString(backing.getString(KEY_PENDING_ACK, ""));
        this.pendingAck = NightSyncClient.isValidCommandId(rawAck) ? rawAck : "";

        recentCommandIds.clear();
        String csv = safeString(backing.getString(KEY_RECENT_CMDS, ""));
        if (!csv.isEmpty()) {
            String[] parts = csv.split(",");
            for (String part : parts) {
                if (NightSyncClient.isValidCommandId(part) && !recentCommandIds.contains(part)) {
                    recentCommandIds.add(part);
                }
            }
            while (recentCommandIds.size() > MAX_RECENT_COMMANDS) {
                recentCommandIds.remove(0);
            }
        }
        if (!this.lastCommandId.isEmpty() && !recentCommandIds.contains(this.lastCommandId)) {
            recentCommandIds.add(this.lastCommandId);
            while (recentCommandIds.size() > MAX_RECENT_COMMANDS) {
                recentCommandIds.remove(0);
            }
        }
    }

    /**
     * 校验当前凭据指纹：若与持久化记录不同，清空旧账号同步状态并绑定新指纹。
     * 返回 true 表示发生了账号切换或首次绑定。
     */
    synchronized boolean ensureCredential(String newCredHash) {
        String hash = safeString(newCredHash);
        if (hash.isEmpty()) {
            clear();
            return true;
        }
        if (hash.equals(this.credHash)) {
            return false;
        }
        resetFields();
        this.credHash = hash;
        persist();
        return true;
    }

    synchronized void clear() {
        resetFields();
        backing.clearAll();
    }

    synchronized boolean hasBoundCredential() {
        return !credHash.isEmpty();
    }

    synchronized String getCredentialHash() {
        return credHash;
    }

    synchronized String getDevice() {
        return device;
    }

    synchronized long getAppliedRevision() {
        return appliedRevision;
    }

    synchronized String getLastAccent() {
        return lastAccent;
    }

    synchronized String getAccentSource() {
        return accentSource;
    }

    synchronized String getLastCommandId() {
        return lastCommandId;
    }

    synchronized String getLastCommandAction() {
        return lastCommandAction;
    }

    synchronized String getPendingAck() {
        return pendingAck;
    }

    synchronized boolean wasCommandExecuted(String commandId) {
        if (!NightSyncClient.isValidCommandId(commandId)) {
            return false;
        }
        return commandId.equals(lastCommandId) || recentCommandIds.contains(commandId);
    }

    synchronized void saveLocalAccent(String hex) {
        String normalized = NightSyncClient.normalizeAccent(hex);
        if (normalized == null) {
            return;
        }
        this.lastAccent = normalized;
        this.accentSource = SOURCE_LOCAL;
        persist();
    }

    /**
     * 记录一次已验证响应的同步进度（设备绑定、修订号、颜色及来源）。
     */
    synchronized void saveSyncProgress(String responseDevice, long newAppliedRevision,
                                       String newAccent, String newAccentSource) {
        boolean changed = false;
        if (this.device.isEmpty() && NightSyncClient.isValidDevice(responseDevice)) {
            this.device = responseDevice;
            changed = true;
        }
        if (newAppliedRevision >= 0L && newAppliedRevision != this.appliedRevision) {
            this.appliedRevision = newAppliedRevision;
            changed = true;
        }
        if (newAccent != null) {
            String normalized = NightSyncClient.normalizeAccent(newAccent);
            if (normalized != null && (!normalized.equals(this.lastAccent)
                    || (newAccentSource != null && !newAccentSource.equals(this.accentSource)))) {
                this.lastAccent = normalized;
                if (SOURCE_LOCAL.equals(newAccentSource) || SOURCE_REMOTE.equals(newAccentSource)) {
                    this.accentSource = newAccentSource;
                }
                changed = true;
            }
        }
        if (changed) {
            persist();
        }
    }

    /**
     * 原子记录新执行的命令（在真正触发动作前落盘，防止进程中断后重复执行）。
     */
    synchronized void recordCommandExecuted(String commandId, String action) {
        if (!NightSyncClient.isValidCommandId(commandId) || !NightSyncClient.isAllowedAction(action)) {
            return;
        }
        this.lastCommandId = commandId;
        this.lastCommandAction = action;
        this.pendingAck = commandId;
        recentCommandIds.remove(commandId);
        recentCommandIds.add(commandId);
        while (recentCommandIds.size() > MAX_RECENT_COMMANDS) {
            recentCommandIds.remove(0);
        }
        persist();
    }

    synchronized void setPendingAck(String commandId) {
        String next = NightSyncClient.isValidCommandId(commandId) ? commandId : "";
        if (!next.equals(this.pendingAck)) {
            this.pendingAck = next;
            persist();
        }
    }

    synchronized void clearPendingAckIfMatches(String sentAck) {
        if (sentAck != null && !sentAck.isEmpty() && sentAck.equals(this.pendingAck)) {
            this.pendingAck = "";
            persist();
        }
    }

    static String sha256Hex(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            char[] out = new char[digest.length * 2];
            for (int i = 0; i < digest.length; i++) {
                int v = digest[i] & 0xFF;
                out[i * 2] = HEX[v >>> 4];
                out[i * 2 + 1] = HEX[v & 0x0F];
            }
            return new String(out);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private void resetFields() {
        this.credHash = "";
        this.device = "";
        this.appliedRevision = 0L;
        this.lastAccent = "";
        this.accentSource = "";
        this.lastCommandId = "";
        this.lastCommandAction = "";
        this.pendingAck = "";
        this.recentCommandIds.clear();
    }

    private void persist() {
        StringBuilder csv = new StringBuilder();
        for (int i = 0; i < recentCommandIds.size(); i++) {
            if (i > 0) {
                csv.append(',');
            }
            csv.append(recentCommandIds.get(i));
        }
        backing.saveAll(new Snapshot(
                credHash,
                device,
                appliedRevision,
                lastAccent,
                accentSource,
                lastCommandId,
                lastCommandAction,
                pendingAck,
                csv.toString()
        ));
    }

    private static String safeString(String s) {
        return s == null ? "" : s.trim();
    }
}
