export type Tab = 'home' | 'weekly' | 'rewards' | 'kids' | 'mine';
export type TaskKind = 'reading' | 'frequency';
export type Task = {
  id: string;
  kind: TaskKind;
  title: string;
  minutes: number;
  days: number;
  reward: number;
  repeat: boolean;
  sync: boolean;
  status: 'active' | 'pending';
  pendingReward: number;
  editedAt: string;
};
export type PromiseItem = {
  id: string;
  title: string;
  category: '运动类' | '娱乐类' | '购物类' | '其他';
  cost: number;
  status: 'active' | 'pending';
  editedAt: string;
};
export type CoinRecord = { id: string; title: string; amount: number; date: string };
export const visionMetricDefinitions = [
  { code: 'smallPupilSphere', group: 'optometry', label: '小瞳', alias: '球镜DS', unit: '' },
  { code: 'dilatedPupilSphere', group: 'optometry', label: '散瞳', alias: '球镜DS', unit: '' },
  { code: 'subjectiveRefraction', group: 'optometry', label: '综散', alias: 'TA', unit: '' },
  { code: 'uncorrectedVisualAcuity', group: 'optometry', label: '裸视', alias: '视力', unit: '' },
  { code: 'correctedVisualAcuity', group: 'optometry', label: '矫视', alias: '视力', unit: '' },
  { code: 'axialLength', group: 'ocularBiometry', label: '眼轴', alias: 'AL', unit: 'mm' },
  { code: 'keratometryK1', group: 'ocularBiometry', label: 'K1', alias: '平角膜曲率', unit: '' },
  { code: 'keratometryK2', group: 'ocularBiometry', label: 'K2', alias: '陡角膜曲率', unit: '' },
  { code: 'anteriorChamberDepth', group: 'ocularBiometry', label: '前房', alias: 'AD ACD', unit: '' },
  { code: 'lensThickness', group: 'ocularBiometry', label: '晶厚', alias: 'LT', unit: '' },
] as const;
export type VisionMetricCode = typeof visionMetricDefinitions[number]['code'];
export type VisionMeasurements = Record<VisionMetricCode, { right: number | null; left: number | null }>;
export type VisionReport = {
  id: string;
  examinationDate: string;
  ageYearsAtExamination: number | null;
  centerId: string | null;
  centerName: string;
  measurements: VisionMeasurements;
  source: 'manual' | 'cms';
  status: 'draft' | 'final';
  canEdit: boolean;
  canDelete: boolean;
};
export type Suggestion = {
  id: string;
  title: string;
  date: string;
  updated: string;
  status: '已收到' | '评估中' | '已采纳' | '已进金点子库';
  version?: string;
};
export type Child = {
  avatar?: string;
  name: string;
  gender: '男' | '女';
  birthday: string;
  myopic: boolean;
  wearsGlasses: boolean;
  leftDegree: string;
  rightDegree: string;
  leftGlasses: string;
  rightGlasses: string;
};
export type DemoState = {
  version: 2;
  loggedIn: boolean;
  nickname: string;
  phone: string;
  profileAvatar?: string;
  child: Child | null;
  device: { name: string; sn: string; model: 'Max' | 'Ultra'; online: boolean; present: boolean } | null;
  settings: { posture: boolean; interval: number; voice: boolean; voiceLimit: string };
  balance: number;
  redeemedDate: string | null;
  lastAppActiveAt: string;
  lastDeviceActiveAt: string | null;
  lastRecallAt: string | null;
  tasks: Task[];
  promises: PromiseItem[];
  records: CoinRecord[];
  cards: { id: string; date: string; kind: '下发' | '使用'; note: string }[];
  weeklyEmpty: boolean;
  reports: VisionReport[];
  feedback: { id: string; text: string; contact: string; date: string; imageCount: number }[];
  intercepts: { id: string; reason: string; text: string; date: string }[];
  readMessageCategories: string[];
};

export const suggestions: Suggestion[] = [
  { id: 'idea-1', title: '坐姿提醒可以更温和一点吗？', date: '2026-09-08', updated: '2026-09-12', status: '已采纳', version: '示例版本' },
  { id: 'idea-2', title: '小可可以提醒我远眺休息吗？', date: '2026-09-06', updated: '2026-09-10', status: '评估中' },
  { id: 'idea-3', title: '我想给生态缸增加一盏星星灯', date: '2026-09-04', updated: '2026-09-07', status: '已进金点子库' },
  { id: 'idea-4', title: '完成学习后和我击个掌吧', date: '2026-09-02', updated: '2026-09-02', status: '已收到' },
];

