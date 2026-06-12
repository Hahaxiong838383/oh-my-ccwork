/**
 * 单元1：设置引导（tutorial_settings）· 配表数据
 *
 * 事实源：《A03 · 新手引导系统》（飞书 GxZ3wUt1YiqubNkLC2Fcdw4xnBh，2026-06 配表）。
 * voiceCopy 逐字搬运配表 voice_copy，不得在代码里改写产品话术；改动走产品文档再同步。
 * remindCopy / voiceHints / 跳过关键词为 demo 补全（gemini 按 A03 儿童文案原则产出）。
 *
 * 结构设计为 unit 无关：后续登舰/夜航/专注/生态缸单元复用同一引擎，只加数据。
 */

/** 引导内可交互的目标控件（MockSettingsPanel / SwipeZone 用同一套 key） */
export type TutorialTarget =
  | 'open-panel' // step2：下滑手势区 或 右上设置按钮
  | 'brightness'
  | 'volume'
  | 'color-temp'
  | 'light-off'
  | 'light-on'
  | 'close-panel'; // step5：上滑手势区 或 语音"准备好了"

export interface TutorialStep {
  /** demo 内部步骤 id（配表 3-x-1/3-x-2 的说明+等待两行合并为一步，phase 区分） */
  id: string;
  /** 配表原始 step 编号（调试流展示对账用） */
  specStep: string;
  /** 小可表情（现有注册表 id；配表 anim_type → 表情映射见下） */
  expression: string;
  /** 蒙版高亮 + 小手指向的目标控件；null = 无蒙版（小可正常出镜说话） */
  target: TutorialTarget | null;
  /** 语音文案 —— 配表 voice_copy 逐字，禁改 */
  voiceCopy: string;
  /** 30s 超时提醒文案（仅等待步有；第 3 次提醒追加 REMIND_FINAL_SUFFIX 后跳步） */
  remindCopy: string | null;
  /** 等待的用户操作；null = 纯播报步，说完自动进下一步 */
  waitFor: TutorialTarget | null;
  /** 3-x 步小可隐藏（配表"小可隐藏，显示小手指+蒙版"） */
  hideAvatar: boolean;
  /** 配表 is_unit_end=1：完成本步 = 单元完成 */
  isUnitEnd: boolean;
}

/** 配表 anim_type → 表情注册表 id（[09 打招呼大笑] / [16 微笑歪头] / [06 开心跳起]） */
export const ANIM_TO_EXPRESSION: Record<string, string> = {
  '09': 'hello-laugh',
  '16': 'head-tilt',
  '06': 'jump-joy',
};

export const SETTINGS_TUTORIAL_STEPS: TutorialStep[] = [
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

/** 第 3 次超时提醒后的过渡话术（播完自动跳下一步，配表"提醒3次无反应进入下一步"） */
export const REMIND_FINAL_SUFFIX = '没关系，这个操作指挥官肯定已经记在脑子里啦，我们先看下一个～';

/** 超时提醒间隔（配表：30 秒未操作重复提醒）与最大次数 */
export const REMIND_INTERVAL_MS = 30_000;
export const REMIND_MAX = 3;

/** step5 推进关键词（ASR final 包含匹配；ASR 同音误字多，禁精确匹配） */
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

/** 全程跳过关键词（任意步说出 = 想跳过引导） */
export const SKIP_HINTS = ['我会了', '不用教了', '跳过', '别教了', '关掉引导', '不想学了', '我已经懂了'];

/** 跳过时小可的回应（播完直接走完成流程） */
export const SKIP_RESPONSE = '原来指挥官已经是操作专家啦！那小可就不啰嗦了，我们直接开启冒险吧！';

/** 本地完成标记 key（文档：无法联网仅判断本地） */
export const TUTORIAL_SETTINGS_STORAGE_KEY = 'kidshub.tutorial_settings';

/**
 * 引导模式 LLM 兜底系统指令（ASR 不命中关键词时孩子的话会走正常 LLM 链路；
 * 进引导 / 换步时下发，让 LLM 简短回答后拉回当前步骤动作）
 */
export function buildTutorialSystemPrompt(step: TutorialStep): string {
  const goal = step.waitFor ? `教孩子${describeTarget(step.waitFor)}` : '给孩子讲解设置面板';
  const action = step.waitFor ? describeTarget(step.waitFor) : '听小可继续讲';
  return [
    '你现在是AI伙伴小可，正带"指挥官"（6~13岁孩子）进行读写台的设置引导。',
    `当前目标：${goal}；等待孩子的动作：${action}。`,
    '若孩子说无关话题，先用1-2句童趣、正向的话简短回答，然后必须立即用鼓励语气引导孩子完成上面的动作。',
    '严禁长篇大论，严禁脱离引导流程，每句不超过40字。',
  ].join('\n');
}

function describeTarget(target: TutorialTarget): string {
  switch (target) {
    case 'open-panel':
      return '下滑屏幕或点右上角设置按钮打开设置面板';
    case 'brightness':
      return '点击亮度条调整灯光亮度';
    case 'volume':
      return '按住拖动音量条调整声音大小';
    case 'color-temp':
      return '点击常规模式调节灯光颜色';
    case 'light-off':
      return '点击灯泡按钮关灯';
    case 'light-on':
      return '再点一次灯泡按钮开灯';
    case 'close-panel':
      return "说'准备好了'或往上滑关闭设置面板";
  }
}

export function getStepByIndex(index: number): TutorialStep | null {
  return SETTINGS_TUTORIAL_STEPS[index] ?? null;
}

/** ASR 文本是否命中关键词表（去空白 + 大小写不敏感的包含匹配） */
export function matchHints(text: string, hints: string[]): boolean {
  const normalized = text.replace(/\s+/g, '').toLowerCase();
  if (!normalized) return false;
  return hints.some((h) => normalized.includes(h.toLowerCase()));
}
