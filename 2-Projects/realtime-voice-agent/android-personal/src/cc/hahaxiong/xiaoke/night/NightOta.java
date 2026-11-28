package cc.hahaxiong.xiaoke.night;

import android.app.Activity;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.io.File;
import java.io.IOException;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/** The activity, scheduled job and installer receiver share one durable update state. */
public final class NightOta {
    private static final String PREFS = "night_ota";
    static final int CONFIRM_REQUEST = 52314;
    private static NightOta instance;
    private final Context app;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final OtaNet.Cancel cancel = new OtaNet.Cancel();
    private final long installed;
    private final String installedName;
    private volatile WeakReference<NightHostActivity> resumed = new WeakReference<>(null);
    private boolean fetching;
    private boolean jobFetch;
    private String state, message, targetName, digest;
    private long target, total, downloaded, updatedAt, lastProgress;
    private boolean cached;
    private int session, launched = -1;

    private NightOta(Context app) {
        this.app = app;
        prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        installed = OtaFiles.installedVersionCode(app);
        String name = "";
        try {
            PackageInfo info = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            if (info.versionName != null) name = info.versionName;
        } catch (PackageManager.NameNotFoundException ignored) {}
        installedName = name;
        state = prefs.getString("state", "idle");
        message = prefs.getString("line", "尚未检查更新");
        targetName = prefs.getString("targetName", "");
        digest = prefs.getString("offerHash", "");
        target = prefs.getLong("target", 0);
        total = prefs.getLong("total", 0);
        downloaded = prefs.getLong("bytes", 0);
        updatedAt = prefs.getLong("updatedAt", 0);
        session = prefs.getInt("session", -1);
        recover();
    }

    static synchronized NightOta get(Context context) {
        if (instance == null) instance = new NightOta(context.getApplicationContext());
        return instance;
    }
    public static void enter(Activity a) {
        NightOta ota = get(a);
        OtaJobService.ensureSchedule(a);
        if (!ota.welcomeOnOpen()) ota.fetch(false, true, null, null);
    }
    public static void check(Activity a) { get(a).fetch(true, false, null, null); }
    public static void install(Activity a) { get(a).installOnGesture(a); }
    public static String status(Context c) {
        JSONObject snapshot = snapshot(c);
        return snapshot.optString("message") + ("downloading".equals(snapshot.optString("state"))
                ? " " + snapshot.optInt("percent", 0) + "%" : "");
    }
    public static JSONObject snapshot(Context c) { return get(c).json(); }

    private synchronized boolean welcomeOnOpen() {
        if (target > installed || fetching || installFlow()
                || prefs.getLong("updatedBuild", 0) != installed
                || prefs.getLong("seenBuild", 0) == installed) return false;
        if (!"success".equals(state)) {
            target = installed;
            targetName = installedName;
            show("success", "已更新至 " + installedName);
        }
        return true;
    }

    synchronized JSONObject pageSnapshot(NightHostActivity activity) {
        if (state.equals("success") && resumed.get() == activity
                && prefs.getLong("updatedBuild", 0) == installed
                && prefs.getLong("seenBuild", 0) != installed) {
            prefs.edit().putLong("seenBuild", installed).apply();
        }
        return json();
    }

