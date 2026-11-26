package cc.hahaxiong.xiaoke.night;

import android.app.Activity;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Night 自有 OTA（独立实现，不共用 MyJavis 的更新源/签名）。
 *
 * 对外只有四个入口：
 *   NightOta.enter(Activity)  —— 前台进入：确保持久定期任务 + 自动检查（节流）
 *   NightOta.check(Activity)  —— 用户主动检查（不节流）
 *   NightOta.status(Context)  —— 一行状态，可直接贴到界面上
 *   NightOta.install(Activity)—— 用户主动安装（系统确认），不会静默安装
 *
 * 自动：检查 + 下载。安装永远需要用户点一下，再由系统弹确认；通话中连确认都不拉起。
 */
public final class NightOta {
    private static final String PREFS = "night_ota";
    private static final String KEY_LINE = "line";
    private static final String KEY_CHECKED = "checked";
    private static final String IDLE = "还没有检查更新";

    private static volatile NightOta instance;

    private final Context app;
    private final SharedPreferences prefs;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "night-ota");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicBoolean busy = new AtomicBoolean();
    private final OtaNet.Cancel cancel = new OtaNet.Cancel();
    private volatile String line;
    private volatile int percent = -1;
    private volatile long gestureAt;

    private NightOta(Context app) {
        this.app = app;
        this.prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.line = prefs.getString(KEY_LINE, IDLE);
        recall();
    }

    static NightOta get(Context context) {
        NightOta local = instance;
        if (local != null) return local;
        synchronized (NightOta.class) {
            if (instance == null) {
                Context base = context.getApplicationContext();
                instance = new NightOta(base == null ? context : base);
            }
            return instance;
        }
    }

    // ---------------------------------------------------------------- 公开 API

    public static void enter(Activity activity) {
        NightOta ota = get(activity);
        OtaJobService.ensureSchedule(ota.app);
        ota.enqueue(false, true);
    }

    public static void check(Activity activity) {
        NightOta ota = get(activity);
        OtaJobService.ensureSchedule(ota.app);
        ota.enqueue(true, false);
    }

    public static String status(Context context) {
        NightOta ota = get(context);
        int progress = ota.percent;
        if (progress >= 0 && progress < 100) return ota.line + " " + progress + "%";
        return ota.line;
    }

    public static void install(Activity activity) {
        get(activity).installOnGesture(activity);
    }

    // -------------------------------------------------------------- 安装（手势）

    private void installOnGesture(Activity activity) {
        if (activity == null || activity.isFinishing()) return;
        if (!OtaConfig.canInstall(app)) {
            note("需要先允许本应用安装未知来源，正在打开系统设置");
            OtaConfig.openInstallSettings(activity);
            return;
        }
        if (OtaConfig.inCall(app)) {
            note("正在通话，等通话结束再点安装");
            return;
        }
        if (busy.get()) {
            note("正在检查或下载，完成后再安装");
            return;
        }
        OtaFiles.State state = OtaFiles.loadState(app);
        File apk;
        try {
            apk = OtaFiles.ready(app);
        } catch (IOException ex) {
            note(OtaFiles.userNote(ex.getMessage()));
            return;
        }
        if (state == null || !state.verified || !apk.isFile()) {
            note("还没有下载好新版本，先检查更新");
            return;
        }
        gestureAt = SystemClock.elapsedRealtime();
        note("正在交给系统安装器");
        worker.execute(() -> {
            try {
                OtaInstall.install(app);
                note("请在系统界面确认安装，没有确认就不会安装");
            } catch (Exception ex) {
                note(OtaFiles.userNote(ex.getMessage()));
            }
        });
    }

    boolean takeInstallGesture() {
        long at = gestureAt;
        gestureAt = 0L;
        return at > 0L && SystemClock.elapsedRealtime() - at <= OtaContract.INSTALL_GAP_MS;
    }

    void onInstalled() {
        OtaFiles.clearDownload(app);
        percent = -1;
        note("系统已完成安装");
    }

    // ------------------------------------------------------------ JobScheduler

    void onJob(JobService service, JobParameters params) {
        worker.execute(() -> {
            try {
                run(false, false);
            } catch (RuntimeException ignored) {
            } finally {
                try {
                    service.jobFinished(params, false);
                } catch (RuntimeException ignored) {
                }
            }
        });
    }

    void stopJob() {
        cancel.stop();
    }

    // ------------------------------------------------------------------ 主流程

    private void enqueue(boolean manual, boolean throttle) {
        worker.execute(() -> run(manual, throttle));
    }

    private void run(boolean manual, boolean throttle) {
        if (!busy.compareAndSet(false, true)) return;
        percent = -1;
        cancel.reset();
        try {
            long now = System.currentTimeMillis();
            if (throttle) {
                long last = prefs.getLong(KEY_CHECKED, 0L);
                if (last > 0L && now - last < OtaContract.FOREGROUND_GAP_MS) return;
            }
            if (!OtaConfig.online(app)) {
                note("没有网络，稍后再试");
                return;
            }
            note("正在检查更新");
            OtaManifest manifest = OtaNet.manifest(cancel);
            prefs.edit().putLong(KEY_CHECKED, now).apply();
            long installed = OtaFiles.installedVersionCode(app);
            if (manifest.versionCode <= installed) {
                OtaFiles.clearDownload(app);
                note("已是最新 " + installed);
                return;
            }
            if (readyOrNull(manifest) != null) {
                note("已下载 " + manifest.label() + "，点安装后系统还会再确认");
                return;
            }
            if (!manual && !OtaConfig.unmetered(app)) {
                note("发现 " + manifest.label() + "，等非计费网络再自动下载");
                return;
            }
            download(manifest);
        } catch (Exception ex) {
            note(OtaFiles.userNote(ex == null ? null : ex.getMessage()));
        } finally {
            percent = -1;
            busy.set(false);
        }
    }

    /** 已下载且与这次 offer 完全对得上；否则清掉旧包，返回 null。 */
    private File readyOrNull(OtaManifest manifest) throws IOException {
        File apk = OtaFiles.ready(app);
        OtaFiles.State state = OtaFiles.loadState(app);
        if (state != null && state.matches(manifest) && state.verified && apk.isFile()
                && apk.length() == manifest.size && manifest.sha256.equals(OtaFiles.sha256(apk))) {
            return apk;
        }
        OtaFiles.clearDownload(app);
        return null;
    }

    private void download(OtaManifest manifest) throws IOException {
        File partial = OtaFiles.partial(app);
        note("正在下载 " + manifest.label());
        OtaNet.download(manifest, partial, cancel, written -> {
            int progress = (int) Math.min(99L, written * 100L / manifest.size);
            if (progress != percent) percent = progress;
        });
        if (!manifest.sha256.equals(OtaFiles.sha256(partial))) {
            OtaFiles.deleteQuietly(partial);
            throw new IOException("sha256 mismatch");
        }
        OtaFiles.commitDownload(app, manifest);
        percent = 100;
        note("已下载 " + manifest.label() + "，点安装后系统还会再确认");
    }

    // ------------------------------------------------------------------ 状态

    void note(String text) {
        line = text;
        prefs.edit().putString(KEY_LINE, text).apply();
    }

    /** 进程重启后，把上次的下载结果显示出来，让宿主前台直接提示。 */
    private void recall() {
        try {
            OtaFiles.State state = OtaFiles.loadState(app);
            File apk = OtaFiles.ready(app);
            if (state == null || !state.verified || !apk.isFile() || apk.length() != state.size) return;
            if (state.versionCode <= OtaFiles.installedVersionCode(app)) {
                OtaFiles.clearDownload(app);
                return;
            }
            line = "已下载 " + state.label() + "，点安装后系统还会再确认";
        } catch (IOException | RuntimeException ignored) {
        }
    }
}
