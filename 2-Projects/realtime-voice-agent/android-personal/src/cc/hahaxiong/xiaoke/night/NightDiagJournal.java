package cc.hahaxiong.xiaoke.night;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * 持久化诊断日志缓冲与本地汇总存储。
 *
 * 设计要点（对齐 MyJavis JournalPrefix 的安全语义并扩展支持按 eventId 选择性 ACK）：
 * 1. 跨重启保留：events.jsonl 与 stats.json 存储在应用私有目录，每次落盘均 getFD().sync()；
 * 2. 有限本地缓冲：默认上限 1000 条 / 256 KiB，满额时原子淘汰最旧未回传记录并计入 droppedTotal；
 * 3. 确认才删：网络上传不持有磁盘锁，收到服务端 {acked:[id...]} 后在锁内重读当前 events.jsonl，
 *    仅删除已确认的 eventId，其余旧记录与上传期间并行追加的新记录全部原样保留，原子写回；
 * 4. 不丢并行追加：所有写盘走单线程串行执行器 + ioLock，主线程写入异步提交零阻塞，
 *    通过 inflightAppends 内存队列保证 UI summary 立即反映最新事件且 flush 前自动排空。
 */
final class NightDiagJournal {

    static final int DEFAULT_MAX_PENDING_EVENTS = 1000;
    static final int DEFAULT_MAX_JOURNAL_BYTES = 256 * 1024;
    private static final String EVENTS_FILE = "events.jsonl";
    private static final String STATS_FILE = "stats.json";
    private static final int STATS_SCHEMA = 1;
    private static final long DRAIN_TIMEOUT_MS = 3000L;

    private final File dir;
    private final File eventsFile;
    private final File statsFile;
    private final int maxPendingEvents;
    private final int maxJournalBytes;

    private final Object ioLock = new Object();
    private final ExecutorService writer;
    private final List<NightDiagEvent> inflightAppends = new ArrayList<NightDiagEvent>();

    private boolean loaded;
    private int pendingCount;
    private long pendingBytes;
    private long ackedTotal;
    private long droppedTotal;
    private long lastEventTs;
    private long lastAckTs;
    private long lastFlushAttemptTs;
    private String lastFlushResult = "idle";
    private final Map<String, Long> kindCounts = new LinkedHashMap<String, Long>();

    NightDiagJournal(File dir) {
        this(dir, DEFAULT_MAX_PENDING_EVENTS, DEFAULT_MAX_JOURNAL_BYTES);
    }

