package cc.hahaxiong.xiaoke.night;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONObject;

/** Mirrors the same native snapshot used by the update panel. */
final class OtaNotifications {
    static final String OPEN = "cc.hahaxiong.xiaoke.night.OPEN_UPDATE";
    private static final String CHANNEL = "night_updates";
    private static final int PROGRESS = 11261;
    private static final int RESULT = 11262;

    private OtaNotifications() {}

    static void update(Context app, JSONObject snapshot) {
        NotificationManager manager = app.getSystemService(NotificationManager.class);
        if (manager == null || !manager.areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 33 && app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return;
        String state = snapshot.optString("state");
        String title;
        boolean ongoing = false;
        switch (state) {
            case "downloading": title = "正在下载小可更新"; ongoing = true; break;
            case "verifying": title = "正在校验安装包"; ongoing = true; break;
            case "available": title = "发现小可新版本"; break;
            case "ready": title = "小可已下载，可以安装"; break;
            case "wait_permission": title = "等待安装权限"; break;
            case "preparing_install": title = "正在准备安装"; ongoing = true; break;
            case "pending_confirmation": title = "等待系统确认安装"; break;
            case "installing": title = "系统正在安装小可"; ongoing = true; break;
            case "success": title = "小可更新完成"; break;
            case "cancelled": title = "小可安装已取消"; break;
            case "error":
                if (snapshot.optLong("versionCode") <= 0) {
                    manager.cancel(PROGRESS);
                    return;
                }
                title = "小可更新未完成"; break;
            case "checking": return;
            default: manager.cancel(PROGRESS); manager.cancel(RESULT); return;
        }
        if (manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "应用更新", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(app, NightHostActivity.class).setAction(OPEN)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent intent = PendingIntent.getActivity(app, RESULT, open, PendingIntent.FLAG_IMMUTABLE);
        String line = snapshot.optString("message");
        Notification.Builder note = new Notification.Builder(app, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(title).setContentText(line)
                .setStyle(new Notification.BigTextStyle().bigText(line))
                .setOnlyAlertOnce(true).setShowWhen(false)
                .setAutoCancel(!ongoing).setOngoing(ongoing).setContentIntent(intent);
        if (ongoing) {
            int percent = snapshot.optInt("percent", -1);
            boolean known = "downloading".equals(state) && percent >= 0;
            note.setProgress(100, known ? Math.min(100, percent) : 0, !known);
        }
        manager.cancel(ongoing ? RESULT : PROGRESS);
        manager.notify(ongoing ? PROGRESS : RESULT, note.build());
    }
}
