package cc.hahaxiong.xiaoke.night;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 只做一件事：把已复核的自有 APK 交给系统安装器，并要求用户确认。
 * 绝不静默安装；系统确认界面由 NightOtaInstallReceiver 在用户刚点击后的手势窗口内拉起。
 */
final class OtaInstall {
    private OtaInstall() {}

    static void install(Context context, NightOta ota) throws IOException {
        Context app = context.getApplicationContext() == null ? context : context.getApplicationContext();
        if (!OtaConfig.canInstall(app)) throw new IOException("install permission");
        File apk = OtaFiles.ready(app);
        OtaFiles.State state = OtaFiles.loadState(app);
        if (state == null || !state.verified) throw new IOException("manifest");
        String problem = OtaFiles.identity(app, apk, state);
        if (problem != null) throw new IOException(problem);

        PackageInstaller installer = app.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(OtaContract.PACKAGE);
        params.setSize(apk.length());
        params.setInstallReason(PackageManager.INSTALL_REASON_USER);
        if (android.os.Build.VERSION.SDK_INT >= 31) requireUserAction(params);
        int sessionId = installer.createSession(params);
        boolean committed = false;
        try (PackageInstaller.Session session = installer.openSession(sessionId);
             InputStream in = new FileInputStream(apk)) {
            ota.trackSession(sessionId);
            try (OutputStream out = session.openWrite("base.apk", 0L, apk.length())) {
                byte[] buffer = new byte[OtaContract.BUFFER];
                int size;
                while ((size = in.read(buffer)) >= 0) out.write(buffer, 0, size);
                session.fsync(out);
            }
            Intent callback = new Intent(app, NightOtaInstallReceiver.class).setAction(NightOtaInstallReceiver.ACTION)
                    .putExtra("nightSession", sessionId);
            PendingIntent pending = PendingIntent.getBroadcast(app, sessionId, callback,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            ota.submitting(sessionId);
            session.commit(pending.getIntentSender());
            committed = true;
        } finally {
            if (!committed) {
                try {
                    installer.abandonSession(sessionId);
                } catch (RuntimeException ignored) {
                }
            }
        }
    }

    @SuppressWarnings("deprecation")
    private static void requireUserAction(PackageInstaller.SessionParams params) {
        params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
    }
}