    NightDiagJournal(File dir, int maxPendingEvents, int maxJournalBytes) {
        if (dir == null) {
            throw new IllegalArgumentException("dir");
        }
        if (maxPendingEvents <= 0 || maxJournalBytes < 256) {
            throw new IllegalArgumentException("invalid buffer bounds");
        }
        this.dir = dir;
        this.eventsFile = new File(dir, EVENTS_FILE);
        this.statsFile = new File(dir, STATS_FILE);
        this.maxPendingEvents = maxPendingEvents;
        this.maxJournalBytes = maxJournalBytes;
        for (String kind : NightDiagEvent.ALLOWED_KINDS) {
            kindCounts.put(kind, 0L);
        }
        this.writer = Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "night-diag-journal");
                t.setDaemon(true);
                return t;
            }
        });
    }

    /**
     * 追加一条已校验事件。
     * @param blockUntilPersisted 主线程传 false（非阻塞）；工作线程可传 true 等待落盘。
     */
    boolean enqueue(final NightDiagEvent event, boolean blockUntilPersisted) {
        if (event == null) {
            return false;
        }
        synchronized (ioLock) {
            inflightAppends.add(event);
        }
        try {
            Future<Boolean> future = writer.submit(new Callable<Boolean>() {
                @Override
                public Boolean call() {
                    return persistAppendedEvent(event);
                }
            });
            if (blockUntilPersisted) {
                try {
                    Boolean ok = future.get(DRAIN_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                    return Boolean.TRUE.equals(ok);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return true;
                } catch (Throwable ignored) {
                    return false;
                }
            }
            return true;
        } catch (Throwable rejected) {
            synchronized (ioLock) {
                inflightAppends.remove(event);
            }
            return false;
        }
    }

    /** 等待此前所有异步追加任务全部落盘（供上传线程或单测调用，禁止在主线程调用）。 */
    void awaitWriterIdle() {
        try {
            writer.submit(new Runnable() {
                @Override
                public void run() {
                    // 栅栏：保证此任务之前的 enqueue 全部已执行完毕
                }
            }).get(DRAIN_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        } catch (Throwable ignored) {
        }
    }

    /** 读取最旧的不超过 maxBatch 条待回传事件（不删除、不持有锁跨网络）。 */
    List<NightDiagEvent> readBatch(int maxBatch) {
        if (maxBatch <= 0) {
            return Collections.emptyList();
        }
        awaitWriterIdle();
        synchronized (ioLock) {
            ensureLoadedLocked();
            if (!eventsFile.isFile() || pendingCount <= 0) {
                return Collections.emptyList();
            }
            List<NightDiagEvent> all = readValidEventsLocked();
            reconcilePendingCountsLocked(all);
            if (all.isEmpty()) {
                return Collections.emptyList();
            }
            int limit = Math.min(maxBatch, all.size());
            return new ArrayList<NightDiagEvent>(all.subList(0, limit));
        }
    }

    /**
     * 仅删除服务端已确认的 eventId。
     * 重读当前磁盘完整文件，确保上传期间并行追加的新事件绝对不被覆盖或丢失。
     * @return 实际从缓冲中移除的事件数。
     */
    int acknowledge(Set<String> ackedIds, long ackTs) {
        if (ackedIds == null || ackedIds.isEmpty()) {
            return 0;
        }
        awaitWriterIdle();
        synchronized (ioLock) {
            ensureLoadedLocked();
            if (!eventsFile.isFile()) {
                pendingCount = 0;
                pendingBytes = 0L;
                return 0;
            }
            List<NightDiagEvent> current = readValidEventsLocked();
            List<NightDiagEvent> remaining = new ArrayList<NightDiagEvent>(current.size());
            int removed = 0;
            for (NightDiagEvent ev : current) {
                if (ackedIds.contains(ev.id)) {
                    removed++;
                } else {
                    remaining.add(ev);
                }
            }
            if (removed == 0) {
                reconcilePendingCountsLocked(current);
                return 0;
            }
            try {
                long bytes = rewriteEventsAtomicallyLocked(remaining);
                pendingCount = remaining.size();
                pendingBytes = bytes;
                ackedTotal += removed;
                lastAckTs = ackTs > 0L ? ackTs : System.currentTimeMillis();
                writeStatsAtomicallyLocked();
                return removed;
            } catch (IOException ignored) {
                // 写盘失败时保留原文件，下次重试幂等重送
                return 0;
            }
        }
    }

    void recordFlushOutcome(String safeStatus, long attemptTs) {
        String sanitized = sanitizeStatus(safeStatus);
        synchronized (ioLock) {
            ensureLoadedLocked();
            lastFlushAttemptTs = attemptTs > 0L ? attemptTs : System.currentTimeMillis();
            lastFlushResult = sanitized;
            try {
                writeStatsAtomicallyLocked();
            } catch (IOException ignored) {
            }
        }
    }

    int pendingCount() {
        synchronized (ioLock) {
            ensureLoadedLocked();
            return pendingCount + inflightAppends.size();
        }
    }

    /** 生成供 UI 展示的结构化汇总（不含任何对话、密钥、IP）。 */
    JSONObject snapshotSummary() {
        synchronized (ioLock) {
            ensureLoadedLocked();
            Map<String, Long> merged = new HashMap<String, Long>(kindCounts);
            long mergedLastEventTs = lastEventTs;
            int inflightCount = inflightAppends.size();
            for (NightDiagEvent ev : inflightAppends) {
                Long prev = merged.get(ev.kind);
                merged.put(ev.kind, (prev == null ? 0L : prev.longValue()) + 1L);
                if (ev.ts > mergedLastEventTs) {
                    mergedLastEventTs = ev.ts;
                }
            }
            long calls = countOf(merged, NightDiagEvent.KIND_CALL_START);
            long connected = countOf(merged, NightDiagEvent.KIND_CONNECTED);
            long callEnd = countOf(merged, NightDiagEvent.KIND_CALL_END);
            long errors = countOf(merged, NightDiagEvent.KIND_TRANSPORT_ERROR);
            long micOn = countOf(merged, NightDiagEvent.KIND_MIC_ON);
            long micOff = countOf(merged, NightDiagEvent.KIND_MIC_OFF);
            long rxAudio = countOf(merged, NightDiagEvent.KIND_RX_AUDIO);
            long rxCaption = countOf(merged, NightDiagEvent.KIND_RX_CAPTION);
            long txCaption = countOf(merged, NightDiagEvent.KIND_TX_CAPTION);
            long spokenInterrupt = countOf(merged, NightDiagEvent.KIND_SPOKEN_INTERRUPT);
            long cancelAck = countOf(merged, NightDiagEvent.KIND_CANCEL_ACK);
            long paired = countOf(merged, NightDiagEvent.KIND_PAIRED);
            long otaChecks = countOf(merged, NightDiagEvent.KIND_OTA_CHECK);
            int pending = Math.min(maxPendingEvents, pendingCount + inflightCount);

            String text = formatSummaryText(
                    calls, errors, micOn, micOff, rxAudio,
                    rxCaption, txCaption, spokenInterrupt, cancelAck, pending);

            JSONObject out = new JSONObject();
            try {
                out.put("schema", NightDiagEvent.SCHEMA_VERSION);
                out.put("calls", calls);
                out.put("connected", connected);
                out.put("callEnd", callEnd);
                out.put("errors", errors);

                JSONObject media = new JSONObject();
                media.put("micOn", micOn);
                media.put("micOff", micOff);
                media.put("rxAudio", rxAudio);
                out.put("media", media);

                JSONObject captions = new JSONObject();
                captions.put("rxCaption", rxCaption);
                captions.put("txCaption", txCaption);
                captions.put("spokenInterrupt", spokenInterrupt);
                captions.put("cancelAck", cancelAck);
                out.put("captions", captions);

                out.put("paired", paired);
                out.put("otaChecks", otaChecks);
                out.put("pending", pending);
                out.put("pendingBytes", pendingBytes);
                out.put("acked", ackedTotal);
                out.put("dropped", droppedTotal);
                out.put("lastEventTs", mergedLastEventTs);
                out.put("lastAckTs", lastAckTs);
                out.put("lastFlushAttemptTs", lastFlushAttemptTs);
                out.put("lastFlushResult", lastFlushResult);
                out.put("text", text);
            } catch (JSONException ignored) {
            }
            return out;
        }
    }

    static String formatSummaryText(
            long calls, long errors, long micOn, long micOff, long rxAudio,
            long rxCaption, long txCaption, long spokenInterrupt, long cancelAck, int pending) {
        return "通话 " + calls + " 次｜错误 " + errors
                + "｜媒体(麦 " + micOn + "/" + micOff + " · 音 " + rxAudio + ")"
                + "｜字幕(收 " + rxCaption + "/发 " + txCaption + " · 打断 " + spokenInterrupt + "/" + cancelAck + ")"
                + "｜待回传 " + pending;
    }

    void shutdown() {
        writer.shutdown();
    }

    // ------------------------------------------------------------- internal I/O

    private boolean persistAppendedEvent(NightDiagEvent event) {
        synchronized (ioLock) {
            try {
                ensureLoadedLocked();
                if (!ensureDirLocked()) {
                    return false;
                }
                byte[] lineBytes = event.toJsonLine().getBytes(StandardCharsets.UTF_8);
                if (lineBytes.length > maxJournalBytes) {
                    droppedTotal++;
                    return false;
                }

                // 检查有限缓冲上限：超出则原子淘汰最旧未回传记录，保留最新记录
                if (pendingCount >= maxPendingEvents || pendingBytes + lineBytes.length > maxJournalBytes) {
                    List<NightDiagEvent> current = readValidEventsLocked();
                    current.add(event);
                    int evicted = trimToBounds(current, maxPendingEvents, maxJournalBytes);
                    long bytes = rewriteEventsAtomicallyLocked(current);
                    pendingCount = current.size();
                    pendingBytes = bytes;
                    droppedTotal += evicted;
                } else {
                    appendLineSyncLocked(lineBytes);
                    pendingCount++;
                    pendingBytes += lineBytes.length;
                }

                Long prev = kindCounts.get(event.kind);
                kindCounts.put(event.kind, (prev == null ? 0L : prev.longValue()) + 1L);
                if (event.ts > lastEventTs) {
                    lastEventTs = event.ts;
                }
                writeStatsAtomicallyLocked();
                return true;
            } catch (Throwable ignored) {
                return false;
            } finally {
                inflightAppends.remove(event);
            }
        }
    }

    private void ensureLoadedLocked() {
        if (loaded) {
            return;
        }
        loaded = true;
        cleanupStaleTmpLocked();
        boolean statsLoaded = loadStatsLocked();
        List<NightDiagEvent> validEvents = readValidEventsLocked();
        reconcilePendingCountsLocked(validEvents);

        // 若旧文件存在损坏行（例如掉电截断），清理并重写干净文件
        if (eventsFile.isFile() && eventsFile.length() != pendingBytes) {
            try {
                pendingBytes = rewriteEventsAtomicallyLocked(validEvents);
                pendingCount = validEvents.size();
            } catch (IOException ignored) {
            }
        }

        // 若 stats.json 缺失或损坏，从现有未回传缓冲恢复最小下界计数
        if (!statsLoaded && !validEvents.isEmpty()) {
            for (NightDiagEvent ev : validEvents) {
                Long prev = kindCounts.get(ev.kind);
                kindCounts.put(ev.kind, (prev == null ? 0L : prev.longValue()) + 1L);
                if (ev.ts > lastEventTs) {
                    lastEventTs = ev.ts;
                }
            }
            try {
                writeStatsAtomicallyLocked();
            } catch (IOException ignored) {
            }
        }
    }

    private void cleanupStaleTmpLocked() {
        deleteQuietly(new File(dir, EVENTS_FILE + ".tmp"));
        deleteQuietly(new File(dir, STATS_FILE + ".tmp"));
    }

    private boolean ensureDirLocked() {
        return dir.isDirectory() || dir.mkdirs();
    }

    private List<NightDiagEvent> readValidEventsLocked() {
        List<NightDiagEvent> result = new ArrayList<NightDiagEvent>();
        if (!eventsFile.isFile()) {
            return result;
        }
        Set<String> seenIds = new HashSet<String>();
        BufferedReader reader = null;
        try {
            reader = new BufferedReader(new InputStreamReader(
                    new FileInputStream(eventsFile), StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) {
                NightDiagEvent ev = NightDiagEvent.fromJsonLine(line);
                if (ev != null && seenIds.add(ev.id)) {
                    result.add(ev);
                }
            }
        } catch (IOException ignored) {
        } finally {
            if (reader != null) {
                try {
                    reader.close();
                } catch (IOException ignored) {
                }
            }
        }
        return result;
    }

    private void reconcilePendingCountsLocked(List<NightDiagEvent> validEvents) {
        long bytes = 0L;
        for (NightDiagEvent ev : validEvents) {
            try {
                bytes += ev.toJsonLine().getBytes(StandardCharsets.UTF_8).length;
            } catch (JSONException ignored) {
            }
        }
        pendingCount = validEvents.size();
        pendingBytes = bytes;
    }

    private static int trimToBounds(List<NightDiagEvent> events, int maxEvents, int maxBytes) {
        int evicted = 0;
        while (events.size() > maxEvents) {
            events.remove(0);
            evicted++;
        }
        long total = measureBytes(events);
        while (total > maxBytes && events.size() > 1) {
            NightDiagEvent oldest = events.remove(0);
            evicted++;
            try {
                total -= oldest.toJsonLine().getBytes(StandardCharsets.UTF_8).length;
            } catch (JSONException ignored) {
                total = measureBytes(events);
            }
        }
        return evicted;
    }

    private static long measureBytes(List<NightDiagEvent> events) {
        long total = 0L;
        for (NightDiagEvent ev : events) {
            try {
                total += ev.toJsonLine().getBytes(StandardCharsets.UTF_8).length;
            } catch (JSONException ignored) {
            }
        }
        return total;
    }

    private void appendLineSyncLocked(byte[] lineBytes) throws IOException {
        FileOutputStream out = new FileOutputStream(eventsFile, true);
        try {
            out.write(lineBytes);
            out.getFD().sync();
        } finally {
            try {
                out.close();
            } catch (IOException ignored) {
            }
        }
    }

    private long rewriteEventsAtomicallyLocked(List<NightDiagEvent> events) throws IOException {
        if (!ensureDirLocked()) {
            throw new IOException("journal dir unavailable");
        }
        ByteArrayOutputStream buf = new ByteArrayOutputStream(Math.max(256, events.size() * 96));
        for (NightDiagEvent ev : events) {
            try {
                buf.write(ev.toJsonLine().getBytes(StandardCharsets.UTF_8));
            } catch (JSONException ignored) {
            }
        }
        byte[] data = buf.toByteArray();
        writeFileAtomically(eventsFile, new File(dir, EVENTS_FILE + ".tmp"), data);
        return data.length;
    }

    private boolean loadStatsLocked() {
        if (!statsFile.isFile() || statsFile.length() <= 0L || statsFile.length() > 64 * 1024) {
            return false;
        }
        try {
            byte[] raw = Files.readAllBytes(statsFile.toPath());
            JSONObject obj = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            JSONObject counts = obj.optJSONObject("counts");
            if (counts != null) {
                for (String kind : NightDiagEvent.ALLOWED_KINDS) {
                    long val = counts.optLong(kind, 0L);
                    kindCounts.put(kind, val >= 0L ? val : 0L);
                }
            }
            ackedTotal = Math.max(0L, obj.optLong("ackedTotal", 0L));
            droppedTotal = Math.max(0L, obj.optLong("droppedTotal", 0L));
            lastEventTs = Math.max(0L, obj.optLong("lastEventTs", 0L));
            lastAckTs = Math.max(0L, obj.optLong("lastAckTs", 0L));
            lastFlushAttemptTs = Math.max(0L, obj.optLong("lastFlushAttemptTs", 0L));
            lastFlushResult = sanitizeStatus(obj.optString("lastFlushResult", "idle"));
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private void writeStatsAtomicallyLocked() throws IOException {
        if (!ensureDirLocked()) {
            throw new IOException("stats dir unavailable");
        }
        JSONObject obj = new JSONObject();
        JSONObject counts = new JSONObject();
        try {
            for (String kind : NightDiagEvent.ALLOWED_KINDS) {
                counts.put(kind, countOf(kindCounts, kind));
            }
            obj.put("schema", STATS_SCHEMA);
            obj.put("counts", counts);
            obj.put("ackedTotal", ackedTotal);
            obj.put("droppedTotal", droppedTotal);
            obj.put("lastEventTs", lastEventTs);
            obj.put("lastAckTs", lastAckTs);
            obj.put("lastFlushAttemptTs", lastFlushAttemptTs);
            obj.put("lastFlushResult", lastFlushResult);
        } catch (JSONException e) {
            throw new IOException("stats serialize failed");
        }
        byte[] data = obj.toString().getBytes(StandardCharsets.UTF_8);
        writeFileAtomically(statsFile, new File(dir, STATS_FILE + ".tmp"), data);
    }

    private static void writeFileAtomically(File target, File tmp, byte[] data) throws IOException {
        FileOutputStream out = new FileOutputStream(tmp, false);
        try {
            out.write(data);
            out.getFD().sync();
        } finally {
            try {
                out.close();
            } catch (IOException ignored) {
            }
        }
        try {
            Files.move(tmp.toPath(), target.toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException fallback) {
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static long countOf(Map<String, Long> map, String key) {
        Long val = map.get(key);
        return val == null ? 0L : val.longValue();
    }

    private static String sanitizeStatus(String status) {
        if (status == null || status.isEmpty() || status.length() > 32) {
            return "unknown";
        }
        for (int i = 0; i < status.length(); i++) {
            char c = status.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
            if (!ok) {
                return "unknown";
            }
        }
        return status;
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }
}
