// 宝箱系统 —— M2 milestone 实现完整版
// 设计要点：
// - 每 N 秒（demo 15s 代替 15min）累积 1 个，上限 3
// - 连续专注时长越长，等级越高（1-3 级）
// - 开箱时机：退出专注 或 下次开盖
// - 奖励内容：生态缸物件 / 家族币 / 收藏品

export type TreasureLevel = 1 | 2 | 3;

export interface TreasureBox {
  id: string;
  level: TreasureLevel;
  createdAt: number;
}

export function levelFromContinuousMinutes(min: number): TreasureLevel {
  if (min >= 45) return 3;
  if (min >= 25) return 2;
  return 1;
}

// TODO M2: accumulate / openBox / rewardOf
