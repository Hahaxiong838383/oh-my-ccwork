/**
 * 单元3：夜航报告引导（tutorial_night_report）· 配表数据
 *
 * 事实源：《A03 · 新手引导系统》（飞书 GxZ3wUt1YiqubNkLC2Fcdw4xnBh）单元3 配表（8 行）。
 * voiceCopy 逐字搬运（配表 step7 的 childname 统一为 {child_nickname} 占位）。
 * 配表 step8 行是 step7 等待期的提醒语（"30秒未应答提醒1次，循环3次后无反馈结束"），
 * 合并为 step '7' 的 remindCopy——与登舰 step6 同模式。
 *
 * 触发（产品）：专注引导完成后 + tutorial_night_report=false；首日满12h发放+额外宝箱。
 * 目标：理解离线收益机制，领取首日奖励。
 * demo 链条（川哥钦定）：登舰 → 设置 → 夜航（产品链是 专注→夜航，专注单元未建）。
 */
import type { TutorialStep, TutorialUnit } from './tutorial-types';

const NIGHT_REPORT_STEPS: TutorialStep[] = [
  {
    id: '1',
    specStep: '1',
    // 小可微笑歪头，出现在生态缸场景中央（背景复用登舰 ecopond 美术，风格天然衔接）
    expression: 'head-tilt',
    target: null,
    voiceCopy: '接下来由我来介绍一下方舟的夜航功能',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'pond-intro',
    isUnitEnd: false,
  },
  {
    id: '2',
    specStep: '2',
    // 遮罩突出物资堆/星尘展示区
    expression: 'head-tilt',
    target: null,
    voiceCopy:
      '在你离开的时候，方舟会为你自动收集星光。离开得越久，收集得越多——不过最多攒12个小时，满了就不会再涨了。所以记得每天都要来领哦，这样才不会亏！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'stardust-zone',
    isUnitEnd: false,
  },
  {
    id: '3',
    specStep: '3',
    expression: 'head-tilt',
    target: null,
    voiceCopy: '让我们来看看你来之前方舟收集了多少星光吧！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'stardust-zone',
    isUnitEnd: false,
  },
  {
    id: '4',
    specStep: '4',
    // 奖励到账特效：星尘/星光飞入资源栏（无语音纯特效，参考图=大星晶+X999+飞入顶栏）
    expression: 'head-tilt',
    target: null,
    voiceCopy: null,
    durationMs: 4_500,
    remindCopy: null,
    waitFor: null,
    hideAvatar: true,
    scene: 'reward-fly',
    isUnitEnd: false,
  },
  {
    id: '5',
    specStep: '5',
    expression: 'jump-joy',
    target: null,
    voiceCopy: '太棒了！你的夜航报告已到账——星尘到手啦！每天登陆飞船就能领',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'reward-fly',
    isUnitEnd: false,
  },
  {
    id: '6',
    specStep: '6',
    // 额外开箱彩蛋（配表 [05 吃惊]）
    expression: 'surprised',
    target: null,
    voiceCopy:
      '运气太好了！在领取夜航报告的时候，会有机会获得夜航宝箱，记得天天来哦，说不定哪天就会开出额外的宝箱！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'bonus-chest',
    isUnitEnd: false,
  },
  {
    id: '7',
    specStep: '7 / 8',
    // 唤醒词教学：等待孩子喊"小可小可"；配表 step8 行 = 本步提醒语（30s×3 无反馈结束+埋点）
    expression: 'head-tilt',
    target: 'wake-word',
    voiceCopy:
      "相信{child_nickname}指挥官已经了解了方舟的运行了，那么作为你忠实的伙伴，你可以随时喊我：小可小可，我就会随时响应你，现在就试试喊我'小可小可'吧",
    remindCopy: '指挥官，试着喊我："小可小可"吧，我可以陪你聊天哦~',
    waitFor: 'wake-word',
    hideAvatar: false,
    scene: 'wake-word',
    isUnitEnd: false,
  },
  {
    id: '8',
    specStep: '（demo 收尾）',
    // demo 补全收尾（配表无此行；依据 step7 原文"我就会随时响应你"）。
    // 文案对"喊了唤醒词"和"3 次提醒超时跳入"两条路径都成立
    expression: 'cheer',
    target: null,
    voiceCopy:
      "方舟的新手之旅全部完成啦！{child_nickname}指挥官，以后随时喊'小可小可'，我马上就会出现～",
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'wake-word',
    isUnitEnd: true,
  },
];

/**
 * step7 唤醒词（ASR 包含匹配；叠词整体匹配防误触——单个"小可"在闲聊里太常见，
 * 命中会吞掉 LLM 兜底，故只收双叠及同音变体）
 */
export const WAKE_HINTS = ['小可小可', '小科小科', '小克小克', '小棵小棵', '小刻小刻', '晓可晓可'];

export const NIGHT_REPORT_UNIT: TutorialUnit = {
  id: 'night-report',
  title: '夜航报告引导（单元3）',
  subtitle: '理解离线收益机制，领取首日奖励',
  emoji: '🌙',
  storageKey: 'kidshub.tutorial_night_report',
  navOrder: 30, // demo 链条第三站：登舰 → 设置 → 夜航
  steps: NIGHT_REPORT_STEPS,
};
