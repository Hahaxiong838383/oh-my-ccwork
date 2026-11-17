export function weeklyWire() {
  return {
    calculation_version: 'weekly_guard_v1', timezone: 'Asia/Shanghai', week_start: '2026-11-16', week_end: '2026-11-22',
    report_id: 'weekly-c-20261116', status: 'revised', revision: 2, published_at_ms: 1795356000000,
    updated_at_ms: 1795446000000, generated_at_ms: 1795446000000, scheduled_publish_at_ms: 1795356000000, period_end_ms: 1795363200000, data_cutoff_at_ms: 1795446000000,
    scope: { kind: 'device', public_id: 'dev_c' },
    metrics: {
      posture_reminders: { available: true, reason: 'partial_history', updated_at_ms: 1794908400000, value: 0 },
      usage: { available: true, reason: 'partial_history', updated_at_ms: 1794908400000, total_seconds: 10829, daily_average_seconds: 1547, denominator_days: 7, source: 'telemetry.focus_segment', supplemental_seconds: 2148, combined_seconds: 12977 },
      active_days: { available: true, reason: 'partial_history', updated_at_ms: 1794908400000, value: 1, threshold_seconds: 300 },
    },
    daily: [
      { date: '2026-11-16', observed_seconds: null, supplemental_seconds: 902, combined_seconds: 902, longest_continuous_seconds: null, active: null, posture_count: null, posture_available: false, usage_available: false, updated_at_ms: 1794908400000, reason: 'no_focus_segments' },
      { date: '2026-11-17', observed_seconds: 10829, supplemental_seconds: 1246, combined_seconds: 12075, longest_continuous_seconds: 715.516, active: true, posture_count: 0, posture_available: true, usage_available: true, updated_at_ms: 1794908400000, reason: 'partial_history' },
    ],
    coverage: { complete: false, reason: 'partial_history', observed_days: 1, missing_dates: ['2026-11-16'], pending_dates: ['2026-11-18'], invalid_event_count: 0, supplemental_available: true },
    source_updated_at_ms: 1794908400000,
  };
}
