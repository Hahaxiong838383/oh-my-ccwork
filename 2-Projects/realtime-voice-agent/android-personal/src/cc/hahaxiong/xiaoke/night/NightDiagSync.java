package cc.hahaxiong.xiaoke.night;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 单通道串行回传协调器（参考 MyJavis LearningSync 的去重与重跑模型）。
 *
 * 特性：
 * - 任意时刻最多一路在途上传，杜绝并行重发风暴；
 * - 上传期间若再次触发 flush，置位 rerun 标志，本轮结束后立即接续一轮；
 * - 仅在服务端明确返回 {acked:[id...]} 后删除对应 eventId；
 * - 凭据仅在发送前经 CredentialSource 临时读取，绝不缓存为字段。
 */
final class NightDiagSync {

    static final int DEFAULT_BATCH_SIZE = 100;
    static final int MAX_BATCHES_PER_RUN = 12;

    interface CredentialSource {
        /** 仅从 SecureStore 临时读取当前设备凭据；未配对或不可读返回 null。 */
        String loadBearer();
    }

    interface Completion {
        void onDone(boolean retryableFailure, boolean hasRemaining);
    }

    private final NightDiagJournal journal;
    private final NightDiagTransport transport;
    private final CredentialSource credentials;
    private final int batchSize;

    private final ExecutorService executor;
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private final AtomicBoolean rerun = new AtomicBoolean(false);
    private final Object listenersLock = new Object();
    private final List<Completion> listeners = new ArrayList<Completion>();

    NightDiagSync(NightDiagJournal journal, NightDiagTransport transport, CredentialSource credentials) {
        this(journal, transport, credentials, DEFAULT_BATCH_SIZE);
    }

    NightDiagSync(NightDiagJournal journal, NightDiagTransport transport,
                  CredentialSource credentials, int batchSize) {
        this.journal = journal;
        this.transport = transport;
        this.credentials = credentials;
        this.batchSize = Math.max(1, batchSize);
        this.executor = Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "night-diag-sync");
                t.setDaemon(true);
                return t;
            }
        });
    }

    void flushAsync(Completion completion) {
        if (completion != null) {
            synchronized (listenersLock) {
                listeners.add(completion);
            }
        }
        if (!busy.compareAndSet(false, true)) {
            rerun.set(true);
            return;
        }
        try {
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    drainLoop();
                }
            });
        } catch (Throwable rejected) {
            busy.set(false);
            notifyListeners(true, journal.pendingCount() > 0);
        }
    }

    /** 同步执行一次上传循环（供测试或受控后台线程使用，禁止在主线程调用）。 */
    boolean flushNowSync() {
        RunOutcome outcome = executeOnePass();
        return !outcome.retryableFailure;
    }

    void abortInflight() {
        rerun.set(false);
        transport.abort();
    }

    void shutdown() {
        abortInflight();
        executor.shutdownNow();
    }

    private void drainLoop() {
        boolean lastRetryable = false;
        try {
            do {
                rerun.set(false);
                RunOutcome outcome = executeOnePass();
                lastRetryable = outcome.retryableFailure;
                // 若遇错误则不再紧循环重跑，交由 JobScheduler 指数退避重试
                if (lastRetryable) {
                    rerun.set(false);
                }
            } while (rerun.getAndSet(false));
        } finally {
            busy.set(false);
            // 双重检查：避免 busy 置 false 窗口内新来的 rerun 被漏掉
            if (rerun.getAndSet(false) && busy.compareAndSet(false, true)) {
                try {
                    executor.execute(new Runnable() {
                        @Override
                        public void run() {
                            drainLoop();
                        }
                    });
                    return;
                } catch (Throwable ignored) {
                    busy.set(false);
                }
            }
            notifyListeners(lastRetryable, journal.pendingCount() > 0);
        }
    }

    private RunOutcome executeOnePass() {
        journal.awaitWriterIdle();
        if (journal.pendingCount() <= 0) {
            return new RunOutcome(false);
        }

        // 仅在确实有待回传事件时读取一次设备凭据；用完即随栈帧丢弃
        String bearer = credentials.loadBearer();
        if (!SecureStore.isAcceptableKey(bearer)) {
            journal.recordFlushOutcome("unpaired", System.currentTimeMillis());
            return new RunOutcome(false);
        }

        boolean retryableFailure = false;
        try {
            for (int round = 0; round < MAX_BATCHES_PER_RUN; round++) {
                List<NightDiagEvent> batch = journal.readBatch(batchSize);
                if (batch.isEmpty()) {
                    break;
                }
                long attemptTs = System.currentTimeMillis();
                NightDiagTransport.UploadResult result = transport.send(bearer, batch);
                if (!result.ok) {
                    journal.recordFlushOutcome(result.statusCode, attemptTs);
                    retryableFailure = result.retryable;
                    break;
                }
                if (result.ackedIds.isEmpty()) {
                    // 服务端 200 但未确认任何 id：保留全部事件，停止本轮避免空转
                    journal.recordFlushOutcome("empty-ack", attemptTs);
                    retryableFailure = true;
                    break;
                }
                int removed = journal.acknowledge(result.ackedIds, System.currentTimeMillis());
                journal.recordFlushOutcome("ok", attemptTs);
                if (removed <= 0 || result.ackedIds.size() < batch.size()) {
                    // 部分确认或磁盘写失败：未确认条目原样保留，待下次调度幂等重试
                    retryableFailure = result.ackedIds.size() < batch.size() || removed <= 0;
                    break;
                }
            }
        } finally {
            bearer = null;
        }
        return new RunOutcome(retryableFailure);
    }

    private void notifyListeners(boolean retryableFailure, boolean hasRemaining) {
        List<Completion> snapshot;
        synchronized (listenersLock) {
            if (listeners.isEmpty()) {
                return;
            }
            snapshot = new ArrayList<Completion>(listeners);
            listeners.clear();
        }
        for (Completion cb : snapshot) {
            try {
                cb.onDone(retryableFailure, hasRemaining);
            } catch (Throwable ignored) {
            }
        }
    }

    private static final class RunOutcome {
        final boolean retryableFailure;

        RunOutcome(boolean retryableFailure) {
            this.retryableFailure = retryableFailure;
        }
    }
}
