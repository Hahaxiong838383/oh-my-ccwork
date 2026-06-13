/**
 * 单元6：KidsHub 引导（tutorial_kidshub）· 配表数据
 *
 * 川哥 2026-06-13 新增需求：让孩子知道——通过 KidsHub 可以直接分享任何对产品的
 * 吐槽 / 改进建议 / 天马行空的想法，我们都会收到，且想尽办法去解决或实现。
 *
 * 体验链位置：夜航(40) → 【KidsHub(45)】→ 生态缸(50)。夜航复盘后孩子处于反思高点，
 * 最适合引入"你有什么想说的"（team 评审 gemini+codex 2:1 钦定此位）。
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
  // 体验链：夜航(40) → KidsHub(45) → 生态缸(50)
  navOrder: 45,
  outroCopy:
    '谢谢你愿意告诉我{child_nickname}！你的想法我都收好啦～接下来，我带你去看看方舟最温暖的地方——点一下「生态缸引导」吧！',
  nextUnitId: 'eco-pond',
  steps: KIDSHUB_STEPS,
};
