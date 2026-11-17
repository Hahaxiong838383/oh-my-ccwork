import { ApiError, apiRequest } from './api';

export type WeeklyMetric = { available: boolean; reason: string; updatedAtMs: number | null };
export type WeeklyDay = { date: string; observedSeconds: number | null; supplementalSeconds: number | null; combinedSeconds: number | null; longestContinuousSeconds: number | null; active: boolean | null; postureCount: number | null; postureAvailable: boolean; usageAvailable: boolean; updatedAtMs: number | null; reason: string };
export type WeeklyReport = {
  calculationVersion: string; timezone: string; weekStart: string; weekEnd: string;
  reportId: string; status: 'collecting' | 'published' | 'revised'; revision: number;
  publishedAtMs: number | null; updatedAtMs: number; generatedAtMs: number; scheduledPublishAtMs: number; periodEndMs: number; dataCutoffAtMs: number;
  scope: { kind: 'device'; publicId: string };
  metrics: {
    postureReminders: WeeklyMetric & { value: number | null; referenceMax?: number | null; aboveReferenceMax?: boolean };
    usage: WeeklyMetric & { totalSeconds: number | null; dailyAverageSeconds: number | null; denominatorDays: number | null; source: string; supplementalSeconds: number | null; combinedSeconds: number | null };
    activeDays: WeeklyMetric & { value: number | null; thresholdSeconds: number | null };
  };
  daily: WeeklyDay[];
  coverage: { complete: boolean; reason: string; observedDays: number | null; missingDates: string[]; pendingDates: string[]; invalidEventCount: number | null; supplementalAvailable: boolean };
  sourceUpdatedAtMs: number | null;
};
export type WeeklyState = { weekStart: string; report: WeeklyReport | null; busy: boolean; error: string; loaded: boolean };
const dayMs = 86400000;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const integer = (value: unknown): number | null => number(value) !== null && Number.isInteger(value) ? value as number : null;
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const dates = (value: unknown): string[] => Array.isArray(value) ? value.filter(validDate) : [];
const invalid = () => new ApiError(502, { error: 'invalid_weekly_report' });
/** A valid 200 response may deliberately withhold the new report while retaining legacy fields. */
export class WeeklyReportUnavailableError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'WeeklyReportUnavailableError'; }
}

