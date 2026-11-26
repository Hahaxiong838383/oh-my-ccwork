package cc.hahaxiong.xiaoke.night;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * 持久定期联网检查。setPersisted(true) 让任务跨重启存活，进程被杀也还在。
 * 任务只做检查和下载，永远不安装。
 */
public final class OtaJobService extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        return NightOta.get(this).onJob(this, params);
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        NightOta.get(this).stopJob();
        return false;
    }

    /** 幂等：已经有同 id 的待执行任务就不重复排。 */
    static void ensureSchedule(Context context) {
        try {
            JobScheduler scheduler = context.getSystemService(JobScheduler.class);
            if (scheduler == null) return;
            if (scheduler.getPendingJob(OtaContract.JOB_ID) != null) return;
            JobInfo job = new JobInfo.Builder(OtaContract.JOB_ID, new ComponentName(context, OtaJobService.class))
                    .setPeriodic(OtaContract.PERIOD_MS)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setRequiresStorageNotLow(true)
                    .setPersisted(true)
                    .build();
            scheduler.schedule(job);
        } catch (RuntimeException ignored) {
        }
    }
}
