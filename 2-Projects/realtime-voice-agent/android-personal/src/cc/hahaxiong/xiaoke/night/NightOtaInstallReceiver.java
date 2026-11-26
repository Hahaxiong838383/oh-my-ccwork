package cc.hahaxiong.xiaoke.night;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

/**
 * 系统安装器回调。只有用户刚点过“安装”的手势窗口内，才拉起系统确认界面；
 * 通话中不拉起，避免打断通话。
 */
public final class NightOtaInstallReceiver extends BroadcastReceiver {
    static final String ACTION = "cc.hahaxiong.xiaoke.night.OTA_INSTALL";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null || !ACTION.equals(intent.getAction())) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        int session = intent.getIntExtra("nightSession", intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1));
        Intent confirm = null;
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            confirm = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class) : getIntentLegacy(intent);
        }
        NightOta.get(context).installCallback(session, status, confirm);
    }

    @SuppressWarnings("deprecation")
    private static Intent getIntentLegacy(Intent intent) {
        return intent.getParcelableExtra(Intent.EXTRA_INTENT);
    }
}
