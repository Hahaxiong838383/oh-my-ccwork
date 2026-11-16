import { describe, expect, it } from 'vitest';
import { dateToday, emptyChild, emptyVisionMeasurements, initialState, normalizeVisionReport, promisePercent, publishedWeekRange, shouldRecall, updateDemo, type PromiseItem, type Task, type VisionReport } from '../src/model';

const date = '2026-09-18';

describe('开发预览：任务与奖励流水', () => {
  it('家长确认待完成奖励后只发放一次，一次性任务核销', () => {
    const before = initialState();
    const after = updateDemo(before, { type: 'task.confirm', id: 'task-reading', date });
    expect(after.balance).toBe(before.balance + 30);
    expect(after.tasks.some(t => t.id === 'task-reading')).toBe(false);
    expect(after.records[0]).toMatchObject({ amount: 30, date });
    expect(updateDemo(after, { type: 'task.confirm', id: 'task-reading', date })).toBe(after);
    expect(before.balance).toBe(1250);
  });
  it('进行中的任务不能直接发奖，重复任务演示达标后才可确认', () => {
    const before = initialState();
    expect(updateDemo(before, { type: 'task.confirm', id: 'task-frequency', date })).toBe(before);
    const completed = updateDemo(before, { type: 'task.complete', id: 'task-frequency' });
    const after = updateDemo(completed, { type: 'task.confirm', id: 'task-frequency', date });
    expect(after.balance).toBe(before.balance + 150);
    expect(after.tasks.find(t => t.id === 'task-frequency')).toMatchObject({ status: 'active', pendingReward: 0 });
    expect(updateDemo(after, { type: 'task.confirm', id: 'task-frequency', date })).toBe(after);
  });
  it('待确认不能修改/删除，每模板最多一个任务', () => {
    const before = initialState();
    const pending = before.tasks[0];
    expect(() => updateDemo(before, { type: 'task.delete', id: pending.id })).toThrow('待确认');
    expect(() => updateDemo(before, { type: 'task.save', task: pending })).toThrow('待确认');
    expect(() => updateDemo(before, { type: 'task.save', task: { ...before.tasks[1], id: 'duplicate' } })).toThrow('每个模板');
    const deleted = updateDemo(before, { type: 'task.delete', id: 'task-frequency' });
    const next = updateDemo(deleted, { type: 'task.save', task: { ...before.tasks[1], id: 'new' } });
    expect(next.tasks).toHaveLength(2);
  });
  it.each([{ minutes: 0 }, { minutes: 301 }, { reward: 501 }, { reward: -1 }, { days: 8 }, { days: 1.5 }])('拒绝越界任务设置 %j', invalid => {
    const state = initialState();
    const task = { ...state.tasks[1], ...invalid } as Task;
    expect(() => updateDemo(state, { type: 'task.save', task })).toThrow('允许范围');
  });
});

describe('开发预览：兑现扣币', () => {
  it('只有待兑现约定可扣币，同时核销约定并写一条流水', () => {
    const before = initialState();
    expect(updateDemo(before, { type: 'promise.redeem', id: 'promise-park', date })).toBe(before);
    const after = updateDemo(before, { type: 'promise.redeem', id: 'promise-sport', date });
    expect(after.balance).toBe(950);
    expect(after.promises.some(p => p.id === 'promise-sport')).toBe(false);
    expect(after.redeemedDate).toBe(date);
    expect(after.records[0]).toMatchObject({ amount: -300, title: '亲子约定 · 运动30分钟' });
    expect(updateDemo(after, { type: 'promise.redeem', id: 'promise-sport', date })).toBe(after);
  });
  it('两个待兑现约定竞争余额时，第二次不足不扣币、不记流水', () => {
    const before = { ...initialState(), balance: 500 };
    const promise: PromiseItem = { id: 'second', title: '买礼物', cost: 300, category: '购物类', status: 'pending', editedAt: date };
    before.promises.push(promise);
    const after = updateDemo(before, { type: 'promise.redeem', id: 'promise-sport', date });
    expect(after.balance).toBe(200);
    const count = after.records.length;
    expect(() => updateDemo(after, { type: 'promise.redeem', id: 'second', date })).toThrow('不足');
    expect(after.balance).toBe(200);
    expect(after.records).toHaveLength(count);
    expect(after.promises.some(p => p.id === 'second')).toBe(true);
  });
  it.each([0, -1, 1000, 1.2])('所需币数必须为1～999的整数：%s', cost => {
    const state = initialState();
    expect(() => updateDemo(state, { type: 'promise.save', item: { ...state.promises[1], cost } })).toThrow('1～999');
  });
  it('余额进度按比例计算并限制最大100%', () => {
    expect(promisePercent(1250, 1500)).toBe(83);
    expect(promisePercent(1250, 300)).toBe(100);
    expect(promisePercent(0, 300)).toBe(0);
  });
});

