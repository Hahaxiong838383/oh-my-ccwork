/**
 * 单元4：专注模式引导（tutorial_focus）· 配表数据
 *
 * 事实源：《A03 · 新手引导系统》（飞书 GxZ3wUt1YiqubNkLC2Fcdw4xnBh）单元4 配表（9 行）。
 * voiceCopy 逐字搬运；step7 配表无提醒行，remindCopy 为 demo 补全（A03 儿童文案原则）。
 * step8 配表 voice_copy 为「"哇——！"（小可惊喜音效）」——demo 无音效资产，走 TTS 短叹词。
 *
 * 触发（产品）：登舰引导完成后直接进入 + tutorial_focus=false；首日默认陪伴、
 * 不显示探索/陪伴按钮。目标：理解专注→攒宝箱→开箱循环，体验开箱爽感。
 * 结束链（产品）：→ 夜航报告引导，并开启夜航报告功能。
 */
import type { TutorialStep, TutorialUnit } from './tutorial-types';

const FOCUS_STEPS: TutorialStep[] = [
  {
    id: '1',
    specStep: '1',
    // 专注模式界面（进度条在屏幕上、生态缸为背景、不显示探索/陪伴按钮）
    expression: 'hello-laugh',
    target: null,
    voiceCopy:
      '方舟各项指标正常，启动成功！做个自我介绍，我叫小可，是你的方舟搭档，这艘方舟承载着无数生灵的希望——从今天起，你就是我的指挥官啦！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'focus-intro',
    isUnitEnd: false,
  },
  {
    id: '2',
    specStep: '2',
    expression: 'head-tilt',
    target: null,
    voiceCopy:
      '作为方舟的领导者，你要坐得稳稳的哦！背挺直、眼睛离屏幕一个小拳头那么远——这样方舟跑得更快，你的眼睛也更舒服啦！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'focus-intro',
    isUnitEnd: false,
  },
  {
    id: '3',
    specStep: '3',
    // 进度条机制讲解（演出层高亮进度条）
    expression: 'head-tilt',
    target: null,
    voiceCopy:
      '接下来看这里——方舟会把你坐着的时间变成收集进度。坐的久，进度就会不断增长——满了就会收集到一个宝箱！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'focus-progress',
    isUnitEnd: false,
  },
  {
    id: '4',
    specStep: '4',
    expression: 'head-tilt',
    target: null,
    voiceCopy: '我们先来试一次——现在就开始计时！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'focus-progress',
    isUnitEnd: false,
  },
  {
    id: '5',
    specStep: '5',
    // 5 秒专注倒计时动画，进度条逐渐填满（无语音）
    expression: 'head-tilt',
    target: null,
    voiceCopy: null,
    durationMs: 5_500,
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'focus-counting',
    isUnitEnd: false,
  },
  {
    id: '6',
    specStep: '6',
    expression: 'surprised',
    target: null,
    voiceCopy: '满了！你看——宝箱来啦！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'chest-ready',
    isUnitEnd: false,
  },
  {
    id: '7',
    specStep: '7',
    // 等待点击"获取奖励"（配表 interaction_type=1 点击 + voice_hint"打开"）
    expression: 'head-tilt',
    target: 'claim-reward',
    voiceCopy: '快来点击打开它，看看里面有什么！',
    remindCopy: '指挥官，点一下发光的宝箱，奖励就是你的啦！',
    waitFor: 'claim-reward',
    hideAvatar: false,
    scene: 'chest-ready',
    isUnitEnd: false,
  },
  {
    id: '8',
    specStep: '8',
    // 开箱动画 + 礼花（配表 voice_copy="哇——！"小可惊喜音效，demo 用 TTS 短叹词）
    expression: 'surprised',
    target: null,
    voiceCopy: '哇——！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'chest-open',
    isUnitEnd: false,
  },
  {
    id: '9',
    specStep: '9',
    expression: 'jump-joy',
    target: null,
    voiceCopy:
      '太厉害了！坐得越久，宝箱越丰富——下次坚持更久，宝箱品质会更好哦！坚持每天给方舟充能，你的家园会越来越漂亮的！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'focus-summary',
    isUnitEnd: true,
  },
];

/** step7 推进关键词（配表 voice_hint"打开"+ 同义口语） */
export const CLAIM_HINTS = ['打开', '开箱', '打开宝箱', '获取奖励', '开宝箱', '领奖励'];

export const FOCUS_UNIT: TutorialUnit = {
  id: 'focus',
  title: '专注模式引导（单元4）',
  subtitle: '理解专注→攒宝箱→开箱循环，体验开箱爽感',
  emoji: '📦',
  storageKey: 'kidshub.tutorial_focus',
  navOrder: 20, // 固定链第二站（2026-06-12 配表定稿：登舰 → 专注 → 夜航）
  outroCopy:
    '专注的秘密你已经掌握啦！接下来我给你看看方舟夜里偷偷干了什么——点一下「夜航报告引导」吧！',
  nextUnitId: 'night-report',
  steps: FOCUS_STEPS,
};
