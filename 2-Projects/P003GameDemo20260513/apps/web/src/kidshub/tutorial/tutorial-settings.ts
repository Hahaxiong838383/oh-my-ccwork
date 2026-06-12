/**
 * 单元1：设置引导（tutorial_settings）· 配表数据
 *
 * 事实源：《A03 · 新手引导系统》（飞书 GxZ3wUt1YiqubNkLC2Fcdw4xnBh，2026-06 配表）。
 * voiceCopy 逐字搬运配表 voice_copy，不得在代码里改写产品话术；改动走产品文档再同步。
 * remindCopy / voiceHints 为 demo 补全（gemini 按 A03 儿童文案原则产出）。
 *
 * 类型与通用规则在 tutorial-types.ts；单元注册表在 tutorial-units.ts。
 */
import type { TutorialStep, TutorialUnit } from './tutorial-types';

/** 配表 anim_type → 表情注册表 id（[09 打招呼大笑] / [16 微笑歪头] / [06 开心跳起]） */
export const ANIM_TO_EXPRESSION: Record<string, string> = {
  '09': 'hello-laugh',
  '16': 'head-tilt',
  '06': 'jump-joy',
};

const SETTINGS_STEPS: TutorialStep[] = [
  {
    id: '1',
    specStep: '1',
    expression: 'hello-laugh',
    target: null,
    voiceCopy: '想把灯光、亮度调到更舒服的状态吗？我来教你怎么调～',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    isUnitEnd: false,
  },
  {
    id: '2',
    specStep: '2',
    expression: 'head-tilt',
    target: 'open-panel',
    voiceCopy: '用手指往下滑，或者点击右上角的设置按钮，就能打开方舟的设置面板！',
    remindCopy: '指挥官，手指从屏幕最上方往下滑，就能看到方舟面板啦，快试试！',
    waitFor: 'open-panel',
    hideAvatar: false,
    isUnitEnd: false,
  },
  {
    id: '3-1',
    specStep: '3-1-1 / 3-1-2',
    expression: 'head-tilt',
    target: 'brightness',
    voiceCopy: '点击这里，可以调整灯光的亮度，试一试吧',
    remindCopy: '点一点这里的亮度条，看看灯光是不是变亮或者变暗了？',
    waitFor: 'brightness',
    hideAvatar: true,
    isUnitEnd: false,
  },
  {
    id: '3-2',
    specStep: '3-2-1 / 3-2-2',
    expression: 'praise',
    target: 'volume',
    voiceCopy: '指挥官真厉害！接下来按住拖动这里可以调整声音的大小',
    remindCopy: '试着按住音量条上下拖动，帮小可把声音调到最舒服的大小吧！',
    waitFor: 'volume',
    hideAvatar: true,
    isUnitEnd: false,
  },
  {
    id: '3-3',
    specStep: '3-3-1 / 3-3-2',
    expression: 'praise',
    target: 'color-temp',
    voiceCopy: '好聪明呀，点击这里可以调节灯光的颜色',
    remindCopy: '点点看这里，选一个你最喜欢的灯光颜色吧！',
    waitFor: 'color-temp',
    hideAvatar: true,
    isUnitEnd: false,
  },
  {
    id: '3-4',
    specStep: '3-4-1 / 3-4-2',
    expression: 'praise',
    target: 'light-off',
    voiceCopy: '太厉害了，点击这里可以开关灯光哦',
    remindCopy: '指挥官，试试点击这个小灯泡按钮，灯光就会休息一会儿哦！',
    waitFor: 'light-off',
    hideAvatar: true,
    isUnitEnd: false,
  },
  {
    id: '3-5',
    specStep: '3-5-1 / 3-5-2',
    expression: 'cheer',
    target: 'light-on',
    voiceCopy: '真棒，我们再试一下打开灯吧',
    remindCopy: '快把灯光唤醒吧！再点一次那个按钮，让方舟亮起来！',
    waitFor: 'light-on',
    hideAvatar: true,
    isUnitEnd: false,
  },
  {
    id: '4',
    specStep: '4',
    expression: 'head-tilt',
    target: null,
    voiceCopy:
      '屏幕下面还有两个小按钮，可以调整读写台的高度。把它调到适合你的高度，坐得舒服学习才更专心哦！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    isUnitEnd: false,
  },
  {
    id: '5',
    specStep: '5',
    expression: 'head-tilt',
    target: 'close-panel',
    voiceCopy: "快来试试吧~调好之后，告诉我'准备好了'——或者直接往上滑关闭界面就行啦！",
    remindCopy: '调好了就对我说"准备好了"，或者从屏幕中间往上划走它，我们继续出发！',
    waitFor: 'close-panel',
    hideAvatar: false,
    isUnitEnd: false,
  },
  {
    id: '6',
    specStep: '6',
    expression: 'jump-joy',
    target: null,
    voiceCopy: '调好啦！随时想调，下滑屏幕或者点击设置按钮就好啦。',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    isUnitEnd: true,
  },
];

/** step5 推进关键词（ASR final 包含匹配） */
export const READY_HINTS = [
  '准备好了',
  '准备好啦',
  '调好了',
  '弄好了',
  '弄好啦',
  '我好了',
  '搞定了',
  '完事了',
  '可以了',
  '好了',
  '欧克',
  'OK',
];

export const SETTINGS_UNIT: TutorialUnit = {
  id: 'settings',
  title: '设置引导（单元1 · 按需独立）',
  subtitle: '学会打开设置，调整到舒服状态',
  emoji: '🧭',
  storageKey: 'kidshub.tutorial_settings',
  navOrder: 90, // 按需独立单元，文档明确移出固定链 → 垫底
  steps: SETTINGS_STEPS,
};
