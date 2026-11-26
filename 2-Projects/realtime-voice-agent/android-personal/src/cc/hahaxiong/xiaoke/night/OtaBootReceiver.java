package cc.hahaxiong.xiaoke.night;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 开机 / 自身更新后补排一次持久任务。任务本身已 setPersisted，这里只是修复路径。 */
public final class OtaBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        OtaJobService.ensureSchedule(context);
    }
}
