/**
 * 单元6：KidsHub 引导（tutorial_kidshub）· 配表数据
 *
 * 川哥 2026-06-13 新增需求：让孩子知道——通过 KidsHub 可以直接分享任何对产品的
 * 吐槽 / 改进建议 / 天马行空的想法，我们都会收到，且想尽办法去解决或实现。
 *
 * 体验链位置（川哥 2026-06-13 调整）：夜航(40) → 生态缸(50) → 【KidsHub(55)】，KidsHub 移到末站收尾。
 * 玩完整套体验后，孩子表达"你有什么想说的"最自然，故移到全链最后一站。
 *
 * 话术对齐 card5「KidsHub 情绪回应」现有口径：四正面态（已收到 / 评估中 / 已采纳 /
 * 进金点子库），绝不过度承诺"马上改 / 一定改"，用"我们都会认真看 + 想办法实现"。
 * 末步"试一句"邀请孩子开口——本单元 active 期间 captureMode=feedback（source=tutorial），
 * 孩子此时说的话会被需求2 链路捕获落库（后台可一键过滤引导来源）。
 */
import type { TutorialStep, TutorialUnit } from './tutorial-types';

const KIDSHUB_STEPS: TutorialStep[] = [
  {
    id: '1',
    specStep: '1',
    expression: 'head-tilt',
    target: null,
    voiceCopy:
      '对了{child_nickname}，告诉你一个方舟的小秘密——你有任何想法，不管是觉得哪里不好玩、想让我改改，还是天马行空的点子，都可以直接说给我听！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    isUnitEnd: false,
  },
  {
    id: '2',
    specStep: '2',
    expression: 'jump-joy',
    target: null,
    voiceCopy:
      '我会把它们送进一个叫 KidsHub 的地方——那是方舟收集大家心愿的小本子。你说的每一句，我们都会认真看，然后想尽办法去把它变成真的！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    isUnitEnd: false,
  },
  {
    id: '3',
    specStep: '3',
    expression: 'cheer',
    target: null,
    voiceCopy:
      '现在就试试看吧——悄悄告诉我一个你的想法，好不好？说完我会把它记进 KidsHub，和大家的点子一起，认真看哦！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    isUnitEnd: true,
  },
];

export const KIDSHUB_UNIT: TutorialUnit = {
  id: 'kidshub',
  title: 'KidsHub 引导（单元6）',
  subtitle: '让孩子知道：任何想法/吐槽都能告诉小可，我们都会收到并努力实现',
  emoji: '💡',
  storageKey: 'kidshub.tutorial_kidshub',
  // 体验链（川哥 2026-06-13 调整）：夜航(40) → 生态缸(50) → KidsHub(55)，KidsHub 为末站
  navOrder: 55,
  // 末站（无 nextUnitId）。需求1 修复（grok HIGH）：KidsHub 末步「试一句」是邀请孩子吐槽，
  // 故意不配 outroCopy——否则邀请播完会抢在孩子开口前播"感谢+全部完成"，顺序反了。
  // 邀请(step3)播完 → 进 handoff（UI 只显示「完成体验/再来一次」+ 小可静默等）；孩子此刻吐槽
  // 走 handoff 放行的 LLM 吐槽人格回应并落库（TutorialManager onAsrFinal 对 kidshub 单元放行）。
  steps: KIDSHUB_STEPS,
};
