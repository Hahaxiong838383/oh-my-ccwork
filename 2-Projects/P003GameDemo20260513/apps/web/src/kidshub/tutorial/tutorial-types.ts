/**
 * 新手引导 · 共享类型与通用规则（unit 无关层）
 *
 * 事实源：《A03 · 新手引导系统》（飞书 GxZ3wUt1YiqubNkLC2Fcdw4xnBh）。
 * 单元数据各自一个文件（tutorial-settings.ts / tutorial-boarding.ts），注册表在 tutorial-units.ts。
 */

/** 引导内可交互的目标控件（各单元共用一个 key 空间） */
export type TutorialTarget =
  // —— 单元1 设置引导 ——
  | 'open-panel' // 下滑手势区 或 右上设置按钮
  | 'brightness'
  | 'volume'
  | 'color-temp'
  | 'light-off'
  | 'light-on'
  | 'close-panel' // 上滑手势区 或 语音"准备好了"
  // —— 单元2 登舰引导 ——
  | 'boot-button'; // 启动按钮 或 语音"登舰"

export interface TutorialStep {
  /** demo 内部步骤 id（配表 N-1/N-2 的说明+等待两行合并为一步，phase 区分） */
  id: string;
  /** 配表原始 step 编号（调试流展示对账用） */
  specStep: string;
  /** 小可表情（现有注册表 id；配表 anim_type → 表情映射） */
  expression: string;
  /** 蒙版高亮 + 小手指向的目标控件；null = 无蒙版 */
  target: TutorialTarget | null;
  /**
   * 语音文案 —— 配表 voice_copy 逐字，禁改。null = 无语音步（纯动画/音效），
   * 由 durationMs 定时推进。可含 {child_nickname} 占位（播放前注入工作台变量）
   */
  voiceCopy: string | null;
  /** 无语音步的演出时长（ms），定时推进下一步；有语音步忽略 */
  durationMs?: number;
  /** 30s 超时提醒文案（仅等待步有；第 3 次提醒追加 REMIND_FINAL_SUFFIX 后跳步） */
  remindCopy: string | null;
  /** 等待的用户操作；null = 纯播报/纯演出步，结束自动进下一步 */
  waitFor: TutorialTarget | null;
  /** 小可形象隐藏（配表"小可隐藏"或全屏剧情幕不出常驻形象） */
  hideAvatar: boolean;
  /** 剧情演出幕 key（登舰用：alert/storm/crash/rescue/celebrate；面板教学单元不填） */
  scene?: string;
  /** 配表 Voice effect：进入本步时播放的音效 */
  sound?: 'alarm';
  /** 配表 is_unit_end=1：完成本步 = 单元完成 */
  isUnitEnd: boolean;
}

/** 一个引导单元（配表一个章节 = 一个 unit，引擎按数据驱动，加单元不动引擎） */
export interface TutorialUnit {
  /** 'boarding' | 'settings' | 后续 'focus' / 'night-report' / 'eco-pond' */
  id: string;
  /** 入口卡标题（含配表单元号） */
  title: string;
  /** 入口副标题 = 配表"目标" */
  subtitle: string;
  emoji: string;
  /** 本地完成标记 key（按文档字段名 tutorial_xxx） */
  storageKey: string;
  /** 左栏入口排序：按产品流程（登舰最先，设置按需垫底） */
  navOrder: number;
  /**
   * 收尾衔接语（末步庆祝播完后追加播报，引导孩子进下一个单元；可含 {child_nickname}）。
   * 播完才真正 complete 退出
   */
  outroCopy?: string;
  /** 衔接指向的下一单元：入口卡在"本单元已完成、下一单元未完成"时显示"下一步"脉冲提示 */
  nextUnitId?: string;
  steps: TutorialStep[];
}

/** 超时提醒间隔（配表单元1 明确 30 秒；单元2 未写间隔，沿用同款）与最大次数 */
export const REMIND_INTERVAL_MS = 30_000;
export const REMIND_MAX = 3;

/** 第 3 次超时提醒后的过渡话术（播完自动跳下一步） */
export const REMIND_FINAL_SUFFIX = '没关系，这个操作指挥官肯定已经记在脑子里啦，我们先看下一个～';

/** 全程跳过关键词（任意步说出 = 想跳过引导） */
export const SKIP_HINTS = ['我会了', '不用教了', '跳过', '别教了', '关掉引导', '不想学了', '我已经懂了'];

/** 跳过时小可的回应（播完直接走完成流程） */
export const SKIP_RESPONSE = '原来指挥官已经是操作专家啦！那小可就不啰嗦了，我们直接开启冒险吧！';

/** ASR 文本是否命中关键词表（去空白 + 大小写不敏感的包含匹配；ASR 同音误字多，禁精确匹配） */
export function matchHints(text: string, hints: string[]): boolean {
  const normalized = text.replace(/\s+/g, '').toLowerCase();
  if (!normalized) return false;
  return hints.some((h) => normalized.includes(h.toLowerCase()));
}

/** 目标控件的孩子视角描述（LLM 兜底指令 + 拉回话术用） */
export function describeTarget(target: TutorialTarget): string {
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
    case 'boot-button':
      return "按一下屏幕中央的启动按钮，或者对小可说'登舰'";
  }
}

/**
 * 引导模式 LLM 兜底系统指令（ASR 不命中关键词时孩子的话走正常 LLM 链路；
 * 进引导/换步时下发，让 LLM 简短回答后拉回当前步骤动作）
 */
export function buildTutorialSystemPrompt(step: TutorialStep): string {
  const goal = step.waitFor ? `教孩子${describeTarget(step.waitFor)}` : '带孩子完成新手引导';
  const action = step.waitFor ? describeTarget(step.waitFor) : '听小可继续讲';
  return [
    '你现在是AI伙伴小可，正带"指挥官"（6~13岁孩子）进行读写台的新手引导。',
    `当前目标：${goal}；等待孩子的动作：${action}。`,
    '若孩子说无关话题，先用1-2句童趣、正向的话简短回答，然后必须立即用鼓励语气引导孩子完成上面的动作。',
    '严禁长篇大论，严禁脱离引导流程，每句不超过40字。',
  ].join('\n');
}
