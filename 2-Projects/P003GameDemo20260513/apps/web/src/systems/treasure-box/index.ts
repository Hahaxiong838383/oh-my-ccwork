import { getDropTableEntry } from '../../config/loader';

/**
 * 宝箱生成（来自 1.3 §三）
 *
 * - 4 级宝箱：普通/精品/史诗/传说（数值 1-4）
 * - 男女差异化：每等级 2 套外观
 * - 生成规则：读 DropTable，按"使用天数 + 宝箱次序"查询
 * - 累计无上限：但生成受每日专注时长限制（最后一个 box 用极大 focus_seconds 兜底）
 * - 跨北京 0 点：当次会话视为同日
 * - 新手暴击：每日首箱按权重升级（在 newbie-buff 模块处理）
 */

export type BoxLevel = 1 | 2 | 3 | 4;

export interface GeneratedBox {
  boxId: string;
  level: BoxLevel;
  rewardId: number;
  createdAt: number;
}

/**
 * 检查当前专注时长是否应该生成下一个宝箱
 * 返回应生成的宝箱（null = 还没到下一个的时长）
 */
export function checkBoxToGenerate(
  useDay: number,
  focusedSeconds: number,
  alreadyGenerated: number,
): GeneratedBox | null {
  const nextIndex = alreadyGenerated + 1;
  const entry = getDropTableEntry(useDay, nextIndex);
  if (!entry) return null;
  if (focusedSeconds < entry.focus_seconds) return null;
  return {
    boxId: `${Date.now()}_${nextIndex}`,
    level: entry.box_level,
    rewardId: entry.reward_id,
    createdAt: Date.now(),
  };
}

// TODO M3: 接 mock server，开箱时调 /api/treasure/open 拿真奖励
