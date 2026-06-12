/**
 * 新手引导单元注册表 —— 引擎按数据驱动，加单元只加数据文件 + 这里注册一行。
 * 左栏入口按 navOrder 排（产品流程：登舰最先；设置是按需独立单元垫底）。
 */
import type { TutorialStep, TutorialUnit } from './tutorial-types';
import { SETTINGS_UNIT } from './tutorial-settings';
import { BOARDING_UNIT } from './tutorial-boarding';
import { NIGHT_REPORT_UNIT } from './tutorial-night-report';
import { FOCUS_UNIT } from './tutorial-focus';
import { ECO_POND_UNIT } from './tutorial-eco-pond';

/** demo 体验链（川哥钦定登舰→设置插链；专注→夜航→生态缸为 A03 原链）：
 *  登舰(10) → 设置(20) → 专注(30) → 夜航(40) → 生态缸(50) */
export const TUTORIAL_UNITS: TutorialUnit[] = [
  BOARDING_UNIT,
  SETTINGS_UNIT,
  FOCUS_UNIT,
  NIGHT_REPORT_UNIT,
  ECO_POND_UNIT,
].sort((a, b) => a.navOrder - b.navOrder);

export function getUnit(unitId: string): TutorialUnit | null {
  return TUTORIAL_UNITS.find((u) => u.id === unitId) ?? null;
}

export function getUnitStep(unitId: string, index: number): TutorialStep | null {
  return getUnit(unitId)?.steps[index] ?? null;
}
