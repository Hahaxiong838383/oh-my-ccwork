package cc.hahaxiong.xiaoke.night;

import android.Manifest;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;

/**
 * JobScheduler 调度封装（可联网、跨重启持久化、幂等不重复重置周期）。
 *
 * 两条 Job：
 * - JOB_ID_PERIODIC：15 分钟周期任务（NETWORK_TYPE_ANY），负责兜底回传与长期保活；
 * - JOB_ID_FLUSH：一次性联网任务（NETWORK_TYPE_ANY + 指数退避），在有待回传事件时尽快补发。
 * 若清单声明了 RECEIVE_BOOT_COMPLETED，则自动开启 setPersisted(true) 跨重启恢复；
 * 否则优雅降级为 setPersisted(false)，不抛异常。
 */
final class NightDiagScheduler {

    static final int JOB_ID_PERIODIC = 0x4E440001;
    static final int JOB_ID_FLUSH = 0x4E440002;

    private static final long PERIODIC_INTERVAL_MS = 15L * 60L * 1000L;
    private static final long FLUSH_MIN_LATENCY_MS = 5L * 1000L;
    private static final long BACKOFF_INITIAL_MS = 30L * 1000L;

    private NightDiagScheduler() {
    }

    /** 注册周期任务；若当前存在待回传事件，一并确保一次性联网任务已排入。 */
    static boolean schedule(Context context, boolean hasPending) {
        if (context == null) {
            return false;
        }
        Context app = context.getApplicationContext();
        if (app == null) {
            app = context;
        }
        boolean periodicOk = ensurePeriodic(app);
        if (hasPending) {
            schedulePendingFlush(app);
        }
        return periodicOk;
    }

    static boolean ensurePeriodic(Context app) {
        JobScheduler jobs = getScheduler(app);
        if (jobs == null) {
            return false;
        }
        try {
            if (jobs.getPendingJob(JOB_ID_PERIODIC) != null) {
                return true;
            }
            boolean persist = canPersist(app);
            if (schedulePeriodicInternal(jobs, app, persist)) {
                return true;
            }
            return persist && schedulePeriodicInternal(jobs, app, false);
        } catch (Throwable ignored) {
            return false;
        }
    }

    static boolean schedulePendingFlush(Context app) {
        JobScheduler jobs = getScheduler(app);
        if (jobs == null) {
            return false;
        }
        try {
            if (jobs.getPendingJob(JOB_ID_FLUSH) != null) {
                return true;
            }
            boolean persist = canPersist(app);
            if (scheduleFlushInternal(jobs, app, persist)) {
                return true;
            }
            return persist && scheduleFlushInternal(jobs, app, false);
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static boolean schedulePeriodicInternal(JobScheduler jobs, Context app, boolean persist) {
        try {
            JobInfo info = new JobInfo.Builder(
                    JOB_ID_PERIODIC,
                    new ComponentName(app, NightDiagnosticsJobService.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(PERIODIC_INTERVAL_MS)
                    .setPersisted(persist)
                    .build();
            return jobs.schedule(info) == JobScheduler.RESULT_SUCCESS;
        } catch (IllegalArgumentException | SecurityException ex) {
            return false;
        }
    }

    private static boolean scheduleFlushInternal(JobScheduler jobs, Context app, boolean persist) {
        try {
            JobInfo info = new JobInfo.Builder(
                    JOB_ID_FLUSH,
                    new ComponentName(app, NightDiagnosticsJobService.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setMinimumLatency(FLUSH_MIN_LATENCY_MS)
                    .setBackoffCriteria(BACKOFF_INITIAL_MS, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                    .setPersisted(persist)
                    .build();
            return jobs.schedule(info) == JobScheduler.RESULT_SUCCESS;
        } catch (IllegalArgumentException | SecurityException ex) {
            return false;
        }
    }

    private static JobScheduler getScheduler(Context app) {
        try {
            return (JobScheduler) app.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static boolean canPersist(Context app) {
        try {
            return app.checkSelfPermission(Manifest.permission.RECEIVE_BOOT_COMPLETED)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable ignored) {
            return false;
        }
    }
}
