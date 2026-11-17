import { beforeEach, describe, expect, it, vi } from 'vitest';
import Taro from '@tarojs/taro';
import { snakeToCamel } from '../src/services/dto';
import { beijingWeekStart, getWeeklyReport, parseWeeklyReport, shiftWeek, WeeklyReportController } from '../src/services/weekly-report';
import { weeklyWire } from './weekly-report.fixture';
vi.mock('@tarojs/taro', () => ({ default: { getStorageSync: () => 'parent-test', request: vi.fn(), removeStorageSync: vi.fn() } }));
const report = () => parseWeeklyReport(snakeToCamel(weeklyWire()));
beforeEach(() => { vi.mocked(Taro.request).mockReset(); process.env.TARO_APP_API_BASE_URL = 'https://kidshub-ai.hahaxiong.cc'; });
describe('周报真实合同与生命周期', () => {
  it('按北京时间周一切周，UTC周日16点已进入下一自然周', () => {
    expect(beijingWeekStart(Date.parse('2026-11-15T15:59:59Z'))).toBe('2026-11-09');
    expect(beijingWeekStart(Date.parse('2026-11-15T16:00:00Z'))).toBe('2026-11-16');
    expect(shiftWeek('2026-11-16', -1)).toBe('2026-11-09');
  });
  it('原GET只读取data.report，经snake映射保留真实0、补充量和发布修订', async () => {
    vi.mocked(Taro.request).mockResolvedValue({ statusCode: 200, header: {}, data: { ok: true, data: { guarded_minutes: 999, report: weeklyWire() } } } as never);
    const r = await getWeeklyReport('dev_c', '2026-11-16');
    expect(r.metrics.postureReminders.value).toBe(0);
    expect(r.metrics.usage).toMatchObject({ totalSeconds: 10829, supplementalSeconds: 2148, dailyAverageSeconds: 1547, denominatorDays: 7 });
    expect(r.daily[0]).toMatchObject({ active: null, observedSeconds: null, supplementalSeconds: 902 });
    expect(r).toMatchObject({ revision: 2, status: 'revised', scope: { publicId: 'dev_c' } });
    expect(vi.mocked(Taro.request).mock.calls[0][0].url).toBe('https://kidshub-ai.hahaxiong.cc/v1/parent/devices/dev_c/weekly-report?week_start=2026-11-16');
  });
  it('提醒超参考值沿服务端合同保留673，不截断为672，旧报告无新增字段仍兼容', () => {
    const wire = weeklyWire();
    Object.assign(wire.metrics.posture_reminders, { value: 673, reference_max: 672, above_reference_max: true });
    const r = parseWeeklyReport(snakeToCamel(wire));
    expect(r.metrics.postureReminders).toMatchObject({ value: 673, referenceMax: 672, aboveReferenceMax: true });
    expect(parseWeeklyReport(snakeToCamel(weeklyWire())).metrics.postureReminders).toMatchObject({ value: 0, available: true });
  });
  it('旧字段和错设备/错周期200不伪装成所选设备周报', async () => {
    for (const data of [{ guarded_minutes: 0, posture_reminder_count: 0 }, { report: { ...weeklyWire(), scope: { kind: 'device', public_id: 'dev_other' } } }, { report: { ...weeklyWire(), week_start: '2026-11-09' } }]) {
      vi.mocked(Taro.request).mockResolvedValue({ statusCode: 200, header: {}, data: { ok: true, data } } as never);
      await expect(getWeeklyReport('dev_c', '2026-11-16')).rejects.toMatchObject({ status: 502 });
    }
  });
  it('合法空report表明当前绑定无周报资格，清空旧报告且不降级到旧指标', async () => {
    vi.mocked(Taro.request).mockResolvedValueOnce({ statusCode: 200, header: {}, data: { ok: true, data: { report: weeklyWire() } } } as never);
    const lost: number[] = [], c = new WeeklyReportController(week => getWeeklyReport('dev_c', week), status => lost.push(status), '2026-11-16');
    await c.refresh(); expect(c.state.report?.metrics.activeDays.value).toBe(1);
    vi.mocked(Taro.request).mockResolvedValue({ statusCode: 200, header: {}, data: { ok: true, data: { week_start: '2026-11-16', guarded_minutes: 99, posture_alert_count: 10, report: null, report_unavailable_reason: 'current_binding_unavailable' } } } as never);
    await c.refresh();
    expect(c.state.report).toBeNull(); expect(c.state.error).toContain('当前绑定尚不具备周报读取条件');
    expect(c.state.error).not.toContain('读取失败'); expect(c.state.loaded).toBe(true); expect(lost).toEqual([]);
  });
  it('某指标缺失或非法值保持独立不可用，不能把null或负数转成0', () => {
    const value = snakeToCamel(weeklyWire()) as any;
    value.metrics.postureReminders = { available: false, reason: 'no_reminder_events', value: null };
    value.metrics.usage.dailyAverageSeconds = -1;
    const r = parseWeeklyReport(value);
    expect(r.metrics.postureReminders.value).toBeNull();
    expect(r.metrics.usage.available).toBe(false);
    expect(r.metrics.usage.dailyAverageSeconds).toBeNull();
    expect(r.metrics.activeDays.value).toBe(1);
  });
  it('切周后迟到成功和失败均不能覆盖当前周期或触发退出', async () => {
    let finish!: (value: any) => void; let fail!: (reason: any) => void; const lost: number[] = [];
    const c = new WeeklyReportController(week => week === '2026-11-16' ? new Promise((resolve, reject) => { finish = resolve; fail = reject; }) : Promise.resolve({ ...report(), weekStart: week }), code => lost.push(code), '2026-11-16');
    const old = c.refresh(); await c.refresh('2026-11-09'); finish(report()); await old;
    expect(c.state.report?.weekStart).toBe('2026-11-09');
    const oldError = c.refresh('2026-11-16'); await c.refresh('2026-11-09'); fail({ status: 401 }); await oldError;
    expect(lost).toEqual([]); expect(c.state.report?.weekStart).toBe('2026-11-09');
  });
  it('切设备/退出卸载销毁后迟到响应不恢复周报', async () => {
    let finish!: (value: any) => void; const c = new WeeklyReportController(() => new Promise(resolve => { finish = resolve; }));
    const pending = c.refresh(); c.dispose(); finish(report()); await pending;
    expect(c.state.report).toBeNull(); expect(c.state.busy).toBe(false);
  });
  it('刷新失败保留同周报告；换周失败清旧报告；401/403/404清空并通知父级', async () => {
    for (const status of [401, 403, 404, 503]) {
      let n = 0; const lost: number[] = []; const c = new WeeklyReportController(async () => { if (++n === 1) return report(); throw { status }; }, s => lost.push(s), '2026-11-16');
      await c.refresh(); await c.refresh();
      expect(c.state.report === null).toBe(status !== 503);
      expect(lost).toEqual(status === 503 ? [] : [status]);
      if (status === 503) { await c.refresh('2026-11-09'); expect(c.state.report).toBeNull(); expect(c.state.error).toContain('失败'); }
    }
  });
});
