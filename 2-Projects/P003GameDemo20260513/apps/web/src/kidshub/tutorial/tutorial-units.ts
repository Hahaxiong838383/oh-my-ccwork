/**
 * 新手引导单元注册表 —— 引擎按数据驱动，加单元只加数据文件 + 这里注册一行。
 * 左栏入口按 navOrder 排（固定链：登舰→专注→夜航；生态缸/设置为独立触发单元）。
 */
import type { TutorialStep, TutorialUnit } from './tutorial-types';
import { SETTINGS_UNIT } from './tutorial-settings';
import { BOARDING_UNIT } from './tutorial-boarding';
import { NIGHT_REPORT_UNIT } from './tutorial-night-report';
import { FOCUS_UNIT } from './tutorial-focus';
import { KIDSHUB_UNIT } from './tutorial-kidshub';
import { ECO_POND_UNIT } from './tutorial-eco-pond';

/** demo 体验链（川哥 2026-06-13 调整六站全链）：
 *  登舰(10) → 设置(20) → 专注(30) → 夜航(40) → 生态缸(50) → KidsHub(55)。
 *  KidsHub 移到末站：玩完整套体验后，孩子表达"你有什么想说的"最自然（川哥拍板）。
 *  注：A03 文档 2.3 节的产品触发逻辑（设置/生态缸为独立触发）≠ demo 演示顺序——
 *  顺序改动以川哥拍板为准，勿因文档对账擅自重排。 */
export const TUTORIAL_UNITS: TutorialUnit[] = [
  BOARDING_UNIT,
  SETTINGS_UNIT,
  FOCUS_UNIT,
  NIGHT_REPORT_UNIT,
  KIDSHUB_UNIT,
  ECO_POND_UNIT,
].sort((a, b) => a.navOrder - b.navOrder);

export function getUnit(unitId: string): TutorialUnit | null {
  return TUTORIAL_UNITS.find((u) => u.id === unitId) ?? null;
}

export function getUnitStep(unitId: string, index: number): TutorialStep | null {
  return getUnit(unitId)?.steps[index] ?? null;
}
