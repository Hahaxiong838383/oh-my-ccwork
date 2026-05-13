// 离线收益系统 —— M3 milestone 实现完整版
// 设计要点：
// - lastSeenAt 写 IndexedDB（Dexie）
// - 启动时读，diff 出离线时长
// - 每 1h(demo 30s) 累 1 份，上限 12h(demo 6min)
// - 一键领取：增加家族币，弹窗自动关闭

const HOUR_MS_DEMO = 30 * 1000; // demo: 30s = 1 "h"
const MAX_HOURS = 12;

export interface OfflineRewardCalc {
  units: number;
  cappedAt: number;
}

export function computeOfflineReward(lastSeenAt: number, now: number = Date.now()): OfflineRewardCalc {
  if (!lastSeenAt) return { units: 0, cappedAt: MAX_HOURS };
  const elapsed = Math.max(0, now - lastSeenAt);
  const units = Math.min(MAX_HOURS, Math.floor(elapsed / HOUR_MS_DEMO));
  return { units, cappedAt: MAX_HOURS };
}

// TODO M3: persistLastSeen / claimReward
