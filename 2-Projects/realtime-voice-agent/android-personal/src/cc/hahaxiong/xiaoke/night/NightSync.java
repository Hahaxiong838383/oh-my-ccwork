package cc.hahaxiong.xiaoke.night;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicLong;

/**
 * pa 私人管理后台与 S24 客户端双向同步协调器。
 *
 * 职责与约束：
 * - 单通道串行请求（任意时刻最多一路在途 POST /mobile/night/sync）；
 * - 首次拉取 + 活动前台约 10s 心跳 + 操作/状态变更快速合并（250-300ms）；
 * - 未配对、后台、页面不可信或销毁时立即停止并中断在途请求；
 * - 响应必须匹配本次配对账号（凭据指纹 + pairingGen + device）与本次可信页面（pageGen）；
 * - 持久化 appliedRevision、最后执行命令及待发 ack，命令执行严格幂等；
 * - 区分手选颜色（local）与服务端下发颜色（remote），避免回环与覆盖在途更新手选色；
 * - 命令仅触发已有日志上报（sync_logs）与检查更新（check_update），绝不自动录音、接通或安装。
 */
final class NightSync {

    private static final String TAG = "NightSync";

    static final long HEARTBEAT_INTERVAL_MS = 10_000L;
    static final long COALESCE_STATE_MS = 250L;
    static final long COALESCE_ACCENT_MS = 300L;
    static final long FOLLOW_UP_DELAY_MS = 350L;
    static final long AUTH_ERROR_BACKOFF_MS = 60_000L;
    static final long MAX_ERROR_BACKOFF_MS = 60_000L;
    private static final int MAX_CONSECUTIVE_AUTO_FOLLOWUPS = 2;

    interface CredentialProvider {
        boolean isPaired();
        String loadBearer();
    }

    interface HostGateway {
        boolean isPageTrusted();
        void deliverSyncAccent(String hex);
        void triggerSyncLogs();
        void triggerCheckUpdate();
    }

    interface Scheduler {
        void post(Runnable action);
        void postDelayed(Runnable action, long delayMs);
        void removeCallbacks(Runnable action);
    }

    private static final class MainHandlerScheduler implements Scheduler {
        private final Handler handler = new Handler(Looper.getMainLooper());

        @Override
        public void post(Runnable action) {
            handler.post(action);
        }

        @Override
        public void postDelayed(Runnable action, long delayMs) {
            handler.postDelayed(action, delayMs);
        }

        @Override
        public void removeCallbacks(Runnable action) {
            handler.removeCallbacks(action);
        }
    }

    private final long versionCode;
    private final CredentialProvider credentials;
    private final NightSyncStore store;
    private final NightSyncClient.Transport transport;
    private final Scheduler scheduler;
    private final ExecutorService executor;
    private volatile HostGateway gateway;

    private final AtomicLong pairingGen = new AtomicLong(1L);
    private final AtomicLong pageGen = new AtomicLong(1L);
    private volatile boolean foreground;
    private volatile boolean destroyed;

    // 以下状态仅在 scheduler（主线程）访问
    private boolean webAttached;
    private boolean firstPullDispatched;
    private boolean pairedHint = true;
    private boolean inflight;
    private boolean dirty;
    private boolean timerScheduled;
    private long scheduledAtMs;
    private long localAccentSeq;
    private int consecutiveAutoFollowUps;
    private int consecutiveErrors;
    private String currentPhase = "idle";
    private boolean currentMuted;
    private String currentAccent = NightSyncClient.DEFAULT_ACCENT;

    private final Runnable syncTrigger = new Runnable() {
        @Override
        public void run() {
            timerScheduled = false;
            dispatchSync();
        }
    };

    NightSync(final Context context, final SecureStore secureStore) {
        this(
                resolveVersionCode(context),
                new CredentialProvider() {
                    @Override
                    public boolean isPaired() {
                        return secureStore.isPaired();
                    }

                    @Override
                    public String loadBearer() {
                        return secureStore.loadKey();
                    }
                },
                new NightSyncStore(context),
                new NightSyncClient.HttpsTransport(),
                new MainHandlerScheduler(),
                createExecutor()
        );
    }

