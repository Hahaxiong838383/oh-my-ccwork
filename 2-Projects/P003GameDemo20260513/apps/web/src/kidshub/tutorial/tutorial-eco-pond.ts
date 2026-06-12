/**
 * 单元5：生态缸引导（tutorial_eco_pond）· 配表数据
 *
 * 事实源：《A03 · 新手引导系统》（飞书 GxZ3wUt1YiqubNkLC2Fcdw4xnBh）单元5 配表（4 行）。
 * voiceCopy 逐字搬运。
 *
 * 触发（产品）：tutorial_eco_pond=false，首次进入生态缸升级环节（本次替换原升级流程）。
 * 目标：介绍生态缸是方舟家园，建立情感连接和长期期待。
 * 文档：本单元结束 = 全部引导单元结束（无 outro 衔接）。
 */
import type { TutorialStep, TutorialUnit } from './tutorial-types';

const ECO_POND_STEPS: TutorialStep[] = [
  {
    id: '1',
    specStep: '1',
    expression: 'head-tilt',
    target: null,
    voiceCopy:
      '看，这就是方舟里的生态缸——它是你专属的家园！方舟里可以种植物、养小生物，越探索越丰富，全都等你来发现！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'pond-view',
    isUnitEnd: false,
  },
  {
    id: '2',
    specStep: '2',
    // 新获得的植物种子从地面升起，带着金色光芒解锁（无语音，纯解锁动画）
    expression: 'head-tilt',
    target: null,
    voiceCopy: null,
    durationMs: 4_000,
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'seed-rise',
    isUnitEnd: false,
  },
  {
    id: '3',
    specStep: '3',
    // 展示种子 + 全息信息卡显示植物名称
    expression: 'jump-joy',
    target: null,
    voiceCopy:
      '这是你的第一颗小种子！种下它，方舟里就会多一株小绿植陪你一起航行——经常来看它，它会慢慢长大，越变越漂亮的哦！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'seed-card',
    isUnitEnd: false,
  },
  {
    id: '4',
    specStep: '4',
    expression: 'head-tilt',
    target: null,
    voiceCopy:
      '小可最喜欢舱里的小绿植啦！方舟的生态缸会随着你的航行不断升级，每天坚持，就会有更多惊喜——让我们一起，把方舟变得越来越美吧！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'pond-finale',
    isUnitEnd: true,
  },
];

export const ECO_POND_UNIT: TutorialUnit = {
  id: 'eco-pond',
  title: '生态缸引导（单元5）',
  subtitle: '介绍生态缸是方舟家园，建立情感连接和长期期待',
  emoji: '🪴',
  storageKey: 'kidshub.tutorial_eco_pond',
  navOrder: 50, // demo 链终点站（文档：本单元结束 = 全部引导结束）
  steps: ECO_POND_STEPS,
};
