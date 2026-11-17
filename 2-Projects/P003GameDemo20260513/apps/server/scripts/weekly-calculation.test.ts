import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWeeklyCalculation, dateAdd, validDate, weekStartOf, type WeeklyEvent } from '../src/weekly-calculation.ts';

const ms = (date: string) => Date.parse(date.includes('T') ? date : `${date}T00:00:00+08:00`);
const now = ms('2026-11-17T20:00:00+08:00');
const monday = ms('2026-11-16');
const focus = (id: string, start: number, end: number, received = now): WeeklyEvent => ({
  event_id: id, type: 'focus_segment', occurred_at_ms: end, server_received_ms: received,
  data: { start_ms: start, end_ms: end },
});
const reminder = (id: string, outcome: unknown, at = monday + 3600000): WeeklyEvent => ({
  event_id: id, type: 'posture_reminder', occurred_at_ms: at, server_received_ms: now,
  data: { outcome },
});
const calc = (events: WeeklyEvent[] = [], extra: Partial<Parameters<typeof buildWeeklyCalculation>[0]> = {}) =>
  buildWeeklyCalculation({ weekStart: '2026-11-16', events, now, ...extra });

test('CST周一起点不会把11月17日周二当成周起点', () => {
  for (const [at, want] of [
    ['2026-11-17T20:00:00+08:00', '2026-11-16'],
    ['2026-11-22T21:59:59.999+08:00', '2026-11-16'],
    ['2026-11-22T22:00:00+08:00', '2026-11-16'],
    ['2026-11-22T23:59:59.999+08:00', '2026-11-16'],
    ['2026-11-23T00:00:00+08:00', '2026-11-23'],
  ]) assert.equal(weekStartOf(ms(at)), want);
});

test('日期严格校验闰年、格式、溢出，跨月日期加减不受本机时区影响', () => {
  for (const date of ['2026-11-16', '2024-02-29', '2000-02-29']) assert.equal(validDate(date), true);
  for (const date of ['2026-02-29', '1900-02-29', '2026-11-31', '2026-1-01', '2026-13-01', '2026-01-00', '2026-11-16x', '']) assert.equal(validDate(date), false);
  assert.equal(dateAdd('2026-12-31', 1), '2027-01-01');
  assert.equal(dateAdd('2024-03-01', -1), '2024-02-29');
  assert.throws(() => dateAdd('2026-02-29', 1), /invalid_date/);
  assert.throws(() => dateAdd('2026-11-16', 0.5), /invalid_days/);
  assert.throws(() => calc([], { weekStart: '2026-11-17' }), /week_start_must_be_monday/);
});

test('空周是null；未来日期pending；缺测日与未来日期分开', () => {
  const result = calc();
  assert.equal(result.week_end, '2026-11-22');
  assert.equal(result.metrics.posture_reminders.value, null);
  assert.equal(result.metrics.usage.total_seconds, null);
  assert.equal(result.metrics.active_days.value, null);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.missing_dates, ['2026-11-16', '2026-11-17']);
  assert.deepEqual(result.coverage.pending_dates, ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
  for (const day of result.daily) {
    assert.equal(day.observed_seconds, null);
    assert.equal(day.active, null);
    assert.equal(day.posture_count, null);
  }
});

test('只有299999毫秒不能四舍五入成活跃日，300000毫秒才达到门槛', () => {
  const short = calc([focus('short', monday, monday + 299999)]);
  assert.equal(short.metrics.usage.total_seconds, 299.999);
  assert.equal(short.daily[0].longest_continuous_seconds, 299.999);
  assert.equal(short.metrics.active_days.value, 0);
  assert.equal(short.daily[0].active, false);
  const exact = calc([focus('exact', monday, monday + 300000)]);
  assert.equal(exact.metrics.active_days.value, 1);
  assert.equal(exact.daily[0].active, true);
});

test('端点相接可以连续，1毫秒正间隙必须断开', () => {
  assert.equal(calc([focus('a', monday, monday + 150000), focus('b', monday + 150000, monday + 300000)]).metrics.active_days.value, 1);
  const gap = calc([focus('a', monday, monday + 150000), focus('b', monday + 150001, monday + 300001)]);
  assert.equal(gap.metrics.usage.total_seconds, 300);
  assert.equal(gap.daily[0].longest_continuous_seconds, 150);
  assert.equal(gap.metrics.active_days.value, 0);
});