    NightSync(long versionCode,
              CredentialProvider credentials,
              NightSyncStore store,
              NightSyncClient.Transport transport,
              Scheduler scheduler,
              ExecutorService executor) {
        this.versionCode = (versionCode > 0L && versionCode <= 2_100_000_000L)
                ? versionCode
                : NightSyncClient.DEFAULT_VERSION_CODE;
        this.credentials = credentials;
        this.store = store;
        this.transport = transport;
        this.scheduler = scheduler;
        this.executor = executor;
    }

    void attachGateway(HostGateway gateway) {
        this.gateway = gateway;
    }

    // ------------------------------------------------------------- 生命周期钩子

    void onForeground(final boolean active) {
        this.foreground = active;
        if (!active) {
            transport.abort();
        }
        scheduler.post(new Runnable() {
            @Override
            public void run() {
                if (destroyed) {
                    return;
                }
                if (!active) {
                    cancelTimer();
                    return;
                }
                consecutiveErrors = 0;
                consecutiveAutoFollowUps = 0;
                firstPullDispatched = false;
                if (canSyncNow()) {
                    scheduleSync(0L, true);
                }
            }
        });
    }

    void onPageStarted(final boolean trusted) {
        pageGen.incrementAndGet();
        transport.abort();
        scheduler.post(new Runnable() {
            @Override
            public void run() {
                if (destroyed) {
                    return;
                }
                webAttached = false;
                firstPullDispatched = false;
                inflight = false;
                dirty = false;
                consecutiveAutoFollowUps = 0;
                cancelTimer();
            }
        });
    }

    void onPageReady() {
        scheduler.post(new Runnable() {
            @Override
            public void run() {
                if (destroyed) {
                    return;
                }
                if (webAttached && !firstPullDispatched && !inflight && canSyncNow()) {
                    scheduleSync(0L, true);
                }
            }
        });
    }

    /**
     * 启动检查发现未配对时调用（不触发网络请求，仅确保本地停止并清理残留状态）。
     */
    void observeUnpaired() {
        if (store.hasBoundCredential()) {
            store.clear();
        }
        scheduler.post(new Runnable() {
            @Override
            public void run() {
                if (destroyed) {
                    return;
                }
                pairedHint = false;
                cancelTimer();
            }
        });
    }

    /**
     * 配对成功时调用（通常在 JavaBridge 后台线程）：立即递增代际、重置旧账号存储并触发首次拉取。
     */
    void onPaired(String credHash) {
        pairingGen.incrementAndGet();
        transport.abort();
        store.ensureCredential(credHash);
        scheduler.post(new Runnable() {
            @Override
            public void run() {
                if (destroyed) {
                    return;
                }
                pairedHint = true;
                firstPullDispatched = false;
                inflight = false;
                dirty = false;
                consecutiveErrors = 0;
                consecutiveAutoFollowUps = 0;
                cancelTimer();
                if (canSyncNow()) {
                    scheduleSync(0L, true);
                }
            }
        });
    }

    /**
     * 解除配对时调用：立即递增代际、中断在途请求、清空持久化同步状态并彻底停止心跳。
     */
    void onUnpaired() {
        pairingGen.incrementAndGet();
        transport.abort();
        store.clear();
        scheduler.post(new Runnable() {
            @Override
            public void run() {
                if (destroyed) {
                    return;
                }
                pairedHint = false;
                firstPullDispatched = false;
                inflight = false;
                dirty = false;
                consecutiveErrors = 0;
                consecutiveAutoFollowUps = 0;
                cancelTimer();
            }
        });
    }

    /**
     * 页面状态初始化或变更（须在主线程/scheduler 执行）。
     * localAccentPick=true 表示用户手动选色；false 表示初始化或非选色状态变化。
     */
    void onWebState(final String rawPhase, final boolean muted,
                    final String rawAccent, final boolean localAccentPick) {
        scheduler.post(new Runnable() {
            @Override
            public void run() {
                applyWebStateOnMain(rawPhase, muted, rawAccent, localAccentPick);
            }
        });
    }

    void shutdown() {
        destroyed = true;
        pairingGen.incrementAndGet();
        pageGen.incrementAndGet();
        transport.abort();
        scheduler.removeCallbacks(syncTrigger);
        executor.shutdownNow();
    }

    // -------------------------------------------------------------- 主线程调度

