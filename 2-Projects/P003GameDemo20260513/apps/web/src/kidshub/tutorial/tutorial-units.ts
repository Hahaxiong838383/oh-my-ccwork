/**
 * 新手引导单元注册表 —— 引擎按数据驱动，加单元只加数据文件 + 这里注册一行。
 * 左栏入口按 navOrder 排（产品流程：登舰最先；设置是按需独立单元垫底）。
 */
import type { TutorialStep, TutorialUnit } from './tutorial-types';
import { SETTINGS_UNIT } from './tutorial-settings';
import { BOARDING_UNIT } from './tutorial-boarding';
import { NIGHT_REPORT_UNIT } from './tutorial-night-report';

export const TUTORIAL_UNITS: TutorialUnit[] = [BOARDING_UNIT, SETTINGS_UNIT, NIGHT_REPORT_UNIT].sort(
  (a, b) => a.navOrder - b.navOrder,
);

export function getUnit(unitId: string): TutorialUnit | null {
  return TUTORIAL_UNITS.find((u) => u.id === unitId) ?? null;
}

export function getUnitStep(unitId: string, index: number): TutorialStep | null {
  return getUnit(unitId)?.steps[index] ?? null;
}
