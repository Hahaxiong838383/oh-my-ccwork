package cc.hahaxiong.xiaoke.night;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.provider.Settings;

/** 运行环境判定：联网、计费网络、通话中、未知来源安装许可。全部免运行时权限。 */
final class OtaConfig {
    private OtaConfig() {}

    static boolean online(Context context) {
        NetworkCapabilities caps = capabilities(context);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    /** 非计费网络才自动下载；手动检查不受限。 */
    static boolean unmetered(Context context) {
        NetworkCapabilities caps = capabilities(context);
        return caps != null
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
    }

    private static NetworkCapabilities capabilities(Context context) {
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        if (manager == null) return null;
        Network network = manager.getActiveNetwork();
        if (network == null) return null;
        return manager.getNetworkCapabilities(network);
    }

    /**
     * 通话中（含 VoLTE 与第三方语音）不弹系统安装确认，避免打断通话。
     * AudioManager 模式读取不需要任何权限。
     */
    static boolean inCall(Context context) {
        AudioManager audio = context.getSystemService(AudioManager.class);
        if (audio == null) return false;
        int mode = audio.getMode();
        return mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
                || mode == AudioManager.MODE_RINGTONE;
    }

    /** 未知来源安装许可（API 26+ 为按应用授权）。 */
    static boolean canInstall(Context context) {
        return context.getPackageManager().canRequestPackageInstalls();
    }

    /** 打开“安装未知应用”里本应用那一条；打不开就只剩提示。 */
    static void openInstallSettings(Activity activity) {
        try {
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
        } catch (RuntimeException ignored) {
        }
    }
}
