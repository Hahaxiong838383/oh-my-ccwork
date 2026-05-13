import { getDict } from '../../config/loader';

/**
 * 离线收益（"夜航报告" 基础奖励部分，来自 1.2）
 *
 * - 累计离线小时数（向下取整） × RewardPerHour = 基础星尘
 * - 上限 MaxHours 小时
 * - 新手期 ×倍率（在 night-report 模块组合）
 * - 物资堆 3 级（Low/Middle/High）外观判定
 */

export type SuppliesLevel = 'none' | 'low' | 'middle' | 'high';

export interface OfflineRewardCalc {
  offlineHours: number;
  cappedHours: number;
  baseStardust: number;
  suppliesLevel: SuppliesLevel;
}

export function computeOfflineReward(
  lastOfflineStart: number,
  now: number = Date.now(),
): OfflineRewardCalc {
  if (!lastOfflineStart) {
    return { offlineHours: 0, cappedHours: 0, baseStardust: 0, suppliesLevel: 'none' };
  }
  // demo 节奏压缩：1 "h" = 30s（生产时换真小时）
  const HOUR_MS_DEMO = 30 * 1000;
  const elapsed = Math.max(0, now - lastOfflineStart);
  const offlineHours = Math.floor(elapsed / HOUR_MS_DEMO);
  const maxHours = getDict('MaxHours');
  const cappedHours = Math.min(maxHours, offlineHours);
  const baseStardust = cappedHours * getDict('RewardPerHour');

  // 物资堆等级 —— 阈值读字典（demo 用秒，生产用小时）
  const elapsedSec = elapsed / 1000;
  let suppliesLevel: SuppliesLevel = 'none';
  if (elapsedSec >= getDict('HighSupplies')) suppliesLevel = 'high';
  else if (elapsedSec >= getDict('MiddleSupplies')) suppliesLevel = 'middle';
  else if (elapsedSec >= getDict('LowSupplies')) suppliesLevel = 'low';

  return { offlineHours, cappedHours, baseStardust, suppliesLevel };
}