export const emptyChild = (): Child => ({
  name: '', gender: '男', birthday: '', myopic: false, wearsGlasses: false,
  leftDegree: '', rightDegree: '', leftGlasses: '', rightGlasses: '',
});

export const emptyVisionMeasurements = (): VisionMeasurements => Object.fromEntries(
  visionMetricDefinitions.map(item => [item.code, { right: null, left: null }]),
) as VisionMeasurements;

export function normalizeVisionReport(report: VisionReport | Record<string, unknown>): VisionReport {
  if ('measurements' in report && report.measurements) {
    const current = report as VisionReport;
    const measurements = emptyVisionMeasurements();
    visionMetricDefinitions.forEach(item => {
      const value = current.measurements[item.code];
      measurements[item.code] = {
        right: typeof value?.right === 'number' && Number.isFinite(value.right) ? value.right : null,
        left: typeof value?.left === 'number' && Number.isFinite(value.left) ? value.left : null,
      };
    });
    return { ...current, centerId: typeof current.centerId === 'string' ? current.centerId : null, measurements };
  }
  const legacy = report as Record<string, unknown>;
  const measurements = emptyVisionMeasurements();
  measurements.uncorrectedVisualAcuity = {
    right: typeof legacy.rightVision === 'number' ? legacy.rightVision : null,
    left: typeof legacy.leftVision === 'number' ? legacy.leftVision : null,
  };
  measurements.axialLength = {
    right: typeof legacy.rightAxis === 'number' ? legacy.rightAxis : null,
    left: typeof legacy.leftAxis === 'number' ? legacy.leftAxis : null,
  };
  return {
    id: String(legacy.id || newId('vision')),
    examinationDate: String(legacy.date || dateToday()),
    ageYearsAtExamination: null,
    centerId: null,
    centerName: String(legacy.center || ''),
    measurements,
    source: 'manual', status: 'draft', canEdit: true, canDelete: true,
  };
}

export function initialState(): DemoState {
  return {
    version: 2,
    loggedIn: false,
    nickname: '138****8000',
    phone: '138****8000',
    child: null,
    device: null,
    settings: { posture: true, interval: 5, voice: true, voiceLimit: '24小时' },
    balance: 1250,
    redeemedDate: null,
    lastAppActiveAt: new Date().toISOString(),
    lastDeviceActiveAt: new Date().toISOString(),
    lastRecallAt: null,
    tasks: [
      { id: 'task-reading', kind: 'reading', title: '阅读打卡', minutes: 30, days: 1, reward: 30, repeat: false, sync: true, status: 'pending', pendingReward: 30, editedAt: '2026-09-10T08:00:00.000Z' },
      { id: 'task-frequency', kind: 'frequency', title: '使用频次打卡', minutes: 30, days: 5, reward: 150, repeat: true, sync: true, status: 'active', pendingReward: 0, editedAt: '2026-09-11T08:00:00.000Z' },
    ],
    promises: [
      { id: 'promise-sport', title: '运动30分钟', category: '运动类', cost: 300, status: 'pending', editedAt: '2026-09-10T08:00:00.000Z' },
      { id: 'promise-park', title: '去游乐园', category: '娱乐类', cost: 800, status: 'active', editedAt: '2026-09-11T08:00:00.000Z' },
    ],
    records: [
      { id: 'coin-1', title: '夜航', amount: 32, date: '2026-09-13' },
      { id: 'coin-2', title: '家长任务 · 阅读打卡', amount: 30, date: '2026-09-12' },
      { id: 'coin-3', title: '亲子约定 · 看电影1次', amount: -300, date: '2026-09-11' },
    ],
    cards: [
      { id: 'card-1', date: '2026-09-10', kind: '下发', note: '家长任务奖励补勤卡' },
      { id: 'card-2', date: '2026-09-11', kind: '下发', note: '亲子约定达成奖励补勤卡' },
      { id: 'card-3', date: '2026-09-13', kind: '使用', note: '孩子在设备端补勤使用' },
    ],
    weeklyEmpty: false,
    reports: [], feedback: [], intercepts: [], readMessageCategories: [],
  };
}