    private boolean inCall() {
        NightHostActivity a = resumed.get();
        return (a != null && a.isInVoiceCall()) || OtaConfig.inCall(app);
    }
    private boolean installFlow() {
        return state.equals("wait_permission") || state.equals("preparing_install")
                || state.equals("pending_confirmation") || state.equals("installing");
    }
    private synchronized JSONObject json() {
        int percent = total <= 0 ? -1 : (int)Math.min(100L, downloaded * 100L / total);
        boolean busy = state.equals("checking") || state.equals("downloading") || state.equals("verifying")
                || state.equals("preparing_install") || state.equals("installing") || state.equals("pending_confirmation");
        JSONObject o = new JSONObject();
        try {
            o.put("state", state).put("message", message).put("updatedAt", updatedAt)
             .put("installedVersionCode", installed).put("installedVersionName", installedName)
             .put("versionCode", target).put("versionName", targetName)
             .put("downloadedBytes", downloaded).put("totalBytes", total).put("percent", percent)
             .put("canInstall", cached && !busy && !inCall())
             .put("canRetry", !busy && !installFlow() && !cached)
             .put("busy", busy).put("installPermission", OtaConfig.canInstall(app));
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
        return o;
    }

    private synchronized void show(String next, String text) {
        state = next; message = text; updatedAt = System.currentTimeMillis();
        SharedPreferences.Editor edit = prefs.edit().putString("state", next).putString("line", text)
                .putLong("target", target).putString("targetName", targetName).putString("offerHash", digest)
                .putLong("bytes", downloaded).putLong("total", total).putLong("updatedAt", updatedAt)
                .putInt("session", session);
        // Switching the unknown-source toggle may kill this process immediately.
        if (next.equals("success")) edit.putLong("updatedBuild", target);
        if (installFlow() || next.equals("success") || next.equals("cancelled")) edit.commit();
        else edit.apply();
        NightHostActivity activity = resumed.get();
        if (activity != null) activity.notifyUpdateChanged();
        try { OtaNotifications.update(app, json()); }
        catch (RuntimeException ignored) { /* The durable state remains available in the app. */ }
    }

    private boolean hasSession() {
        return session >= 0 && app.getPackageManager().getPackageInstaller().getSessionInfo(session) != null;
    }
    private void abandonTrackedSession() {
        if (session >= 0) {
            try { app.getPackageManager().getPackageInstaller().abandonSession(session); }
            catch (RuntimeException ignored) {}
        }
        session = -1; launched = -1;
    }
    private synchronized void recover() {
        try {
            OtaFiles.State offer = OtaFiles.loadState(app);
            if (offer != null && offer.verified) {
                // Includes verified state.txt from releases before structured progress existed.
                target = offer.versionCode; targetName = offer.versionName; total = offer.size; digest = offer.sha256;
                File file = OtaFiles.ready(app);
                cached = file.isFile() && file.length() == total;
            }
            if (state.equals("success") && target == installed) return;
            if (target > 0 && target == installed && (cached || installFlow())) {
                installed(); return;
            }
            if (!prefs.contains("state") && target == 0 && "系统已完成安装".equals(message)) {
                PackageInfo info = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
                if (info.lastUpdateTime > info.firstInstallTime) {
                    target = installed; targetName = installedName; installed(); return;
                }
            }
            if (target <= installed && target > 0) {
                cached = false; OtaFiles.clearDownload(app);
            }
            if (cached) {
                downloaded = total;
                if (state.equals("wait_permission")) return;
                if (state.equals("pending_confirmation") && hasSession()) return;
                if ((state.equals("preparing_install") || state.equals("installing")) && hasSession()) {
                    PackageInstaller.SessionInfo info = app.getPackageManager().getPackageInstaller().getSessionInfo(session);
                    if (info != null && info.isSealed()) {
                        if (state.equals("preparing_install")) {
                            // The process that handed off the APK may have lost its confirmation intent.
                            show("ready", "安装包已保留，可重新打开系统安装窗口");
                        }
                        return;
                    }
                }
                if (state.equals("cancelled") || state.equals("error")) return;
                abandonTrackedSession();
                show("ready", "新版本已下载并通过校验，可安装 " + targetName);
            } else if (state.equals("downloading") || state.equals("verifying") || state.equals("checking") || installFlow()) {
                downloaded = OtaFiles.partial(app).length();
                abandonTrackedSession();
                show(target > installed ? "available" : "idle", target > installed ? "上次更新中断，可继续下载" : "可以重新检查更新");
            }
        } catch (IOException | RuntimeException | PackageManager.NameNotFoundException ignored) {}
    }
    private synchronized void installed() {
        session = -1; launched = -1; cached = false; downloaded = total;
        show("success", "已更新至 " + installedName);
        OtaFiles.clearDownload(app);
    }
    static void replaced(Context c) {
        NightOta ota = get(c);
        synchronized (ota) {
            // This private system broadcast only fires on replacement, including updates
            // started by older releases that delete their verified state before our launch.
            if (ota.target <= ota.installed && (ota.prefs.getLong("updatedBuild", 0) != ota.installed
                    || !ota.state.equals("success"))) {
                ota.target = ota.installed; ota.targetName = ota.installedName;
                ota.installed();
            }
        }
    }

    static void resumed(NightHostActivity activity) {
        NightOta ota = get(activity);
        ota.resumed = new WeakReference<>(activity);
        ota.resumeInstall(activity);
        activity.notifyUpdateChanged();
    }
    static void paused(NightHostActivity activity) {
        NightOta ota = get(activity);
        if (ota.resumed.get() == activity) ota.resumed.clear();
    }
    private synchronized void resumeInstall(Activity a) {
        if (state.equals("wait_permission") && cached && !inCall()) {
            if (OtaConfig.canInstall(app)) beginInstall();
            else main.postDelayed(() -> {
                synchronized (NightOta.this) {
                    if (resumed.get() != a || !state.equals("wait_permission") || !cached) return;
                    if (OtaConfig.canInstall(app) && !inCall()) beginInstall();
                    else show("ready", "安装包已保留，可再次点安装并授权");
                }
            }, 850);
            return;
        }
        // Android can kill the process while its installer UI owns the screen.
        // A lost confirmation intent is never replayed; a fresh gesture can start another.
        if (state.equals("pending_confirmation") && launched != session && cached) {
            // Do not abandon a committed system session until the user explicitly retries.
            show("ready", "系统安装窗口已关闭，若仍需确认可再次点安装");
        } else if (state.equals("installing") && !hasSession() && cached) {
            session = -1;
            show("ready", "尚未完成升级，点安装可重试");
        }
    }
    private synchronized void installOnGesture(Activity a) {
        if (a == null || a.isFinishing() || resumed.get() != a || inCall() || fetching || !cached) return;
        if (installFlow() && !state.equals("wait_permission")) return;
        if (!OtaConfig.canInstall(app)) {
            show("wait_permission", "请允许安装未知应用，返回后会继续安装");
            if (!OtaConfig.openInstallSettings(a)) show("error", "无法打开授权页，可在系统设置中允许安装未知应用后重试");
            return;
        }
        beginInstall();
    }
    private synchronized void beginInstall() {
        if (!cached || resumed.get() == null || inCall() || state.equals("preparing_install")) return;
        abandonTrackedSession();
        show("preparing_install", "正在复核安装包并提交给系统");
        worker.execute(() -> {
            try { OtaInstall.install(app, this); }
            catch (Exception ex) {
                synchronized (NightOta.this) {
                    abandonTrackedSession();
                    String reason = ex.getMessage();
                    if (invalidPackage(reason)) {
                        OtaFiles.clearDownload(app); cached = false; downloaded = 0;
                    }
                    show("error", "install paused".equals(reason) ? "安装包已保留，通话结束后可重试" : OtaFiles.userNote(reason));
                }
            }
        });
    }
    private static boolean invalidPackage(String why) {
        return "package".equals(why) || "signer".equals(why) || "version".equals(why)
                || "length".equals(why) || "sha256".equals(why) || "manifest".equals(why);
    }

    synchronized void trackSession(int id) throws IOException {
        if (resumed.get() == null || inCall()) throw new IOException("install paused");
        session = id;
        show("preparing_install", "正在向系统安装器写入安装包");
    }
    synchronized void submitting(int id) throws IOException {
        if (id != session || resumed.get() == null || inCall()) throw new IOException("install paused");
        show("preparing_install", "已提交安装包，等待系统确认窗口");
    }
    synchronized void installCallback(int id, int result, Intent confirm) {
        if (id < 0 || id != session) return;
        if (result == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            if (launched == id) return;
            Activity a = resumed.get();
            if (a == null || a.isFinishing() || inCall() || confirm == null) {
                abandonTrackedSession();
                show("ready", "安装包已保留，回到应用后点安装");
                return;
            }
            launched = id;
            show("pending_confirmation", "请在系统界面确认安装");
            try { a.startActivityForResult(confirm, CONFIRM_REQUEST); }
            catch (RuntimeException e) {
                abandonTrackedSession(); show("error", "未能打开系统安装界面，可重试");
            }
        } else if (result == PackageInstaller.STATUS_SUCCESS) {
            // Some devices deliver the callback before the new process is launched.
            session = -1; launched = -1;
            if (OtaFiles.installedVersionCode(app) == target) {
                cached = false; downloaded = total;
                show("success", "已更新至 " + targetName);
                OtaFiles.clearDownload(app);
            } else show("installing", "系统正在完成安装");
        } else {
            session = -1; launched = -1;
            boolean cancelled = result == PackageInstaller.STATUS_FAILURE_ABORTED;
            show(cancelled ? "cancelled" : "error", cancelled ? "已取消安装，安装包已保留" : "系统安装失败，安装包已保留，可重试");
        }
    }
    static void confirmationReturned(Activity a, int result) {
        NightOta ota = get(a);
        synchronized (ota) {
            if (!ota.state.equals("pending_confirmation")) return;
            if (result == Activity.RESULT_OK) {
                ota.show("installing", "已确认，系统正在安装");
            } else {
                // Some package installers return RESULT_CANCELED even after accepting.
                // Prefer the authoritative session broadcast, or recover a vanished session.
                int id = ota.session;
                ota.main.postDelayed(() -> {
                    synchronized (ota) {
                        if (ota.session == id && ota.state.equals("pending_confirmation")) {
                            ota.launched = -1;
                            if (!ota.hasSession()) {
                                ota.session = -1;
                                ota.show("cancelled", "已退出系统安装，安装包已保留");
                            } else {
                                // A callback may still be in flight. Keep its id so late success wins.
                                ota.show("ready", "系统安装窗口已返回，可再次点安装");
                            }
                        }
                    }
                }, 1200);
            }
        }
    }

    private synchronized boolean fetch(boolean manual, boolean throttle, JobService job, JobParameters params) {
        if (fetching || installFlow()) return false;
        if (!manual && state.equals("success") && System.currentTimeMillis() - updatedAt < OtaContract.FOREGROUND_GAP_MS) return false;
        long elapsed = System.currentTimeMillis() - prefs.getLong("checked", 0);
        if (throttle && elapsed >= 0 && elapsed < OtaContract.FOREGROUND_GAP_MS
                && !state.equals("available") && !state.equals("error")) return false;
        fetching = true; jobFetch = job != null; cancel.reset();
        worker.execute(() -> {
            try { run(manual); }
            finally {
                synchronized (NightOta.this) { fetching = false; jobFetch = false; }
                if (job != null) job.jobFinished(params, false);
            }
        });
        return true;
    }
    boolean onJob(JobService job, JobParameters params) { return fetch(false, false, job, params); }
    synchronized void stopJob() { if (jobFetch) cancel.stop(); }

    private void run(boolean manual) {
        String previousState, previousMessage;
        synchronized (this) { previousState = state; previousMessage = message; }
        try {
            if (!OtaConfig.online(app)) throw new IOException("offline");
            show("checking", "正在检查新版本");
            OtaManifest manifest = OtaNet.manifest(cancel);
            prefs.edit().putLong("checked", System.currentTimeMillis()).apply();
            synchronized (this) {
                if (manifest.versionCode <= installed) {
                    cached = false; OtaFiles.clearDownload(app);
                    target = manifest.versionCode; targetName = manifest.versionName; total = downloaded = 0;
                    show("current", "当前已是最新版本 " + installedName); return;
                }
                if (manifest.versionCode != target || !manifest.sha256.equals(digest) || total != manifest.size) {
                    OtaFiles.clearDownload(app); cached = false; downloaded = 0;
                }
                target = manifest.versionCode; targetName = manifest.versionName; digest = manifest.sha256; total = manifest.size;
                if (cached && OtaFiles.ready(app).isFile()) {
                    if (!manual && previousState.equals("cancelled")) {
                        show(previousState, previousMessage);
                    } else show("ready", "新版本已下载并通过校验，可安装 " + targetName);
                    return;
                }
                cached = false; downloaded = OtaFiles.partial(app).length();
                if (!manual && !OtaConfig.unmetered(app)) {
                    show("available", "发现新版本，连接非计费网络将自动下载"); return;
                }
                show("downloading", "正在下载 " + targetName);
            }
            File partial = OtaFiles.partial(app);
            OtaNet.download(manifest, partial, cancel, bytes -> {
                synchronized (NightOta.this) {
                    downloaded = bytes;
                    long now = SystemClock.elapsedRealtime();
                    if (now - lastProgress >= 250 || bytes == manifest.size) {
                        lastProgress = now;
                        show("downloading", "正在下载 " + targetName);
                    }
                }
            });
            show("verifying", "正在校验文件、版本和签名");
            if (!manifest.sha256.equals(OtaFiles.sha256(partial))) {
                OtaFiles.deleteQuietly(partial); throw new IOException("sha256 mismatch");
            }
            try { OtaFiles.commitDownload(app, manifest); }
            catch (IOException ex) {
                if (invalidPackage(ex.getMessage())) OtaFiles.deleteQuietly(partial);
                throw ex;
            }
            synchronized (this) { cached = true; downloaded = total; show("ready", "新版本已下载并通过校验，可安装 " + targetName); }
        } catch (Exception ex) {
            String why = ex.getMessage();
            show("error", "offline".equals(why) ? "未连接网络，恢复网络后可重试" : OtaFiles.userNote(why));
        }
    }
}