/** Calendar navigation only. All business metrics come from the server report. */
export function beijingWeekStart(now = Date.now()): string {
  const local = new Date(now + 8 * 3600000);
  local.setUTCDate(local.getUTCDate() - (local.getUTCDay() + 6) % 7);
  return local.toISOString().slice(0, 10);
}
export function shiftWeek(weekStart: string, weeks: number): string {
  if (!validDate(weekStart) || !Number.isInteger(weeks)) throw invalid();
  return new Date(Date.parse(`${weekStart}T00:00:00Z`) + weeks * 7 * dayMs).toISOString().slice(0, 10);
}
function metric(value: unknown, valid: boolean): WeeklyMetric {
  const row = object(value);
  return { available: row.available === true && valid, reason: row.available === true && !valid ? 'invalid_response' : text(row.reason), updatedAtMs: number(row.updatedAtMs) };
}
export function parseWeeklyReport(value: unknown): WeeklyReport {
  const row = object(value), scope = object(row.scope), metrics = object(row.metrics), coverage = object(row.coverage);
  if (row.calculationVersion !== 'weekly_guard_v1' || row.timezone !== 'Asia/Shanghai' || !validDate(row.weekStart) || !validDate(row.weekEnd) || !text(row.reportId) || !['collecting', 'published', 'revised'].includes(text(row.status)) || integer(row.revision) === null || scope.kind !== 'device' || !text(scope.publicId) || !Array.isArray(row.daily)) throw invalid();
  const times = ['updatedAtMs', 'generatedAtMs', 'scheduledPublishAtMs', 'periodEndMs', 'dataCutoffAtMs'] as const;
  if (times.some(key => number(row[key]) === null) || (row.publishedAtMs !== null && number(row.publishedAtMs) === null)) throw invalid();
  const posture = object(metrics.postureReminders), usage = object(metrics.usage), active = object(metrics.activeDays);
  const postureValue = integer(posture.value), activeValue = integer(active.value), average = number(usage.dailyAverageSeconds), total = number(usage.totalSeconds);
  return {
    calculationVersion: text(row.calculationVersion), timezone: text(row.timezone), weekStart: row.weekStart, weekEnd: row.weekEnd,
    reportId: text(row.reportId), status: row.status as WeeklyReport['status'], revision: row.revision as number,
    publishedAtMs: number(row.publishedAtMs), updatedAtMs: row.updatedAtMs as number, generatedAtMs: row.generatedAtMs as number, scheduledPublishAtMs: row.scheduledPublishAtMs as number, periodEndMs: row.periodEndMs as number, dataCutoffAtMs: row.dataCutoffAtMs as number,
    scope: { kind: 'device', publicId: text(scope.publicId) },
    metrics: {
      postureReminders: { ...metric(posture, postureValue !== null), value: postureValue, referenceMax: integer(posture.referenceMax), aboveReferenceMax: posture.aboveReferenceMax === true },
      usage: { ...metric(usage, average !== null && total !== null && usage.denominatorDays === 7 && usage.source === 'telemetry.focus_segment'), totalSeconds: total, dailyAverageSeconds: average, denominatorDays: integer(usage.denominatorDays), source: text(usage.source), supplementalSeconds: number(usage.supplementalSeconds), combinedSeconds: number(usage.combinedSeconds) },
      activeDays: { ...metric(active, activeValue !== null && activeValue <= 7 && active.thresholdSeconds === 300), value: activeValue, thresholdSeconds: number(active.thresholdSeconds) },
    },
    daily: row.daily.map(value => {
      const d = object(value); if (!validDate(d.date) || d.date < row.weekStart! || d.date > row.weekEnd!) throw invalid();
      const observed = number(d.observedSeconds), postureCount = integer(d.postureCount);
      return { date: d.date, observedSeconds: observed, supplementalSeconds: number(d.supplementalSeconds), combinedSeconds: number(d.combinedSeconds), longestContinuousSeconds: number(d.longestContinuousSeconds), active: typeof d.active === 'boolean' ? d.active : null, postureCount, postureAvailable: d.postureAvailable === true && postureCount !== null, usageAvailable: d.usageAvailable === true && observed !== null, updatedAtMs: number(d.updatedAtMs), reason: text(d.reason) };
    }),
    coverage: { complete: coverage.complete === true, reason: text(coverage.reason), observedDays: integer(coverage.observedDays), missingDates: dates(coverage.missingDates), pendingDates: dates(coverage.pendingDates), invalidEventCount: integer(coverage.invalidEventCount), supplementalAvailable: coverage.supplementalAvailable === true },
    sourceUpdatedAtMs: number(row.sourceUpdatedAtMs),
  };
}
export async function getWeeklyReport(publicId: string, weekStart: string): Promise<WeeklyReport> {
  if (!validDate(weekStart)) throw invalid();
  const response = object(await apiRequest(`/v1/parent/devices/${encodeURIComponent(publicId)}/weekly-report?week_start=${encodeURIComponent(weekStart)}`));
  if (response.ok !== true) throw invalid();
  const data = object(response.data);
  if (data.report === null) throw new WeeklyReportUnavailableError(text(data.reportUnavailableReason) || 'report_unavailable');
  const report = parseWeeklyReport(data.report);
  if (report.scope.publicId !== publicId || report.weekStart !== weekStart) throw invalid();
  return report;
}
export class WeeklyReportController {
  state: WeeklyState;
  private version = 0;
  private disposed = false;
  private listeners = new Set<(state: WeeklyState) => void>();
  constructor(private fetch: (weekStart: string) => Promise<WeeklyReport>, private accessLost?: (status: number) => void, weekStart = beijingWeekStart()) { this.state = { weekStart, report: null, busy: false, error: '', loaded: false }; }
  subscribe(listener: (state: WeeklyState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private update(patch: Partial<WeeklyState>) { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener(this.state)); }
  dispose() { this.version++; this.disposed = true; this.listeners.clear(); this.state = { ...this.state, report: null, busy: false, loaded: false, error: '' }; }
  async refresh(weekStart = this.state.weekStart): Promise<void> {
    if (this.disposed) return;
    const version = ++this.version, changed = weekStart !== this.state.weekStart;
    this.update({ weekStart, busy: true, error: '', ...(changed ? { report: null, loaded: false } : {}) });
    try {
      const report = await this.fetch(weekStart);
      if (this.disposed || version !== this.version) return;
      this.update({ report, busy: false, loaded: true });
    } catch (error) {
      if (this.disposed || version !== this.version) return;
      if (error instanceof WeeklyReportUnavailableError) {
        this.update({ busy: false, report: null, loaded: true, error: error.reason === 'current_binding_unavailable' ? '当前绑定尚不具备周报读取条件，请刷新设备列表。' : '当前周报暂不可用，请刷新后重试。' });
        return;
      }
      const status = (error as { status?: number })?.status, lost = status === 401 || status === 403 || status === 404;
      this.update({ busy: false, error: status === 401 ? '登录已过期，请重新登录' : lost ? '设备当前不可访问，请刷新设备列表' : status === 429 ? '请求较频繁，请稍后重试' : '周报读取失败，请重试；缺失数据不会显示为零', ...(lost ? { report: null, loaded: false } : {}) });
      if (lost) this.accessLost?.(status!);
    }
  }
}