describe('开发预览：档案与状态', () => {
  it('演示登录只更改本机登录状态，不伪造设备绑定', () => {
    const after = updateDemo(initialState(), { type: 'account.login' });
    expect(after.loggedIn).toBe(true);
    expect(after.device).toBeNull();
    expect(after.child).toBeNull();
  });
  it('周报只在周日22点后切换到刚结束的一周', () => {
    expect(publishedWeekRange(new Date(2026, 9, 25, 21, 59))).toBe('10.12–10.18');
    expect(publishedWeekRange(new Date(2026, 9, 25, 22, 0))).toBe('10.19–10.25');
    expect(publishedWeekRange(new Date(2026, 9, 27, 12, 0))).toBe('10.19–10.25');
  });
  it('孩子昵称、出生年月的长度和时间边界受状态层约束', () => {
    const child = { ...emptyChild(), name: '一二三四五六七八九十', birthday: '2016-08' };
    expect(updateDemo(initialState(), { type: 'child.save', child }).child?.name).toBe(child.name);
    expect(() => updateDemo(initialState(), { type: 'child.save', child: { ...child, name: `${child.name}甲` } })).toThrow('10');
    expect(() => updateDemo(initialState(), { type: 'child.save', child: { ...child, birthday: '2099-01' } })).toThrow('出生年月');
  });
  it('dateToday 使用本地年月日而不是UTC日期', () => {
    expect(dateToday(new Date(2026, 0, 2, 3, 0, 0))).toBe('2026-01-02');
    expect(dateToday(new Date(2026, 9, 27, 23, 59, 59))).toBe('2026-10-27');
  });
  it('没有昵称或出生年月不能保存孩子档案', () => {
    const state = initialState();
    const child = { ...emptyChild(), name: '大妮', birthday: '2016-08' };
    expect(() => updateDemo(state, { type: 'child.save', child: { ...child, name: ' ' } })).toThrow('昵称');
    expect(() => updateDemo(state, { type: 'child.save', child: { ...child, birthday: '2016-13' } })).toThrow('出生年月');
  });
  it('拒绝空白/过长反馈', () => {
    const state = initialState();
    const item = { id: 'f', text: '', contact: '', date, imageCount: 0 };
    expect(() => updateDemo(state, { type: 'feedback.save', item })).toThrow('反馈');
    expect(() => updateDemo(state, { type: 'feedback.save', item: { ...item, text: 'a'.repeat(101) } })).toThrow('反馈');
  });
  it('召回按30天边界触发，并在30天内避免重复弹出', () => {
    const now = new Date('2026-10-27T00:00:00.000Z');
    const state = { ...initialState(), lastAppActiveAt: '2026-10-26T00:00:00.000Z', lastDeviceActiveAt: '2026-10-26T00:00:00.000Z' };
    expect(shouldRecall(state, now)).toBe(false);
    const inactive = { ...state, lastDeviceActiveAt: '2026-09-26T00:00:00.000Z' };
    expect(shouldRecall(inactive, now)).toBe(true);
    expect(shouldRecall({ ...inactive, lastRecallAt: '2026-10-01T00:00:00.000Z' }, now)).toBe(false);
  });
  it('设备设置只接受量产版允许的间隔和语音时长', () => {
    const state = initialState();
    expect(() => updateDemo(state, { type: 'settings.save', settings: { ...state.settings, interval: -1 } })).toThrow('设置');
    expect(() => updateDemo(state, { type: 'settings.save', settings: { ...state.settings, voiceLimit: '99小时' } })).toThrow('设置');
  });
  it('召回必须选择原因，仅其他原因强制填写说明', () => {
    const state = initialState();
    expect(() => updateDemo(state, { type: 'intercept.save', item: { id: 'r0', reason: '', text: '', date } })).toThrow('原因');
    const after = updateDemo(state, { type: 'intercept.save', item: { id: 'r1', reason: '没有时间', text: '', date } });
    expect(after.intercepts).toHaveLength(1);
    expect(() => updateDemo(state, { type: 'intercept.save', item: { id: 'r2', reason: '其他', text: '', date } })).toThrow('100字');
  });
  it('消息分类已读持久化且重复读取不重复记录', () => {
    const state = initialState();
    const after = updateDemo(state, { type: 'messages.read', category: '周报生成' });
    expect(after.readMessageCategories).toEqual(['周报生成']);
    expect(updateDemo(after, { type: 'messages.read', category: '周报生成' })).toBe(after);
  });
  it('移除示例设备置空关联页面，保留账号', () => {
    const before = { ...initialState(), loggedIn: true };
    const after = updateDemo(before, { type: 'device.remove' });
    expect(after).toMatchObject({ nickname: before.nickname, loggedIn: true, device: null, child: null, balance: 0, tasks: [], promises: [], records: [], reports: [] });
  });
});

