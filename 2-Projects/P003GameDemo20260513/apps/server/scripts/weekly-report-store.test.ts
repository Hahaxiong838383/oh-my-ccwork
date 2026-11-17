import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WeeklyReportStore } from '../src/weekly-report-store.js';
import { buildWeeklyCalculation, type WeeklyEvent, type SupplementalDay } from '../src/weekly-calculation.js';

const at = (date: string) => Date.parse(date.includes('T') ? date : `${date}T00:00:00+08:00`);
const monday = at('2026-11-16');
const sunday2159 = at('2026-11-22T21:59:59.999+08:00');
const sunday2200 = at('2026-11-22T22:00:00+08:00');
const nextMonday = at('2026-11-23');
const scope = 'parent-one-device-one-binding-one';
const device = 'public-device-one';
const event = (id: string, start = monday, seconds = 300, received = monday + 3600000): WeeklyEvent => ({
  event_id: id, type: 'focus_segment', occurred_at_ms: start + seconds * 1000,
  server_received_ms: received, data: { start_ms: start, end_ms: start + seconds * 1000 },
});
const supplement = (seconds: number, date = '2026-11-16', updated = monday + 3600000): SupplementalDay => ({
  date, total_seconds: seconds, available: true, updated_at_ms: updated,
});
function memoryStore(t: TestContext) {
  const store = new WeeklyReportStore(':memory:');
  t.after(() => store.close());
  return store;
}
function calculate(store: WeeklyReportStore, now: number, key = scope, weekStart = '2026-11-16') {
  return buildWeeklyCalculation({ weekStart, now, events: store.evidence(key), supplementalDays: store.supplements(key) });
}
function save(store: WeeklyReportStore, now: number, key = scope, publicId = device) {
  return store.save(key, publicId, calculate(store, now, key), now);
}

test('真实SQLite关闭重开后保留证据、补充、日报与已发布周报', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weekly-report-store-'));
  const path = join(directory, 'nested', 'weekly.db');
  let store = new WeeklyReportStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.openScope(scope, monday), monday);
  store.retain(scope, [event('first')], [supplement(902)]);
  const original = save(store, sunday2200);
  store.close();
  store = new WeeklyReportStore(path);
  assert.equal(store.openScope(scope, nextMonday), monday);
  assert.equal(store.evidence(scope).length, 1);
  assert.equal(store.supplements(scope)[0].total_seconds, 902);
  assert.deepEqual(store.report(scope, '2026-11-16'), original);
  assert.deepEqual(store.weeks(scope), ['2026-11-16']);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM weekly_day WHERE scope_key=?').get(scope)!.n, 7);
  const reread = save(store, sunday2200 + 1000);
  assert.equal(reread.revision, original.revision);
  assert.equal(reread.metrics.usage.total_seconds, 300);
  assert.equal(reread.metrics.usage.combined_seconds, 902);
});

test('唯一event_id重复及冲突不覆盖首次接受事实', t => {
  const store = memoryStore(t), first = event('same');
  store.retain(scope, [first, first], []);
  store.retain(scope, [{ ...first, data: { start_ms: monday, end_ms: monday + 600000 }, server_received_ms: nextMonday }], []);
  assert.deepEqual(store.evidence(scope), [first]);
  assert.equal(calculate(store, nextMonday).metrics.usage.total_seconds, 300);
});

test('证据仅持久化约定的顶层和data白名单，任意正文与身份字段不落库', t => {
  const store = memoryStore(t);
  const injected = {
    ...event('minimal'), conversation: '不得保留的顶层正文', phone: '不得保留的电话',
    data: { ...event('minimal').data, conversation: '不得保留的嵌套正文', access_token: '不得保留的token', focus_id: '非必要字段' },
  };
  store.retain(scope, [injected], []);
  const saved = store.evidence(scope)[0];
  assert.deepEqual(Object.keys(saved).sort(), ['data', 'event_id', 'occurred_at_ms', 'server_received_ms', 'type']);
  assert.deepEqual(saved.data, { start_ms: monday, end_ms: monday + 300000 });
  const json = String(store.db.prepare('SELECT event_json FROM weekly_evidence').get()!.event_json);
  assert.equal(json.includes('不得保留'), false);
});

test('白名单字段也不允许嵌套任意正文对象落库', t => {
  const store = memoryStore(t);
  store.retain(scope, [{
    ...event('malformed-reminder'), type: 'posture_reminder',
    data: { outcome: { conversation: '不得保留的对象正文' } },
  }], []);
  const json = JSON.stringify(store.evidence(scope));
  assert.equal(json.includes('不得保留'), false);
  assert.equal(calculate(store, nextMonday).metrics.posture_reminders.value, null);
});

