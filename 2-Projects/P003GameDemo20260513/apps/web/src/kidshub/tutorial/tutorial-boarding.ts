/**
 * 单元2：登舰引导（tutorial_boarding）· 配表数据
 *
 * 事实源：《A03 · 新手引导系统》（飞书 GxZ3wUt1YiqubNkLC2Fcdw4xnBh）单元2 配表（7 行）。
 * voiceCopy 逐字搬运，禁改；{child_nickname} 占位播放前注入工作台 nickname 变量。
 * 配表 step6 行是 step5 等待期的提醒语（"画面不变化；提示3次仍无反应自动下一步"），
 * 合并为 step '5' 的 remindCopy；提醒间隔配表未写，沿用单元1 的 30s。
 *
 * 触发（产品）：首次开盖 tutorial_boarding=false。demo：左栏入口（排首位，破冰第一步）。
 * 目标：完成世界观导入和身份认证，获得新手光环。
 * 结束链（产品，2026-06-12 配表定稿）：→ 专注模式引导（首日默认陪伴，跳过状态询问）+ 开启 OTA 检测。
 */
import type { TutorialStep, TutorialUnit } from './tutorial-types';

const BOARDING_STEPS: TutorialStep[] = [
  {
    id: '1',
    specStep: '1',
    // 全黑屏幕 + 警报音效 + 红色警告闪烁（无语音；配表 1~3 步为 5 秒全屏统一动画）
    expression: 'net-fail',
    target: null,
    voiceCopy: null,
    durationMs: 5_000,
    remindCopy: null,
    waitFor: null,
    hideAvatar: true,
    scene: 'alert',
    sound: 'alarm',
    isUnitEnd: false,
  },
  {
    id: '2',
    specStep: '2',
    // 方舟飞船穿越紫色星云，太空风暴背景，画面震动（无语音纯转场）
    expression: 'net-fail',
    target: null,
    voiceCopy: null,
    durationMs: 5_000,
    remindCopy: null,
    waitFor: null,
    hideAvatar: true,
    scene: 'storm',
    isUnitEnd: false,
  },
  {
    id: '3',
    specStep: '3',
    // 小可滑入摔倒，表情焦急，面罩暗淡（无语音纯表演；演出由 scene 'crash' 负责，
    // 大号小可在幕内渲染，常驻右下形象隐藏防重影）
    expression: 'net-sad',
    target: null,
    voiceCopy: null,
    durationMs: 5_000,
    remindCopy: null,
    waitFor: null,
    hideAvatar: true,
    scene: 'crash',
    isUnitEnd: false,
  },
  {
    id: '4',
    specStep: '4',
    // 受损舱内全屏原画，小可严肃求助（confused-wave = 歪头挥手求助，27 表情库最贴近"伸出手臂请求帮助"）
    expression: 'confused-wave',
    target: null,
    voiceCopy:
      '{child_nickname}！终于等到你了——方舟遭遇了空间风暴，受损严重！我们需要一名指挥官来重启方舟，快帮帮我！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'rescue',
    isUnitEnd: false,
  },
  {
    id: '5',
    specStep: '5 / 6',
    // 惊喜 + 启动按钮浮现；等待点按钮或语音"登舰"；配表 step6 行 = 本步提醒语
    expression: 'surprised',
    target: 'boot-button',
    voiceCopy:
      "你就是那位新指挥官！快来按一下启动按钮——或者直接对我说'登舰'，我们就能重启方舟啦！",
    remindCopy: "{child_nickname}，我在这里等你哦——按一下启动按钮，或者喊我'登舰'！",
    waitFor: 'boot-button',
    hideAvatar: false,
    scene: 'rescue',
    isUnitEnd: false,
  },
  {
    id: '7',
    specStep: '7',
    // 黑屏转场 + 生态缸缓慢点亮 + [06 开心跳起] + 金色粒子
    expression: 'jump-joy',
    target: null,
    voiceCopy: '验证成功！欢迎登舰，我的指挥官 {child_nickname}！',
    remindCopy: null,
    waitFor: null,
    hideAvatar: false,
    scene: 'celebrate',
    isUnitEnd: true,
  },
];

/** step5 推进关键词（ASR 包含匹配；含常见同音误字） */
export const BOARDING_HINTS = ['登舰', '登见', '登建', '登剑', '灯舰', '启动方舟', '启动', '出发'];

export const BOARDING_UNIT: TutorialUnit = {
  id: 'boarding',
  title: '登舰引导（单元2 · 首次开盖）',
  subtitle: '完成世界观导入和身份认证，获得新手光环',
  emoji: '🚀',
  storageKey: 'kidshub.tutorial_boarding',
  navOrder: 10, // 破冰第一步，产品流程最先 → 入口排首位
  // demo 衔接（按 2026-06-12 配表固定链 登舰→专注）：庆祝后口播引导去专注模式引导
  outroCopy:
    '{child_nickname}指挥官，方舟启动成功啦！接下来我教你方舟最重要的本领——点一下左边的「专注模式引导」吧！',
  nextUnitId: 'focus',
  steps: BOARDING_STEPS,
};