    private void applyWebStateOnMain(String rawPhase, boolean muted,
                                     String rawAccent, boolean localAccentPick) {
        if (destroyed) {
            return;
        }
        String normPhase = NightSyncClient.normalizePhase(rawPhase);
        String normAccent = NightSyncClient.normalizeAccent(rawAccent);

        if (!webAttached) {
            webAttached = true;
            currentPhase = normPhase;
            currentMuted = muted;

            String storedAccent = (pairedHint && store.hasBoundCredential()) ? store.getLastAccent() : "";
            if (!localAccentPick && !storedAccent.isEmpty()) {
                currentAccent = storedAccent;
                if (normAccent != null && !storedAccent.equals(normAccent)) {
                    HostGateway gw = gateway;
                    if (gw != null && gw.isPageTrusted()) {
                        gw.deliverSyncAccent(storedAccent);
                    }
                }
            } else if (normAccent != null) {
                currentAccent = normAccent;
                if (localAccentPick) {
                    localAccentSeq++;
                    if (pairedHint && store.hasBoundCredential()) {
                        store.saveLocalAccent(normAccent);
                    }
                }
            }

            if (canSyncNow()) {
                scheduleSync(0L, true);
            }
            return;
        }

        boolean phaseChanged = !normPhase.equals(currentPhase);
        boolean mutedChanged = muted != currentMuted;
        currentPhase = normPhase;
        currentMuted = muted;

        if (localAccentPick && normAccent != null) {
            currentAccent = normAccent;
            localAccentSeq++;
            if (pairedHint && store.hasBoundCredential()) {
                store.saveLocalAccent(normAccent);
            }
            consecutiveAutoFollowUps = 0;
            if (canSyncNow()) {
                if (inflight) {
                    dirty = true;
                } else {
                    scheduleSync(COALESCE_ACCENT_MS, true);
                }
            }
            return;
        }

        if (phaseChanged || mutedChanged) {
            consecutiveAutoFollowUps = 0;
            if (canSyncNow()) {
                if (inflight) {
                    dirty = true;
                } else {
                    scheduleSync(COALESCE_STATE_MS, true);
                }
            }
        }
    }

    private boolean canSyncNow() {
        HostGateway gw = gateway;
        return !destroyed
                && foreground
                && pairedHint
                && webAttached
                && gw != null
                && gw.isPageTrusted();
    }

    private void cancelTimer() {
        timerScheduled = false;
        scheduler.removeCallbacks(syncTrigger);
    }

    private void scheduleSync(long delayMs, boolean replaceEarlier) {
        if (!canSyncNow()) {
            cancelTimer();
            return;
        }
        long clamped = Math.max(0L, delayMs);
        long targetAt = System.currentTimeMillis() + clamped;
        if (timerScheduled && !replaceEarlier && scheduledAtMs <= targetAt) {
            return;
        }
        scheduler.removeCallbacks(syncTrigger);
        timerScheduled = true;
        scheduledAtMs = targetAt;
        if (clamped == 0L) {
            scheduler.post(syncTrigger);
        } else {
            scheduler.postDelayed(syncTrigger, clamped);
        }
    }