test('补充301→600→902只保留902，较低回放不降级，相同高水位更新时间可推进', t => {
  const store = memoryStore(t);
  store.retain(scope, [], [supplement(301), supplement(600), supplement(902)]);
  store.retain(scope, [], [supplement(10, '2026-11-16', nextMonday)]);
  assert.equal(store.supplements(scope)[0].total_seconds, 902);
  store.retain(scope, [], [supplement(902, '2026-11-16', nextMonday)]);
  assert.equal(store.supplements(scope)[0].updated_at_ms, nextMonday);
  const report = save(store, nextMonday);
  assert.equal(report.metrics.usage.total_seconds, null);
  assert.equal(report.metrics.usage.combined_seconds, 902);
  assert.equal(report.metrics.active_days.value, null);
});

test('非法补充高值不能永久压住后来的合法高水位，非法日期不能入库', t => {
  const store = memoryStore(t);
  store.retain(scope, [], [supplement(86401), supplement(500, '2026-02-30')]);
  store.retain(scope, [], [supplement(902)]);
  assert.deepEqual(store.supplements(scope).map(row => [row.date, row.total_seconds]), [['2026-11-16', 902]]);
  assert.equal(calculate(store, nextMonday).metrics.usage.combined_seconds, 902);
});

test('保存七日结果包含未观测null，读出结果不依赖调用方对象后续改写', t => {
  const store = memoryStore(t);
  store.retain(scope, [event('day')], []);
  const calculation = calculate(store, sunday2200), original = store.save(scope, device, calculation, sunday2200);
  calculation.daily[0].observed_seconds = 999;
  const days = store.db.prepare('SELECT day_json FROM weekly_day WHERE scope_key=? ORDER BY date').all(scope).map(row => JSON.parse(String(row.day_json)));
  assert.equal(days.length, 7);
  assert.equal(days[0].observed_seconds, 300);
  assert.equal(days[1].observed_seconds, null);
  assert.equal(days[1].active, null);
  assert.equal(store.report(scope, '2026-11-16')!.daily[0].observed_seconds, 300);
  assert.equal(original.revision, 1);
});

test('周日21:59统计中、22点首次发布，稳定重读不增长版本', t => {
  const store = memoryStore(t);
  store.retain(scope, [event('first')], []);
  const before = save(store, sunday2159);
  assert.equal(before.status, 'collecting');
  assert.equal(before.published_at_ms, null);
  assert.equal(before.scheduled_publish_at_ms, sunday2200);
  const published = save(store, sunday2200);
  assert.equal(published.status, 'published');
  assert.equal(published.published_at_ms, sunday2200);
  assert.equal(published.data_cutoff_at_ms, sunday2200);
  assert.equal(published.revision, before.revision + 1);
  const unchanged = save(store, sunday2200 + 60000);
  assert.deepEqual(unchanged, published);
});

test('周一00点触发完整自然周重算，22点后记录计回原周且只修订一次', t => {
  const store = memoryStore(t);
  store.retain(scope, [event('first')], []);
  const published = save(store, sunday2200);
  store.retain(scope, [event('late-sunday', sunday2200 + 3600000, 300, nextMonday - 1000)], []);
  const ended = save(store, nextMonday);
  assert.equal(ended.status, 'revised');
  assert.equal(ended.revision, published.revision + 1);
  assert.equal(ended.published_at_ms, sunday2200);
  assert.equal(ended.data_cutoff_at_ms, nextMonday);
  assert.equal(ended.metrics.usage.total_seconds, 600);
  assert.equal(ended.daily[6].observed_seconds, 300);
  assert.equal(save(store, nextMonday + 86400000).revision, ended.revision);
});

test('离线晚到只修原发生周，首次发布时间不变，原始来源清理不丢历史', t => {
  const store = memoryStore(t);
  store.retain(scope, [event('first')], [supplement(902)]);
  const published = save(store, nextMonday);
  const lateReceived = at('2026-12-01T12:00:00+08:00');
  // 上游此时只返回新补传；旧事件与奖励观测均已离开上游保留窗口。
  store.retain(scope, [event('late', monday + 86400000, 300, lateReceived)], []);
  const revised = save(store, lateReceived);
  assert.equal(revised.status, 'revised');
  assert.equal(revised.revision, published.revision + 1);
  assert.equal(revised.published_at_ms, published.published_at_ms);
  assert.equal(revised.metrics.usage.total_seconds, 600);
  assert.equal(revised.metrics.usage.combined_seconds, 1202);
  assert.equal(revised.source_updated_at_ms, lateReceived);
  assert.deepEqual(store.weeks(scope), ['2026-11-16']);
  store.retain(scope, [], []);
  assert.equal(save(store, lateReceived + 86400000).revision, revised.revision);
});

