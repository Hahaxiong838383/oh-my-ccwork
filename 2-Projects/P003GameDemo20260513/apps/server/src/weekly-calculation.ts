/** 单设备自然周的已收到证据；不推断完整采集，也不负责发布或授权。 */
export type WeeklyEvent = {
  event_id: string;
  type: string;
  occurred_at_ms: number;
  server_received_ms: number;
  data: Record<string, unknown>;
};

/** total_seconds 是现有历史计算的当日合计，已经包含真实片段。 */
export type SupplementalDay = {
  date: string;
  total_seconds: number | null;
  estimated_seconds?: number | null;
  available: boolean;
  updated_at_ms: number | null;
};

type MetricState = { available: boolean; reason: string; updated_at_ms: number | null };

export type WeeklyDailyCalculation = {
  date: string;
  observed_seconds: number | null;
  supplemental_seconds: number | null;
  combined_seconds: number | null;
  longest_continuous_seconds: number | null;
  active: boolean | null;
  posture_count: number | null;
  posture_available: boolean;
  usage_available: boolean;
  updated_at_ms: number | null;
  reason: string;
};

export type WeeklyCalculation = {
  calculation_version: 'weekly_guard_v1';
  timezone: 'Asia/Shanghai';
  week_start: string;
  week_end: string;
  metrics: {
    posture_reminders: MetricState & { value: number | null; reference_max?: 672; above_reference_max?: boolean };
    usage: MetricState & {
      total_seconds: number | null;
      daily_average_seconds: number | null;
      denominator_days: 7;
      source: 'telemetry.focus_segment';
      supplemental_seconds: number | null;
      combined_seconds: number | null;
    };
    active_days: MetricState & { value: number | null; threshold_seconds: 300 };
  };
  daily: WeeklyDailyCalculation[];
  coverage: {
    complete: false;
    reason: string;
    observed_days: number;
    missing_dates: string[];
    pending_dates: string[];
    invalid_event_count: number;
    supplemental_available: boolean;
    invalid_event_reasons?: Record<string, number>;
  };
  source_updated_at_ms: number | null;
};

export type WeeklyCalculationInput = {
  weekStart: string;
  events: WeeklyEvent[];
  supplementalDays?: SupplementalDay[];
  now?: number;
  telemetryAvailable?: boolean;
  supplementalAvailable?: boolean;
};

const DAY_MS = 86400000;
const CST_OFFSET_MS = 8 * 3600000;
const MAX_TIMESTAMP = 253402271999999;
const midnight = (date: string) => Date.parse(`${date}T00:00:00+08:00`);
const dayOf = (time: number) => new Date(time + CST_OFFSET_MS).toISOString().slice(0, 10);
const newest = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);

export function validDate(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function dateAdd(date: string, days: number): string {
  if (!validDate(date)) throw new Error('invalid_date');
  if (!Number.isSafeInteger(days)) throw new Error('invalid_days');
  const result = new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
  if (!Number.isFinite(result.getTime())) throw new Error('invalid_date');
  const value = result.toISOString().slice(0, 10);
  if (!validDate(value)) throw new Error('invalid_date');
  return value;
}

export function weekStartOf(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIMESTAMP) throw new Error('invalid_now');
  const date = dayOf(now);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dateAdd(date, -((weekday + 6) % 7));
}

type Interval = { start: number; end: number };
type DayEvidence = {
  intervals: Interval[];
  played: number;
  knownReminders: number;
  unknownReminders: number;
  focusUpdated: number | null;
  reminderUpdated: number | null;
  supplemental: SupplementalDay | null;
};

function mergedIntervals(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const interval of intervals.slice().sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    // 只合并重叠/端点相接；任何正间隙都切断连续证据。
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}

function timeProblem(value: unknown, now: number): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMESTAMP) return 'invalid_time';
  return value > now ? 'future_time' : null;
}

/** 质量问题也必须有归属周，不能让其他周的新坏记录修订所有历史报告。 */
function belongsToWeek(event: WeeklyEvent, start: number, end: number, now: number): boolean {
  const from = event.data?.start_ms, to = event.data?.end_ms;
  if (event.type === 'focus_segment' && !timeProblem(from, now) && !timeProblem(to, now)
    && (to as number) > (from as number) && (to as number) - (from as number) <= DAY_MS) {
    return (from as number) < end && (to as number) > start;
  }
  // 坏区间按可信发生时间归周；无法归发生日时仅归接收周，仍不计入指标。
  const anchor = !timeProblem(event.occurred_at_ms, now) ? event.occurred_at_ms
    : !timeProblem(event.server_received_ms, now) ? event.server_received_ms : null;
  return anchor !== null && anchor >= start && anchor < end;
}