describe('开发预览：视光报告', () => {
  it('拒绝不存在的检查日期、未来日期及越权编辑删除', () => {
    const measurements = emptyVisionMeasurements();
    measurements.axialLength = { right: 23, left: 23 };
    const report: VisionReport = { id: 'locked', examinationDate: '2026-02-31', ageYearsAtExamination: 10, centerId: null, centerName: '测试中心', measurements, source: 'cms', status: 'final', canEdit: false, canDelete: false };
    expect(() => updateDemo(initialState(), { type: 'report.save', report })).toThrow('日期');
    expect(() => updateDemo(initialState(), { type: 'report.save', report: { ...report, examinationDate: '2099-01-01' } })).toThrow('日期');
    const existing = { ...initialState(), reports: [{ ...report, examinationDate: '2026-02-28' }] };
    expect(() => updateDemo(existing, { type: 'report.save', report: existing.reports[0] })).toThrow('权限');
    expect(() => updateDemo(existing, { type: 'report.delete', id: 'locked' })).toThrow('权限');
  });
  it('保存终稿10组结构，并按检查日期倒序排列', () => {
    const state = initialState();
    const measurements = emptyVisionMeasurements();
    measurements.smallPupilSphere = { right: -1, left: -1 };
    measurements.axialLength = { right: 10, left: 10 };
    const report: VisionReport = { id: 'vision-1', examinationDate: '2025-12-10', ageYearsAtExamination: 12, centerId: null, centerName: '爱尔眼科', measurements, source: 'manual', status: 'final', canEdit: true, canDelete: true };
    const after = updateDemo(state, { type: 'report.save', report });
    expect(after.reports[0]).toEqual(report);
    expect(Object.keys(after.reports[0].measurements)).toHaveLength(10);
  });
  it('拒绝空中心或没有任何测量值的报告', () => {
    const report: VisionReport = { id: 'vision-empty', examinationDate: '2025-12-10', ageYearsAtExamination: 12, centerId: null, centerName: '', measurements: emptyVisionMeasurements(), source: 'manual', status: 'final', canEdit: true, canDelete: true };
    expect(() => updateDemo(initialState(), { type: 'report.save', report })).toThrow('视光中心');
    expect(() => updateDemo(initialState(), { type: 'report.save', report: { ...report, centerName: '爱尔眼科' } })).toThrow('至少填写');
  });
  it('旧版4字段草稿迁移到裸视和眼轴字段', () => {
    const migrated = normalizeVisionReport({ id: 'legacy', date: '2025-01-01', center: '旧中心', leftVision: 0.8, rightVision: 1, leftAxis: 23.5, rightAxis: 23.6 });
    expect(migrated.measurements.uncorrectedVisualAcuity).toEqual({ left: 0.8, right: 1 });
    expect(migrated.measurements.axialLength).toEqual({ left: 23.5, right: 23.6 });
    expect(migrated.status).toBe('draft');
  });
  it('读取字段不完整的旧报告时补齐其余10组空值', () => {
    const normalized = normalizeVisionReport({ id: 'partial', examinationDate: '2026-01-01', centerName: '测试中心', measurements: { axialLength: { left: 23, right: 23 } } });
    expect(normalized.measurements.axialLength.left).toBe(23);
    expect(normalized.measurements.smallPupilSphere).toEqual({ left: null, right: null });
  });
});