test('分三次2分钟累计6分钟仍不是连续5分钟', () => {
  const result = calc([0, 180000, 360000].map((offset, index) => focus(String(index), monday + offset, monday + offset + 120000)));
  assert.equal(result.metrics.usage.total_seconds, 360);
  assert.equal(result.metrics.active_days.value, 0);
});

test('同event_id重复、不同ID重叠合并，只按毫秒求和后转秒', () => {
  const a = focus('a', monday, monday + 200001);
  const result = calc([a, { ...a, server_received_ms: now - 1 }, focus('b', monday + 100000, monday + 300002)]);
  assert.equal(result.metrics.usage.total_seconds, 300.002);
  assert.equal(result.metrics.usage.daily_average_seconds, 300.002 / 7);
  assert.equal(result.metrics.usage.denominator_days, 7);
  assert.equal(result.daily[0].longest_continuous_seconds, 300.002);
  assert.equal(result.metrics.active_days.value, 1);
});

test('跨CST午夜先切日，23点57分到次日00点03分两天都只有3分钟', () => {
  const result = calc([focus('night', ms('2026-11-16T23:57:00+08:00'), ms('2026-11-17T00:03:00+08:00'))]);
  assert.equal(result.metrics.usage.total_seconds, 360);
  assert.equal(result.metrics.active_days.value, 0);
  assert.equal(result.daily[0].longest_continuous_seconds, 180);
  assert.equal(result.daily[1].longest_continuous_seconds, 180);
  assert.equal(result.coverage.observed_days, 2);
});

test('跨周片段仅计本周部分，周日22点后记录仍属于本周', () => {
  const result = calc([
    focus('start', ms('2026-11-15T23:57:00+08:00'), ms('2026-11-16T00:03:00+08:00')),
    focus('end', ms('2026-11-22T23:57:00+08:00'), ms('2026-11-23T00:03:00+08:00'), ms('2026-11-23T01:00:00+08:00')),
  ], { now: ms('2026-11-23T02:00:00+08:00') });
  assert.equal(result.metrics.usage.total_seconds, 360);
  assert.equal(result.daily[6].observed_seconds, 180);
  assert.equal(result.metrics.active_days.value, 0);
});

test('仅补充估算能保留合计，但不能伪造真实时长、提醒或活跃0', () => {
  const result = calc([], { supplementalDays: [{ date: '2026-11-16', total_seconds: 902, estimated_seconds: 902, available: true, updated_at_ms: now }] });
  assert.equal(result.metrics.usage.available, false);
  assert.equal(result.metrics.usage.total_seconds, null);
  assert.equal(result.metrics.usage.supplemental_seconds, 902);
  assert.equal(result.metrics.usage.combined_seconds, 902);
  assert.equal(result.metrics.active_days.value, null);
  assert.equal(result.daily[0].active, null);
  assert.equal(result.daily[0].longest_continuous_seconds, null);
  assert.equal(result.daily[0].posture_count, null);
  assert.equal(result.coverage.observed_days, 0);
});

test('同日补充合计与真实量取max，重复高水位不相加且毫秒精度不下降', () => {
  const result = calc([focus('a', monday, monday + 300001)], { supplementalDays: [
    { date: '2026-11-16', total_seconds: 301, available: true, updated_at_ms: now - 3 },
    { date: '2026-11-16', total_seconds: 600, available: true, updated_at_ms: now - 2 },
    { date: '2026-11-16', total_seconds: 902, available: true, updated_at_ms: now - 1 },
  ] });
  assert.equal(result.metrics.usage.total_seconds, 300.001);
  assert.equal(result.metrics.usage.combined_seconds, 902);
  assert.ok(Math.abs(result.metrics.usage.supplemental_seconds! - 601.999) < 1e-9);
  const roundedLower = calc([focus('a', monday, monday + 300001)], { supplementalDays: [{ date: '2026-11-16', total_seconds: 300, available: true, updated_at_ms: now }] });
  assert.equal(roundedLower.metrics.usage.combined_seconds, 300.001);
  assert.equal(roundedLower.metrics.usage.supplemental_seconds, 0);
});

