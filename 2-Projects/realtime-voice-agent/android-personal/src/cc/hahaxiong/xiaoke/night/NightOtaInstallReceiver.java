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
        NightOta ota = NightOta.get(context);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            if (!ota.takeInstallGesture()) {
                ota.note("安装确认已过期，请再点一次安装");
                return;
            }
            if (OtaConfig.inCall(context)) {
                ota.note("正在通话，等通话结束再点安装");
                return;
            }
            Intent confirm = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                    : getIntentLegacy(intent);
            if (confirm == null) {
                ota.note("系统安装确认没有打开，可以再点一次安装");
                return;
            }
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                context.startActivity(confirm);
            } catch (RuntimeException ex) {
                ota.note("系统安装确认没有打开，可以再点一次安装");
            }
            return;
        }
        if (status == PackageInstaller.STATUS_SUCCESS) {
            ota.onInstalled();
        } else {
            ota.note("系统没有完成安装，安装包还在，没有自动重试");
        }
    }

    @SuppressWarnings("deprecation")
    private static Intent getIntentLegacy(Intent intent) {
        return intent.getParcelableExtra(Intent.EXTRA_INTENT);
    }
}
