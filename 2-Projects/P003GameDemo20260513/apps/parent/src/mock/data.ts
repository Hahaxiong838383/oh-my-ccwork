export type SuggestionStatus = '已收到' | '评估中' | '已采纳' | '进了金点子库';

export const childProfile = {
  name: '小明同学',
  phone: '123****8901',
  avatar: '明',
  status: '学习中',
  gender: '男',
  birthday: '2018-08',
};

export const homeStats = {
  focusToday: 10,
  weeklyAverage: 49,
  weeklyTotal: 320,
  nightReward: 28,
  device: {
    brightness: '中',
    colorTemperature: '常规',
    distance: '3.5m',
  },
  weeklyBars: [28, 42, 55, 49, 63, 37, 46],
};

export const weeklyReport = {
  highlights: ['专注时长比上周提升 18%', '已经连续坚持 5 天完成阅读计划'],
  eyeHealthRate: 92,
  guardedMinutes: 86,
  percentile: 78,
};

export const kidsHub = {
  level: 'Lv.6',
  title: '金点子小达人',
  acceptedCount: 7,
  signature: '小明同学',
  suggestions: [
    {
      summary: '希望小可在完成任务后讲一个海底小知识',
      date: '06-15',
      status: '进了金点子库' as SuggestionStatus,
    },
    {
      summary: '想让生态缸里的小鱼有自己的名字',
      date: '06-13',
      status: '已采纳' as SuggestionStatus,
    },
    {
      summary: '建议夜航结束时出现星星奖励动画',
      date: '06-11',
      status: '评估中' as SuggestionStatus,
    },
    {
      summary: '希望读完一本书可以点亮一个贝壳',
      date: '06-09',
      status: '已收到' as SuggestionStatus,
    },
  ],
};

export const menuItems = [
  { label: '孩子管理', badge: false },
  { label: '视光报告', badge: false },
  { label: '消息中心', badge: true },
  { label: '设置', badge: false },
  { label: '使用帮助', badge: false },
];