test('played精确计数、唯一ID去重，focus_id为空仍合法', () => {
  const played = reminder('played', 'played');
  const result = calc([played, played, reminder('cooldown', 'suppressed_cooldown'), reminder('unknown', 'PLAYED')]);
  assert.equal(result.metrics.posture_reminders.value, 1);
  assert.equal(result.daily[0].posture_count, 1);
  assert.equal(result.metrics.usage.total_seconds, null);
  assert.equal(result.metrics.active_days.value, null);
});

test('只有合法cooldown可以确认已收到记录中played为0，未知不能产生0', () => {
  const cooldown = calc([reminder('cooldown', 'suppressed_cooldown')]);
  assert.equal(cooldown.metrics.posture_reminders.available, true);
  assert.equal(cooldown.metrics.posture_reminders.value, 0);
  const unknown = calc([reminder('unknown', 'suppressed'), reminder('missing', undefined)]);
  assert.equal(unknown.metrics.posture_reminders.available, false);
  assert.equal(unknown.metrics.posture_reminders.value, null);
  assert.equal(unknown.metrics.posture_reminders.reason, 'unknown_reminder_outcome');
});

test('提醒超过参考672次只标异常，673条真实played完整保留', () => {
  const events = Array.from({ length: 673 }, (_, index) => reminder(`played-${index}`, 'played'));
  const within = calc(events.slice(0, 672));
  assert.equal(within.metrics.posture_reminders.reference_max, 672);
  assert.equal(within.metrics.posture_reminders.above_reference_max, false);
  const above = calc(events);
  assert.equal(above.metrics.posture_reminders.value, 673);
  assert.equal(above.daily[0].posture_count, 673);
  assert.equal(above.metrics.posture_reminders.reference_max, 672);
  assert.equal(above.metrics.posture_reminders.above_reference_max, true);
  assert.equal(above.metrics.posture_reminders.available, true);
});

test('提醒与计时各自可用，任一项缺测不清空另一项', () => {
  const result = calc([focus('a', monday, monday + 300000), reminder('unknown', 'unknown')]);
  assert.equal(result.metrics.posture_reminders.value, null);
  assert.equal(result.metrics.usage.total_seconds, 300);
  assert.equal(result.metrics.active_days.value, 1);
  assert.equal(result.metrics.usage.reason, 'partial_history');
  assert.equal(result.coverage.complete, false);
});

test('不把晚到事件当时钟错误，仍回原发生日期且更新时间使用接收时间', () => {
  const received = ms('2026-12-01T00:00:00+08:00');
  const result = calc([focus('late', monday, monday + 300000, received), { ...reminder('late-reminder', 'played'), server_received_ms: received }], { now: received });
  assert.equal(result.metrics.usage.total_seconds, 300);
  assert.equal(result.metrics.posture_reminders.value, 1);
  assert.equal(result.daily[0].updated_at_ms, received);
  assert.equal(result.source_updated_at_ms, received);
});

test('未来事件与非法整毫秒片段不进入可信指标，错误数量不重复', () => {
  const invalid = focus('fraction', monday, monday + 300000.5);
  const result = calc([
    invalid, invalid,
    focus('reversed', monday + 300000, monday),
    focus('too-long', monday - 1, monday + 86400000),
    focus('future-focus', now - 300000, now + 1),
    reminder('future-reminder', 'played', now + 1),
    { ...reminder('future-receipt', 'played'), server_received_ms: now + 1 },
    { ...reminder('invalid-time', 'played'), occurred_at_ms: Number.NaN },
  ]);
  assert.equal(result.coverage.invalid_event_count, 7);
  assert.equal(result.metrics.usage.total_seconds, null);
  assert.equal(result.metrics.posture_reminders.value, null);
  assert.equal(result.metrics.active_days.value, null);
});

test('未来日补充和负值/null补充不能伪造0；合法0补充不证明真实活跃', () => {
  const result = calc([], { supplementalDays: [
    { date: '2026-11-18', total_seconds: 600, available: true, updated_at_ms: now },
    { date: '2026-11-16', total_seconds: -1, available: true, updated_at_ms: now },
    { date: '2026-11-17', total_seconds: null, available: true, updated_at_ms: now },
  ] });
  assert.equal(result.metrics.usage.combined_seconds, null);
  assert.equal(result.daily[2].supplemental_seconds, null);
  const zero = calc([], { supplementalDays: [{ date: '2026-11-16', total_seconds: 0, available: true, updated_at_ms: now }] });
  assert.equal(zero.metrics.usage.combined_seconds, 0);
  assert.equal(zero.metrics.usage.total_seconds, null);
  assert.equal(zero.metrics.active_days.value, null);
});

