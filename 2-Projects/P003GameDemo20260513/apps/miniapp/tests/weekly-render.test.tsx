import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WeeklyReportContent } from '../src/pages/index/weekly-report';
import { parseWeeklyReport } from '../src/services/weekly-report';
import { snakeToCamel } from '../src/services/dto';
import { weeklyWire } from './weekly-report.fixture';
vi.mock('@tarojs/taro', () => ({ default: {} }));
vi.mock('@tarojs/components', async () => { const R = await import('react'); const tag = (name: string) => (p: any) => R.createElement(name, { className: p.className }, p.children); return { View: tag('div'), Text: tag('span'), Button: tag('button') }; });
vi.mock('../src/pages/index/components', async () => { const R = await import('react'); return { Card: (p: any) => R.createElement('section', {}, p.children), Heading: (p: any) => R.createElement('h2', {}, p.title) }; });
const fixture = () => parseWeeklyReport(snakeToCamel(weeklyWire()));
describe('同源周报可见证据', () => {
  it('显示三指标、真实与补充、分母及缺测范围、发布修订和每日证据', () => {
    const html = renderToStaticMarkup(<WeeklyReportContent report={fixture()} />);
    for (const text of ['已修订', '版本 2', '首次发布', '统计区间截至', '已上报 0 次', '已同步折算日均', '25.8 分钟', '分母 7 天', '已确认 1 天', '真实计时 180 分 29 秒', '补充计算 35 分 48 秒', '最长连续 715.516 秒', '未能确认', '2026-11-16', '覆盖不足', '不是眼睛健康程度']) expect(html).toContain(text);
    expect(html).not.toContain('guarded_minutes');
  });
  it('指标缺测和失败独立呈现，奖励补充不能显示成真实时长或活跃0天', () => {
    const r = fixture();
    r.metrics.postureReminders = { available: false, reason: 'dependency_unavailable', updatedAtMs: null, value: 99 };
    r.metrics.usage = { ...r.metrics.usage, available: false, reason: 'no_focus_segments', totalSeconds: null, dailyAverageSeconds: null, supplementalSeconds: 902 };
    r.metrics.activeDays = { ...r.metrics.activeDays, available: false, reason: 'no_focus_segments', value: null };
    r.daily = r.daily.slice(0, 1);
    const html = renderToStaticMarkup(<WeeklyReportContent report={r} />);
    expect(html).toContain('计算依赖暂不可用'); expect(html).toContain('暂无数据'); expect(html).toContain('补充计算 15 分 2 秒');
    expect(html).not.toContain('99 次'); expect(html).not.toContain('已确认 0 天'); expect(html).not.toContain('真实计时 0'); expect(html).not.toContain('提醒 0 次');
  });
  it('本周统计中不宣称完整周，未来日期待统计，未达5分钟不叫未使用', () => {
    const r = fixture(); r.status = 'collecting'; r.publishedAtMs = null;
    r.daily[0].reason = 'pending'; r.daily[1].active = false;
    const html = renderToStaticMarkup(<WeeklyReportContent report={r} />);
    expect(html).toContain('统计中'); expect(html).toContain('累计预览'); expect(html).toContain('尚未发布'); expect(html).toContain('待统计'); expect(html).toContain('未达连续5分钟');
    expect(html).not.toContain('完整周报'); expect(html).not.toContain('· 未使用');
  });
  it('依赖故障保留结果必须说明旧周报或旧补充量，不能包装成刚完成计算', () => {
    const expected = [
      ['retained_dependency_unavailable', '当前显示上次保存的周报'],
      ['partial_history_retained_supplement', '已保留此前保存的补充计算'],
      ['partial_history_supplement_unavailable', '补充数据暂不可用'],
    ];
    for (const [reason, text] of expected) {
      const r = fixture(); r.coverage.reason = reason;
      const html = renderToStaticMarkup(<WeeklyReportContent report={r} />);
      expect(html).toContain(text); expect(html).toContain('25.8 分钟'); expect(html).not.toContain(reason);
    }
  });
  it('超参考次数保留真实数并提示待核，672正常范围和旧报告不报警', () => {
    const wire = weeklyWire();
    Object.assign(wire.metrics.posture_reminders, { value: 673, reference_max: 672, above_reference_max: true });
    const html = renderToStaticMarkup(<WeeklyReportContent report={parseWeeklyReport(snakeToCamel(wire))} />);
    expect(html).toContain('已上报 673 次'); expect(html).toContain('高于参考672次'); expect(html).toContain('保留真实记录待核对');
    Object.assign(wire.metrics.posture_reminders, { value: 672, above_reference_max: false });
    const atLimit = renderToStaticMarkup(<WeeklyReportContent report={parseWeeklyReport(snakeToCamel(wire))} />);
    expect(atLimit).toContain('已上报 672 次'); expect(atLimit).not.toContain('待核对');
    expect(renderToStaticMarkup(<WeeklyReportContent report={fixture()} />)).not.toContain('待核对');
  });
  it('周日22点首版明确本周未结束，区间截止与补传后的更新时间分开', () => {
    const r = fixture(); r.status = 'published'; r.dataCutoffAtMs = Date.parse('2026-11-22T14:00:00Z'); r.periodEndMs = Date.parse('2026-11-22T16:00:00Z');
    r.updatedAtMs = Date.parse('2026-11-23T01:00:00Z'); r.sourceUpdatedAtMs = Date.parse('2026-11-23T00:59:00Z');
    const html = renderToStaticMarkup(<WeeklyReportContent report={r} />);
    expect(html).toContain('已发布（本周未结束）'); expect(html).toContain('统计区间截至 2026-11-22 22:00:00');
    expect(html).toContain('报告更新于 2026-11-23 09:00:00'); expect(html).toContain('来源记录更新时间 2026-11-23 08:59:00');
    r.dataCutoffAtMs = r.periodEndMs;
    expect(renderToStaticMarkup(<WeeklyReportContent report={r} />)).not.toContain('本周未结束');
  });
});