test('其他周的非法片段不能污染已发布旧周的覆盖诊断和revision', t => {
  const store = memoryStore(t);
  store.retain(scope, [event('first')], []);
  const published = save(store, nextMonday);
  const currentWeek = at('2026-11-30');
  store.retain(scope, [{
    ...event('other-week-invalid', currentWeek), occurred_at_ms: currentWeek + 3600000,
    server_received_ms: currentWeek + 3600000, data: { start_ms: currentWeek + 1, end_ms: currentWeek },
  }], []);
  const unchanged = save(store, currentWeek + 7200000);
  assert.equal(unchanged.coverage.invalid_event_count, 0);
  assert.equal(unchanged.revision, published.revision);
  assert.equal(unchanged.status, published.status);
});

test('不同授权scope的同event_id、同日期、同周结果完全隔离', t => {
  const store = memoryStore(t), other = 'parent-two-device-one-binding-two';
  store.openScope(scope, monday);
  store.openScope(other, nextMonday);
  store.retain(scope, [event('same', monday, 300)], [supplement(902)]);
  store.retain(other, [event('same', monday, 600)], []);
  const one = save(store, nextMonday), two = save(store, nextMonday, other, device);
  assert.notEqual(one.report_id, two.report_id);
  assert.equal(one.metrics.usage.total_seconds, 300);
  assert.equal(two.metrics.usage.total_seconds, 600);
  assert.equal(store.supplements(other).length, 0);
  assert.equal(store.report('unknown-scope', '2026-11-16'), null);
  assert.deepEqual(store.weeks('unknown-scope'), []);
  assert.equal(store.openScope(other, nextMonday + 1), nextMonday);
});

test('retain中途SQLite失败完整回滚证据和补充，连接仍可继续提交', t => {
  const store = memoryStore(t);
  store.retain(scope, [event('existing')], [supplement(301)]);
  store.db.exec(`CREATE TRIGGER fail_supplement BEFORE INSERT ON weekly_supplement
    WHEN NEW.date='2026-11-17' BEGIN SELECT RAISE(ABORT,'injected_retain_failure'); END;`);
  assert.throws(() => store.retain(scope, [event('rolled-back')], [supplement(902), supplement(600, '2026-11-17')]), /injected_retain_failure/);
  assert.deepEqual(store.evidence(scope).map(row => row.event_id), ['existing']);
  assert.equal(store.supplements(scope)[0].total_seconds, 301);
  assert.equal(store.db.isTransaction, false);
  store.db.exec('DROP TRIGGER fail_supplement');
  store.retain(scope, [event('committed')], [supplement(902)]);
  assert.equal(store.evidence(scope).length, 2);
  assert.equal(store.supplements(scope)[0].total_seconds, 902);
});

test('save日报写入中途失败时周报和每日结果一起回滚，重试只递增一次版本', t => {
  const store = memoryStore(t);
  store.retain(scope, [event('first')], []);
  const original = save(store, sunday2200);
  const originalDays = store.db.prepare('SELECT day_json FROM weekly_day WHERE scope_key=? ORDER BY date').all(scope);
  store.retain(scope, [event('late', monday + 86400000)], []);
  store.db.exec(`CREATE TRIGGER fail_daily BEFORE INSERT ON weekly_day
    WHEN NEW.date='2026-11-18' BEGIN SELECT RAISE(ABORT,'injected_save_failure'); END;`);
  assert.throws(() => save(store, nextMonday), /injected_save_failure/);
  assert.deepEqual(store.report(scope, '2026-11-16'), original);
  assert.deepEqual(store.db.prepare('SELECT day_json FROM weekly_day WHERE scope_key=? ORDER BY date').all(scope), originalDays);
  assert.equal(store.db.isTransaction, false);
  store.db.exec('DROP TRIGGER fail_daily');
  const retry = save(store, nextMonday);
  assert.equal(retry.revision, original.revision + 1);
  assert.equal(retry.metrics.usage.total_seconds, 600);
});