test('补充依赖失败不清空真实指标，遥测失败不拿补充冒充主值', () => {
  const supplementalDays = [{ date: '2026-11-16', total_seconds: 900, available: true, updated_at_ms: now }];
  const measured = calc([focus('a', monday, monday + 300000)], { supplementalDays, supplementalAvailable: false });
  assert.equal(measured.metrics.usage.total_seconds, 300);
  assert.equal(measured.metrics.usage.supplemental_seconds, null);
  assert.equal(measured.metrics.usage.combined_seconds, 300);
  assert.equal(measured.coverage.supplemental_available, false);
  const failed = calc([focus('a', monday, monday + 300000), reminder('p', 'played')], { supplementalDays, telemetryAvailable: false });
  assert.equal(failed.metrics.usage.total_seconds, null);
  assert.equal(failed.metrics.usage.combined_seconds, 900);
  assert.equal(failed.metrics.active_days.value, null);
  assert.equal(failed.metrics.posture_reminders.value, null);
  assert.equal(failed.metrics.posture_reminders.reason, 'dependency_unavailable');
});

test('真实秒数跨天求和再除7，已收到天数不能改变日均分母', () => {
  const result = calc([focus('a', monday, monday + 100001), focus('b', monday + 86400000, monday + 86400000 + 199999)]);
  assert.equal(result.metrics.usage.total_seconds, 300);
  assert.equal(result.metrics.usage.daily_average_seconds, 300 / 7);
  assert.equal(result.coverage.observed_days, 2);
});

test('输入数据不被排序或合并逻辑改写，同一输入返回稳定结果', () => {
  const events = [focus('b', monday + 100000, monday + 200000), focus('a', monday, monday + 150000)];
  const before = structuredClone(events);
  const result = calc(events);
  assert.deepEqual(events, before);
  assert.deepEqual(calc(events), result);
});

test('别的周的坏片段按发生周归质量诊断，不改本周任何输出', () => {
  const base = [focus('valid', monday, monday + 300000)];
  const other = ms('2026-11-30');
  const checkNow = other + 3600000;
  const bad = { ...focus('other-week-invalid', other + 1, other, checkNow), occurred_at_ms: other + 1000 };
  assert.deepEqual(calc([...base, bad], { now: checkNow }), calc(base, { now: checkNow }));
  const otherWeek = calc([bad], { weekStart: '2026-11-30', now: checkNow });
  assert.equal(otherWeek.coverage.invalid_event_count, 1);
  assert.equal(otherWeek.metrics.usage.reason, 'invalid_focus_events');
});

test('无法归发生日的坏事件仅归合法接收周，接收时间也非法则不污染任何周', () => {
  const received = ms('2026-11-30T12:00:00+08:00');
  const bad = { ...reminder('invalid-occurrence', 'played'), occurred_at_ms: Number.NaN, server_received_ms: received };
  assert.deepEqual(calc([bad], { now: received }), calc([], { now: received }));
  assert.equal(calc([bad], { weekStart: '2026-11-30', now: received }).coverage.invalid_event_count, 1);
  const undatable = { ...bad, server_received_ms: Number.NaN };
  assert.deepEqual(calc([undatable], { now: received }), calc([], { now: received }));
});

test('合法focus区间按相交周归因，发生字段异常不让非相交旧周产生修订', () => {
  const other = ms('2026-11-30');
  const checkNow = other + 3600000;
  const valid = { ...focus('interval-week', other, other + 300000, checkNow), occurred_at_ms: monday + 300000 };
  assert.deepEqual(calc([valid], { now: checkNow }), calc([], { now: checkNow }));
  const invalid = { ...valid, occurred_at_ms: Number.NaN };
  assert.deepEqual(calc([invalid], { now: checkNow }), calc([], { now: checkNow }));
  assert.equal(calc([invalid], { weekStart: '2026-11-30', now: checkNow }).coverage.invalid_event_count, 1);
});