export function buildWeeklyCalculation(input: WeeklyCalculationInput): WeeklyCalculation {
  const now = input.now ?? Date.now();
  weekStartOf(now); // 与默认周起点共用输入时间边界。
  if (!validDate(input.weekStart)) throw new Error('invalid_week_start');
  if (new Date(`${input.weekStart}T00:00:00Z`).getUTCDay() !== 1) throw new Error('week_start_must_be_monday');
  const weekEnd = dateAdd(input.weekStart, 6);
  const start = midnight(input.weekStart), end = midnight(dateAdd(input.weekStart, 7));
  const today = dayOf(now);
  const telemetryAvailable = input.telemetryAvailable !== false;
  const supplementalAvailable = input.supplementalAvailable !== false;
  const dates = Array.from({ length: 7 }, (_, index) => dateAdd(input.weekStart, index));
  const byDate = new Map<string, DayEvidence>(dates.map(date => [date, {
    intervals: [], played: 0, knownReminders: 0, unknownReminders: 0,
    focusUpdated: null, reminderUpdated: null, supplemental: null,
  }]));
  const invalidReasons: Record<string, number> = {};
  let invalidCount = 0, invalidFocus = 0, invalidReminder = 0;
  const reject = (event: WeeklyEvent, reason: string) => {
    invalidCount++;
    invalidReasons[reason] = (invalidReasons[reason] ?? 0) + 1;
    if (event.type === 'focus_segment') invalidFocus++;
    else invalidReminder++;
  };

  if (telemetryAvailable) {
    // 原始表的event_id不可变；重送不再次增加计数，也不刷新首次接收时间。
    const unique = new Map<string, WeeklyEvent>();
    for (const event of input.events) {
      if (event.type !== 'focus_segment' && event.type !== 'posture_reminder') continue;
      const previous = unique.get(event.event_id);
      if (!previous || (Number.isSafeInteger(event.server_received_ms) && event.server_received_ms < previous.server_received_ms)) {
        unique.set(event.event_id, event);
      }
    }
    for (const event of unique.values()) {
      if (!belongsToWeek(event, start, end, now)) continue;
      if (typeof event.event_id !== 'string' || !event.event_id.trim()) { reject(event, 'invalid_event_id'); continue; }
      const eventTimeProblem = timeProblem(event.occurred_at_ms, now) ?? timeProblem(event.server_received_ms, now);
      if (eventTimeProblem) { reject(event, eventTimeProblem); continue; }
      if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) { reject(event, 'invalid_event_data'); continue; }
      if (event.type === 'focus_segment') {
        const from = event.data.start_ms, to = event.data.end_ms;
        const problem = timeProblem(from, now) ?? timeProblem(to, now);
        if (problem) { reject(event, problem); continue; }
        const intervalStart = from as number, intervalEnd = to as number;
        if (intervalEnd <= intervalStart || intervalEnd - intervalStart > DAY_MS) { reject(event, 'invalid_focus_interval'); continue; }
        // 先按自然日切段，再日内合并；跨周只截取与本周相交部分。
        let cursor = Math.max(start, intervalStart);
        const clippedEnd = Math.min(end, intervalEnd);
        while (cursor < clippedEnd) {
          const date = dayOf(cursor), sliceEnd = Math.min(clippedEnd, midnight(date) + DAY_MS);
          const day = byDate.get(date)!;
          day.intervals.push({ start: cursor, end: sliceEnd });
          day.focusUpdated = newest(day.focusUpdated, event.server_received_ms);
          cursor = sliceEnd;
        }
      } else {
        if (event.occurred_at_ms < start || event.occurred_at_ms >= end) continue;
        const day = byDate.get(dayOf(event.occurred_at_ms))!;
        if (event.data.outcome === 'played' || event.data.outcome === 'suppressed_cooldown') {
          day.knownReminders++;
          if (event.data.outcome === 'played') day.played++;
        } else day.unknownReminders++;
        day.reminderUpdated = newest(day.reminderUpdated, event.server_received_ms);
      }
    }
  }

  if (supplementalAvailable) {
    for (const row of input.supplementalDays ?? []) {
      const day = byDate.get(row.date);
      if (!day || row.date > today || !row.available || typeof row.total_seconds !== 'number'
        || !Number.isFinite(row.total_seconds) || row.total_seconds < 0 || row.total_seconds > 86400
        || (row.updated_at_ms !== null && timeProblem(row.updated_at_ms, now))) continue;
      // 输入已是位置窗口并集/奖励累计高水位；不可再把estimated_seconds相加。
      const previous = day.supplemental;
      day.supplemental = {
        ...row,
        total_seconds: Math.max(row.total_seconds, previous?.total_seconds ?? 0),
        updated_at_ms: newest(previous?.updated_at_ms ?? null, row.updated_at_ms),
      };
    }
  }

  let totalMs = 0, observedDays = 0, played = 0, knownReminders = 0, unknownReminders = 0, activeDays = 0;
  let focusUpdated: number | null = null, reminderUpdated: number | null = null, usageUpdated: number | null = null;
  let supplementalTotal: number | null = null, combinedTotal: number | null = null;
  const daily = dates.map((date): WeeklyDailyCalculation => {
    const day = byDate.get(date)!;
    const intervals = mergedIntervals(day.intervals);
    const observed = intervals.length > 0;
    const milliseconds = intervals.reduce((total, interval) => total + interval.end - interval.start, 0);
    const longestMs = intervals.reduce((longest, interval) => Math.max(longest, interval.end - interval.start), 0);
    const actual = observed ? milliseconds / 1000 : null;
    const combined = day.supplemental ? Math.max(actual ?? 0, day.supplemental.total_seconds!) : actual;
    const supplemental = day.supplemental ? combined! - (actual ?? 0) : null;
    const hasReminder = day.knownReminders > 0;
    const isActive = observed ? longestMs >= 300000 : null;
    const updated = newest(newest(day.focusUpdated, day.reminderUpdated), day.supplemental?.updated_at_ms ?? null);
    totalMs += milliseconds;
    observedDays += Number(observed);
    activeDays += Number(isActive === true);
    played += day.played;
    knownReminders += day.knownReminders;
    unknownReminders += day.unknownReminders;
    focusUpdated = newest(focusUpdated, day.focusUpdated);
    reminderUpdated = newest(reminderUpdated, day.reminderUpdated);
    usageUpdated = newest(usageUpdated, newest(day.focusUpdated, day.supplemental?.updated_at_ms ?? null));
    if (combined !== null) combinedTotal = (combinedTotal ?? 0) + combined;
    if (supplemental !== null) supplementalTotal = (supplementalTotal ?? 0) + supplemental;
    return {
      date, observed_seconds: actual, supplemental_seconds: supplemental, combined_seconds: combined,
      longest_continuous_seconds: observed ? longestMs / 1000 : null, active: isActive,
      posture_count: hasReminder ? day.played : null, posture_available: hasReminder, usage_available: observed,
      updated_at_ms: updated,
      reason: date > today ? 'pending' : observed || hasReminder || day.supplemental ? 'partial_history'
        : !telemetryAvailable ? 'dependency_unavailable' : day.unknownReminders ? 'unknown_reminder_outcome' : 'no_observations',
    };
  });
  const usageReason = !telemetryAvailable ? 'dependency_unavailable' : observedDays ? 'partial_history'
    : invalidFocus ? 'invalid_focus_events' : 'no_focus_segments';
  const postureReason = !telemetryAvailable ? 'dependency_unavailable' : knownReminders ? 'partial_history'
    : unknownReminders ? 'unknown_reminder_outcome' : invalidReminder ? 'invalid_reminder_events' : 'no_reminder_events';
  const totalSeconds = observedDays ? totalMs / 1000 : null;
  return {
    calculation_version: 'weekly_guard_v1', timezone: 'Asia/Shanghai', week_start: input.weekStart, week_end: weekEnd,
    metrics: {
      posture_reminders: { available: knownReminders > 0, reason: postureReason, value: knownReminders ? played : null,
        reference_max: 672, above_reference_max: played > 672, updated_at_ms: reminderUpdated },
      usage: {
        available: observedDays > 0, reason: usageReason, total_seconds: totalSeconds,
        daily_average_seconds: totalSeconds === null ? null : totalSeconds / 7,
        denominator_days: 7, source: 'telemetry.focus_segment', supplemental_seconds: supplementalTotal,
        combined_seconds: combinedTotal, updated_at_ms: usageUpdated,
      },
      active_days: { available: observedDays > 0, reason: usageReason, value: observedDays ? activeDays : null, threshold_seconds: 300, updated_at_ms: focusUpdated },
    },
    daily,
    coverage: {
      complete: false, reason: !telemetryAvailable ? 'dependency_unavailable' : 'partial_history',
      observed_days: observedDays,
      missing_dates: daily.filter(day => day.date <= today && !day.usage_available).map(day => day.date),
      pending_dates: dates.filter(date => date > today),
      invalid_event_count: invalidCount, invalid_event_reasons: invalidReasons,
      supplemental_available: supplementalAvailable,
    },
    source_updated_at_ms: newest(usageUpdated, reminderUpdated),
  };
}
