package cc.hahaxiong.xiaoke.night;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Looper;

import org.json.JSONObject;

import java.io.File;

/**
 * 小可 Night 诊断汇总与持久回传统一入口。
 *
 * 对外契约：
 * - NightDiagnostics.event(Context, String)    仅记录 13 项白名单事件，不收对话/密钥/IP
 * - NightDiagnostics.schedule(Context)         注册可联网、跨重启的 JobScheduler 回传任务
 * - NightDiagnostics.flush(Context)            触发后台单通道安全回传（确认才删、幂等 eventId）
 * - NightDiagnostics.summary(Context)          返回供 UI 显示的本机通话/错误/媒体/字幕/待回传汇总
 */
public final class NightDiagnostics {

    private static final String DIR_NAME = "night_diag";
    private static volatile NightDiagnostics instance;

    private final Context appContext;
    private final NightDiagJournal journal;
    private final NightDiagSync sync;
    private final long versionCode;

    private NightDiagnostics(Context appContext) {
        this.appContext = appContext;
        this.versionCode = resolveVersionCode(appContext);
        File dir = new File(appContext.getFilesDir(), DIR_NAME);
        this.journal = new NightDiagJournal(dir);
        final Context credentialCtx = appContext;
        NightDiagSync.CredentialSource creds = new NightDiagSync.CredentialSource() {
            @Override
            public String loadBearer() {
                try {
                    SecureStore store = new SecureStore(credentialCtx);
                    String key = store.loadKey();
                    if (!SecureStore.isAcceptableKey(key)) {
                        return null;
                    }
                    return key.trim();
                } catch (Throwable ignored) {
                    return null;
                }
            }
        };
        this.sync = new NightDiagSync(journal, new NightDiagTransport.HttpsTransport(), creds);
    }

    private static NightDiagnostics get(Context context) {
        if (context == null) {
            return null;
        }
        NightDiagnostics current = instance;
        if (current != null) {
            return current;
        }
        Context app = context.getApplicationContext();
        if (app == null) {
            app = context;
        }
        synchronized (NightDiagnostics.class) {
            if (instance == null) {
                instance = new NightDiagnostics(app);
            }
            return instance;
        }
    }

    /** 校验事件类型是否属于严格白名单。 */
    public static boolean isAllowedKind(String kind) {
        return NightDiagEvent.isAllowedKind(kind);
    }

    /**
     * 记录一条白名单诊断事件。
     * 非白名单事件直接拒绝（返回 false），绝不落盘、不上传、不打印原文。
     */
    public static boolean event(Context context, String kind) {
        if (!NightDiagEvent.isAllowedKind(kind)) {
            return false;
        }
        NightDiagnostics diag = get(context);
        if (diag == null) {
            return false;
        }
        NightDiagEvent ev = NightDiagEvent.create(kind, System.currentTimeMillis(), diag.versionCode);
        if (ev == null) {
            return false;
        }
        boolean onMain = isMainThread();
        boolean accepted = diag.journal.enqueue(ev, !onMain);
        if (accepted) {
            // 幂等补排一次性联网任务；若已排入则仅一次 getPendingJob 检查
            NightDiagScheduler.schedulePendingFlush(diag.appContext);
        }
        return accepted;
    }

    /** 调度可联网、跨重启的 JobScheduler 周期与待发回传任务。 */
    public static boolean schedule(Context context) {
        NightDiagnostics diag = get(context);
        if (diag == null) {
            return false;
        }
        boolean hasPending = diag.journal.pendingCount() > 0;
        return NightDiagScheduler.schedule(diag.appContext, hasPending);
    }

    /** 触发一次异步后台回传（非阻塞、单通道防并行、确认才删）。 */
    public static void flush(Context context) {
        flush(context, null);
    }

    /** 触发一次异步后台回传，并在本轮结束后回调 onComplete（在后台线程触发）。 */
    public static void flush(Context context, final Runnable onComplete) {
        NightDiagnostics diag = get(context);
        if (diag == null) {
            if (onComplete != null) {
                onComplete.run();
            }
            return;
        }
        NightDiagSync.Completion cb = onComplete == null ? null : new NightDiagSync.Completion() {
            @Override
            public void onDone(boolean retryableFailure, boolean hasRemaining) {
                if (retryableFailure && hasRemaining) {
                    NightDiagScheduler.schedulePendingFlush(diag.appContext);
                }
                onComplete.run();
            }
        };
        if (cb == null) {
            cb = new NightDiagSync.Completion() {
                @Override
                public void onDone(boolean retryableFailure, boolean hasRemaining) {
                    if (retryableFailure && hasRemaining) {
                        NightDiagScheduler.schedulePendingFlush(diag.appContext);
                    }
                }
            };
        }
        diag.sync.flushAsync(cb);
    }

    /**
     * 返回供 UI 展示的本机诊断汇总 JSONObject：
     * 含 calls/connected/callEnd、errors、media(micOn/micOff/rxAudio)、
     * captions(rxCaption/txCaption/spokenInterrupt/cancelAck)、
     * pending/acked/dropped、时间戳、状态码与中文展示串 text。
     */
    public static JSONObject summary(Context context) {
        NightDiagnostics diag = get(context);
        if (diag == null) {
            return new JSONObject();
        }
        return diag.journal.snapshotSummary();
    }

    /** 便捷方法：直接返回 UI 展示用单行中文摘要文本。 */
    public static String summaryText(Context context) {
        JSONObject obj = summary(context);
        String text = obj.optString("text", "");
        JSONObject media = obj.optJSONObject("media");
        JSONObject captions = obj.optJSONObject("captions");
        if (obj.optLong("calls") > 0 && obj.optLong("connected") == 0)
            text += "\n尚未收到小可接听回执。可先检查手机网络与个人 Worker 在线状态。";
        else if (media != null && captions != null && media.optLong("rxAudio") == 0 && captions.optLong("rxCaption") > 0)
            text += "\n已有回复字幕，还没有非零回放。可检查音频路由及合成服务。";
        if (obj.optLong("lastAckTs") > 0) text += "\n最近回传 " + android.text.format.DateFormat.format("MM-dd HH:mm", obj.optLong("lastAckTs"));
        return text;
    }

    // --------------------------------------------------------- package hooks

    static void flushFromJob(Context context, NightDiagSync.Completion completion) {
        NightDiagnostics diag = get(context);
        if (diag == null) {
            if (completion != null) {
                completion.onDone(false, false);
            }
            return;
        }
        diag.sync.flushAsync(completion);
    }

    static void abortInflight(Context context) {
        NightDiagnostics diag = instance;
        if (diag != null) {
            diag.sync.abortInflight();
        }
    }

    static int pendingCount(Context context) {
        NightDiagnostics diag = get(context);
        return diag == null ? 0 : diag.journal.pendingCount();
    }

    // --------------------------------------------------------------- helpers

    private static boolean isMainThread() {
        try {
            Looper main = Looper.getMainLooper();
            return main != null && Looper.myLooper() == main;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static long resolveVersionCode(Context app) {
        try {
            PackageInfo info = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            if (info == null) {
                return 0L;
            }
            if (Build.VERSION.SDK_INT >= 28) {
                return info.getLongVersionCode();
            }
            return legacyVersionCode(info);
        } catch (Throwable ignored) {
            return 0L;
        }
    }

    @SuppressWarnings("deprecation")
    private static long legacyVersionCode(PackageInfo info) {
        return info.versionCode;
    }
}
