package cc.hahaxiong.xiaoke.night;

import android.app.job.JobParameters;
import android.app.job.JobService;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 后台联网诊断回传 JobService。
 *
 * 需在 AndroidManifest.xml 的 <application> 中注册：
 * <service
 *     android:name=".NightDiagnosticsJobService"
 *     android:exported="false"
 *     android:permission="android.permission.BIND_JOB_SERVICE" />
 */
public final class NightDiagnosticsJobService extends JobService {

    private final AtomicBoolean stopped = new AtomicBoolean(false);

    @Override
    public boolean onStartJob(final JobParameters params) {
        if (params == null) {
            return false;
        }
        stopped.set(false);
        final int jobId = params.getJobId();
        NightDiagnostics.flushFromJob(this, new NightDiagSync.Completion() {
            @Override
            public void onDone(boolean retryableFailure, boolean hasRemaining) {
                if (stopped.get()) {
                    return;
                }
                // 周期任务由系统按周期自动续排；仅一次性补发任务在可重试失败且仍有待发数据时请求退避重排
                boolean needsReschedule = (jobId == NightDiagScheduler.JOB_ID_FLUSH)
                        && retryableFailure
                        && hasRemaining;
                try {
                    jobFinished(params, needsReschedule);
                } catch (Throwable ignored) {
                }
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        stopped.set(true);
        NightDiagnostics.abortInflight(this);
        if (params == null) {
            return false;
        }
        return params.getJobId() == NightDiagScheduler.JOB_ID_FLUSH
                && NightDiagnostics.pendingCount(this) > 0;
    }
}