export type Action =
  | { type: 'app.open'; at: string; showRecall: boolean }
  | { type: 'messages.read'; category: string }
  | { type: 'task.save'; task: Task }
  | { type: 'task.delete'; id: string }
  | { type: 'task.complete'; id: string }
  | { type: 'task.confirm'; id: string; date: string }
  | { type: 'promise.save'; item: PromiseItem }
  | { type: 'promise.delete'; id: string }
  | { type: 'promise.request'; id: string }
  | { type: 'promise.redeem'; id: string; date: string }
  | { type: 'child.save'; child: Child }
  | { type: 'settings.save'; settings: DemoState['settings'] }
  | { type: 'device.save'; device: NonNullable<DemoState['device']> }
  | { type: 'device.remove' }
  | { type: 'account.login' }
  | { type: 'account.logout' }
  | { type: 'account.nickname'; value: string }
  | { type: 'account.profile'; nickname: string; avatar?: string }
  | { type: 'report.save'; report: VisionReport }
  | { type: 'report.delete'; id: string }
  | { type: 'feedback.save'; item: DemoState['feedback'][number] }
  | { type: 'intercept.save'; item: DemoState['intercepts'][number] }
  | { type: 'weeklyEmpty.toggle' };

export function updateDemo(state: DemoState, action: Action): DemoState {
  switch (action.type) {
    case 'task.save': {
      const task = action.task;
      const old = state.tasks.find(t => t.id === task.id);
      if (old?.status === 'pending') throw new Error('待确认任务不能修改');
      if (state.tasks.some(t => t.kind === task.kind && t.id !== task.id)) throw new Error('每个模板只能创建一个任务');
      if (!Number.isInteger(task.minutes) || task.minutes < 1 || task.minutes > 300 || !Number.isInteger(task.reward) || task.reward < 1 || task.reward > 500 || !Number.isInteger(task.days) || task.days < 1 || task.days > 7) throw new Error('任务数值超出允许范围');
      return { ...state, tasks: [...state.tasks.filter(t => t.id !== task.id), { ...task, status: 'active', pendingReward: 0 }] };
    }
    case 'task.delete':
      if (state.tasks.find(t => t.id === action.id)?.status === 'pending') throw new Error('待确认任务不能删除');
      return { ...state, tasks: state.tasks.filter(t => t.id !== action.id) };
    case 'task.complete':
      return { ...state, tasks: state.tasks.map(t => t.id === action.id && t.status === 'active' ? { ...t, status: 'pending', pendingReward: t.reward } : t) };
    case 'task.confirm': {
      const task = state.tasks.find(t => t.id === action.id);
      if (!task || task.status !== 'pending') return state;
      return {
        ...state, balance: state.balance + task.pendingReward,
        tasks: task.repeat ? state.tasks.map(t => t.id === task.id ? { ...t, status: 'active', pendingReward: 0 } : t) : state.tasks.filter(t => t.id !== task.id),
        records: [{ id: `income-${task.id}-${state.records.length}`, title: `家长任务 · ${task.title}`, amount: task.pendingReward, date: action.date }, ...state.records],
      };
    }
    case 'promise.save': {
      const item = action.item;
      if (state.promises.find(p => p.id === item.id)?.status === 'pending') throw new Error('待兑现约定请先处理');
      if (!item.title.trim() || item.title.length > 20) throw new Error('请填写20字以内的约定名称');
      if (!Number.isInteger(item.cost) || item.cost < 1 || item.cost > 999) throw new Error('所需奖励币为1～999');
      return { ...state, promises: [...state.promises.filter(p => p.id !== item.id), item] };
    }
    case 'promise.delete':
      return { ...state, promises: state.promises.filter(p => p.id !== action.id) };
    case 'promise.request': {
      const item = state.promises.find(p => p.id === action.id);
      if (!item || item.status === 'pending') return state;
      if (state.balance < item.cost) throw new Error('奖励币不足，继续完成任务吧');
      return { ...state, promises: state.promises.map(p => p.id === item.id ? { ...p, status: 'pending' } : p) };
    }
    case 'promise.redeem': {
      const item = state.promises.find(p => p.id === action.id);
      if (!item || item.status !== 'pending') return state;
      if (state.balance < item.cost) throw new Error('奖励币不足，暂时无法兑现');
      return {
        ...state, balance: state.balance - item.cost, redeemedDate: action.date,
        promises: state.promises.filter(p => p.id !== item.id),
        records: [{ id: `expense-${item.id}`, title: `亲子约定 · ${item.title}`, amount: -item.cost, date: action.date }, ...state.records],
      };
    }
    case 'app.open': return { ...state, lastAppActiveAt: action.at, lastRecallAt: action.showRecall ? action.at : state.lastRecallAt };
    case 'messages.read': return state.readMessageCategories.includes(action.category) ? state : { ...state, readMessageCategories: [...state.readMessageCategories, action.category] };
    case 'child.save':
      if (!action.child.name.trim() || !/^\d{4}-(0[1-9]|1[0-2])$/.test(action.child.birthday) || action.child.birthday > dateToday().slice(0, 7)) throw new Error('请填写孩子昵称和有效的出生年月');
      if (action.child.name.trim().length > 10) throw new Error('孩子昵称不能超过10个字');
      return { ...state, child: action.child };
    case 'settings.save':
      if (![5, 10, 15, 30].includes(action.settings.interval) || !Array.from({ length: 24 }, (_, i) => `${i + 1}小时`).includes(action.settings.voiceLimit)) throw new Error('设备设置超出允许范围');
      return { ...state, settings: action.settings };
    case 'device.save': return { ...state, device: action.device, lastDeviceActiveAt: new Date().toISOString() };
    case 'device.remove': return { ...initialState(), loggedIn: state.loggedIn, nickname: state.nickname, phone: state.phone, profileAvatar: state.profileAvatar, device: null, child: null, balance: 0, tasks: [], promises: [], records: [], cards: [], weeklyEmpty: false, reports: [], feedback: state.feedback, intercepts: state.intercepts };
    case 'account.login': return { ...state, loggedIn: true };
    case 'account.logout': return { ...state, loggedIn: false };
    case 'account.nickname': return { ...state, nickname: action.value.trim().slice(0, 10) || '未设置' };
    case 'account.profile': return { ...state, nickname: action.nickname.trim().slice(0, 10) || '未设置', profileAvatar: action.avatar };
    case 'report.save': {
      const report = action.report;
      if (!validPastDate(report.examinationDate) || !report.centerName.trim()) throw new Error('请选择有效检查日期并填写视光中心');
      if (state.reports.some(item => item.id === report.id && !item.canEdit)) throw new Error('没有编辑此报告的权限');
      const values = visionMetricDefinitions.flatMap(item => [report.measurements[item.code]?.right, report.measurements[item.code]?.left]);
      if (!values.some(value => value !== null && Number.isFinite(value))) throw new Error('请至少填写一项视光数据');
      if (values.some(value => value !== null && !Number.isFinite(value))) throw new Error('视光数据格式不正确');
      return { ...state, reports: [...state.reports.filter(r => r.id !== report.id), report].sort((a, b) => b.examinationDate.localeCompare(a.examinationDate)) };
    }
    case 'report.delete':
      if (state.reports.some(item => item.id === action.id && !item.canDelete)) throw new Error('没有删除此报告的权限');
      return { ...state, reports: state.reports.filter(r => r.id !== action.id) };
    case 'feedback.save':
      if (!action.item.text.trim() || action.item.text.length > 100) throw new Error('请填写100字以内的反馈');
      return { ...state, feedback: [action.item, ...state.feedback] };
    case 'intercept.save':
      if (!action.item.reason.trim()) throw new Error('请选择长时间未使用的原因');
      if (action.item.reason === '其他' && (!action.item.text.trim() || action.item.text.length > 100)) throw new Error('请填写100字以内的说明');
      return { ...state, intercepts: [action.item, ...state.intercepts] };
    case 'weeklyEmpty.toggle': return { ...state, weeklyEmpty: !state.weeklyEmpty };
  }
}

export const RECALL_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
export function shouldRecall(state: DemoState, now = new Date()) {
  if (state.lastRecallAt && now.getTime() - new Date(state.lastRecallAt).getTime() < RECALL_INTERVAL_MS) return false;
  return [state.lastAppActiveAt, state.lastDeviceActiveAt].some(value => {
    if (!value) return false;
    const elapsed = now.getTime() - new Date(value).getTime();
    return Number.isFinite(elapsed) && elapsed >= RECALL_INTERVAL_MS;
  });
}

export function promisePercent(balance: number, cost: number) {
  return Math.min(100, Math.max(0, Math.floor(balance / cost * 100)));
}
export const dateToday = (now = new Date()) => {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
function validPastDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > dateToday()) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
export function publishedWeekRange(now = new Date()) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  if (now.getDay() !== 0 || now.getHours() < 22) monday.setDate(monday.getDate() - 7);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const format = (date: Date) => `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
  return `${format(monday)}–${format(sunday)}`;
}
export const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