    private void dispatchSync() {
        if (!canSyncNow()) {
            return;
        }
        if (inflight) {
            dirty = true;
            return;
        }

        final long snapPairingGen = pairingGen.get();
        final long snapPageGen = pageGen.get();
        final String snapPhase = currentPhase;
        final boolean snapMuted = currentMuted;
        final String snapAccent = currentAccent;
        final long snapLocalAccentSeq = localAccentSeq;

        firstPullDispatched = true;
        inflight = true;
        dirty = false;

        try {
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    runSyncOnWorker(
                            snapPairingGen,
                            snapPageGen,
                            snapPhase,
                            snapMuted,
                            snapAccent,
                            snapLocalAccentSeq
                    );
                }
            });
        } catch (Throwable rejected) {
            inflight = false;
        }
    }

    private void runSyncOnWorker(final long snapPairingGen,
                                 final long snapPageGen,
                                 final String snapPhase,
                                 final boolean snapMuted,
                                 final String snapAccent,
                                 final long snapLocalAccentSeq) {
        String bearer = null;
        try {
            if (destroyed || pairingGen.get() != snapPairingGen || pageGen.get() != snapPageGen) {
                postDrop(snapPairingGen, snapPageGen);
                return;
            }
            bearer = credentials.loadBearer();
            if (!SecureStore.isAcceptableKey(bearer)) {
                store.clear();
                postUnpairedObserved(snapPairingGen);
                return;
            }
            final String credHash = NightSyncStore.sha256Hex(bearer.trim());
            store.ensureCredential(credHash);

            final long appliedRev = store.getAppliedRevision();
            final String pendingAck = store.getPendingAck();
            final String expectedDevice = store.getDevice();

            final NightSyncClient.SyncRequest request = new NightSyncClient.SyncRequest(
                    versionCode,
                    snapPhase,
                    snapMuted,
                    snapAccent,
                    appliedRev,
                    pendingAck
            );

            final NightSyncClient.SyncResult rawResult = transport.send(bearer, request);
            bearer = null;

            if (destroyed || pairingGen.get() != snapPairingGen || pageGen.get() != snapPageGen) {
                postDrop(snapPairingGen, snapPageGen);
                return;
            }

            // 二次核对当前凭据未在网络往返期间被替换或解除
            String afterBearer = null;
            String afterHash = "";
            try {
                afterBearer = credentials.loadBearer();
                if (SecureStore.isAcceptableKey(afterBearer)) {
                    afterHash = NightSyncStore.sha256Hex(afterBearer.trim());
                }
            } finally {
                afterBearer = null;
            }
            if (!credHash.equals(afterHash)) {
                postDrop(snapPairingGen, snapPageGen);
                return;
            }

            final NightSyncClient.SyncResult finalResult;
            if (rawResult.ok && rawResult.response != null
                    && !expectedDevice.isEmpty()
                    && !expectedDevice.equals(rawResult.response.device)) {
                Log.w(TAG, "sync response rejected: device mismatch");
                finalResult = NightSyncClient.SyncResult.fail("device-mismatch", 200, false, 0L);
            } else {
                finalResult = rawResult;
            }

            scheduler.post(new Runnable() {
                @Override
                public void run() {
                    handleSyncResultOnMain(
                            snapPairingGen,
                            snapPageGen,
                            credHash,
                            snapLocalAccentSeq,
                            request,
                            finalResult
                    );
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "sync worker error: " + t.getClass().getSimpleName());
            postDrop(snapPairingGen, snapPageGen);
        } finally {
            bearer = null;
        }
    }

    private void postDrop(final long snapPairingGen, final long snapPageGen) {
        scheduler.post(new Runnable() {
            @Override
            public void run() {
                if (pairingGen.get() == snapPairingGen && pageGen.get() == snapPageGen) {
                    inflight = false;
                }
            }
        });
    }

    private void postUnpairedObserved(final long snapPairingGen) {
        scheduler.post(new Runnable() {
            @Override
            public void run() {
                if (destroyed || pairingGen.get() != snapPairingGen) {
                    return;
                }
                pairedHint = false;
                inflight = false;
                dirty = false;
                cancelTimer();
            }
        });
    }

    private void handleSyncResultOnMain(long snapPairingGen,
                                        long snapPageGen,
                                        String credHash,
                                        long snapLocalAccentSeq,
                                        NightSyncClient.SyncRequest request,
                                        NightSyncClient.SyncResult result) {
        if (destroyed
                || pairingGen.get() != snapPairingGen
                || pageGen.get() != snapPageGen) {
            return;
        }
        inflight = false;

        HostGateway gw = gateway;
        if (!foreground || !pairedHint || gw == null || !gw.isPageTrusted()) {
            return;
        }
        if (!credHash.equals(store.getCredentialHash())) {
            return;
        }

        if (!result.ok || result.response == null) {
            handleSyncErrorOnMain(result);
            return;
        }

        consecutiveErrors = 0;
        NightSyncClient.SyncResponse resp = result.response;

        if (resp.ignoredUnsupportedCommand) {
            Log.w(TAG, "sync: ignored unsupported command action");
        }

        // 若旧的 device 绑定与响应不一致，拒绝落库与应用
        String boundDevice = store.getDevice();
        if (!boundDevice.isEmpty() && !boundDevice.equals(resp.device)) {
            Log.w(TAG, "sync response dropped on main: device mismatch");
            scheduleNextAfterIdle();
            return;
        }

        long prevAppliedRev = store.getAppliedRevision();
        boolean revChanged = resp.revision != prevAppliedRev;
        boolean accentPushed = false;
        boolean localPickInFlight = localAccentSeq > snapLocalAccentSeq;

        String persistedAccent = currentAccent;
        String persistedSource = store.getAccentSource();

        if (!localPickInFlight) {
            if (resp.accent != null && !resp.accent.equals(currentAccent)) {
                currentAccent = resp.accent;
                persistedAccent = resp.accent;
                persistedSource = NightSyncStore.SOURCE_REMOTE;
                accentPushed = true;
                gw.deliverSyncAccent(resp.accent);
            } else if (resp.accent != null && persistedSource.isEmpty()) {
                persistedAccent = resp.accent;
                persistedSource = NightSyncStore.SOURCE_REMOTE;
            }
        }

        store.saveSyncProgress(
                resp.device,
                resp.revision,
                persistedAccent,
                persistedSource.isEmpty() ? null : persistedSource
        );

        // 服务端已收到上次 ack 且不再下发同一命令时，清除待发 ack（保留 lastCommandId 供幂等判重）
        if (!request.ack.isEmpty()) {
            if (resp.command == null || !request.ack.equals(resp.command.id)) {
                store.clearPendingAckIfMatches(request.ack);
            }
        }

        boolean needAckFollowUp = false;
        if (resp.command != null) {
            String cmdId = resp.command.id;
            String action = resp.command.action;
            if (!store.wasCommandExecuted(cmdId)) {
                // 先落盘再触发，确保进程被杀也不会重复执行且重启后会补发 ack
                store.recordCommandExecuted(cmdId, action);
                executeAllowedCommand(gw, action);
                needAckFollowUp = true;
            } else {
                // 已执行过：绝不重复执行；若本轮请求尚未携带该 ack，尽快补发一次 ack
                store.setPendingAck(cmdId);
                if (!cmdId.equals(request.ack)) {
                    needAckFollowUp = true;
                }
            }
        }

        if (dirty || localPickInFlight) {
            consecutiveAutoFollowUps = 0;
            scheduleSync(COALESCE_STATE_MS, true);
        } else if ((needAckFollowUp || accentPushed || revChanged)
                && consecutiveAutoFollowUps < MAX_CONSECUTIVE_AUTO_FOLLOWUPS) {
            consecutiveAutoFollowUps++;
            scheduleSync(FOLLOW_UP_DELAY_MS, true);
        } else {
            scheduleNextAfterIdle();
        }
    }

    private void handleSyncErrorOnMain(NightSyncClient.SyncResult result) {
        consecutiveErrors++;
        consecutiveAutoFollowUps = 0;

        if ("unpaired".equals(result.errorCode)) {
            pairedHint = false;
            cancelTimer();
            return;
        }

        Log.w(TAG, "sync failed: " + result.errorCode);

        long delayMs;
        if (result.httpStatus == 429) {
            delayMs = result.retryAfterMs > 0L ? result.retryAfterMs : AUTH_ERROR_BACKOFF_MS;
        } else if (result.httpStatus == 401 || result.httpStatus == 403) {
            delayMs = AUTH_ERROR_BACKOFF_MS;
        } else if (dirty) {
            delayMs = 2_000L;
        } else {
            long factor = Math.min(6L, (long) consecutiveErrors);
            delayMs = Math.min(MAX_ERROR_BACKOFF_MS, HEARTBEAT_INTERVAL_MS * factor);
        }
        scheduleSync(delayMs, true);
    }

    private void scheduleNextAfterIdle() {
        consecutiveAutoFollowUps = 0;
        scheduleSync(HEARTBEAT_INTERVAL_MS, false);
    }

    private static void executeAllowedCommand(HostGateway gw, String action) {
        if (NightSyncClient.ACTION_SYNC_LOGS.equals(action)) {
            gw.triggerSyncLogs();
        } else if (NightSyncClient.ACTION_CHECK_UPDATE.equals(action)) {
            gw.triggerCheckUpdate();
        }
    }

    // ------------------------------------------------------------------ 小工具

    private static ExecutorService createExecutor() {
        return Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "night-sync");
                t.setDaemon(true);
                return t;
            }
        });
    }

    private static long resolveVersionCode(Context context) {
        if (context == null) {
            return NightSyncClient.DEFAULT_VERSION_CODE;
        }
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            if (info == null) {
                return NightSyncClient.DEFAULT_VERSION_CODE;
            }
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : legacyVersionCode(info);
            return (code > 0L && code <= 2_100_000_000L) ? code : NightSyncClient.DEFAULT_VERSION_CODE;
        } catch (Throwable ignored) {
            return NightSyncClient.DEFAULT_VERSION_CODE;
        }
    }

    @SuppressWarnings("deprecation")
    private static long legacyVersionCode(PackageInfo info) {
        return info.versionCode;
    }
}
