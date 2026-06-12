/**
 * 新手引导单元注册表 —— 引擎按数据驱动，加单元只加数据文件 + 这里注册一行。
 * 左栏入口按 navOrder 排（固定链：登舰→专注→夜航；生态缸/设置为独立触发单元）。
 */
import type { TutorialStep, TutorialUnit } from './tutorial-types';
import { SETTINGS_UNIT } from './tutorial-settings';
import { BOARDING_UNIT } from './tutorial-boarding';
import { NIGHT_REPORT_UNIT } from './tutorial-night-report';
import { FOCUS_UNIT } from './tutorial-focus';
import { ECO_POND_UNIT } from './tutorial-eco-pond';

/** 2026-06-12 配表定稿：固定链 登舰(10) → 专注(20) → 夜航(30)；
 *  生态缸(40) 首次进入升级时独立触发；设置(50) 按需独立单元、不在固定链。 */
export const TUTORIAL_UNITS: TutorialUnit[] = [
  BOARDING_UNIT,
  FOCUS_UNIT,
  NIGHT_REPORT_UNIT,
  ECO_POND_UNIT,
  SETTINGS_UNIT,
].sort((a, b) => a.navOrder - b.navOrder);

export function getUnit(unitId: string): TutorialUnit | null {
  return TUTORIAL_UNITS.find((u) => u.id === unitId) ?? null;
}

export function getUnitStep(unitId: string, index: number): TutorialStep | null {
  return getUnit(unitId)?.steps[index] ?? null;
}
