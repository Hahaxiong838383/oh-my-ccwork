import type { BoxLevel } from '../store/app-store';

export interface BoxConfig {
  level: BoxLevel;
  name: string;
  weight: number;
  rewards: { stardust: number; familyCoin: number };
  xiaokeLine: string;
  color: string;
  ringColor: string;
  particleCount: number;
  shakeMs: number;
  shakePx: number;
  shouldShake: boolean;
  shouldFireworks: boolean;
}

export const BOX_LEVELS: Record<BoxLevel, BoxConfig> = {
  common: {
    level: 'common',
    name: '普通宝箱',
    weight: 50,
    rewards: { stardust: 20, familyCoin: 1 },
    xiaokeLine: '嗯，常规收获，加油哦指挥官～',
    color: '#9CA3AF',
    ringColor: 'rgba(156,163,175,0.6)',
    particleCount: 5,
    shakeMs: 2_000,
    shakePx: 5,
    shouldShake: false,
    shouldFireworks: false,
  },
  rare: {
    level: 'rare',
    name: '精品宝箱',
    weight: 30,
    rewards: { stardust: 50, familyCoin: 3 },
    xiaokeLine: '哦！精品宝箱！今天表现不错呢！',
    color: '#3B82F6',
    ringColor: 'rgba(59,130,246,0.7)',
    particleCount: 15,
    shakeMs: 2_500,
    shakePx: 10,
    shouldShake: false,
    shouldFireworks: false,
  },
  epic: {
    level: 'epic',
    name: '史诗宝箱',
    weight: 15,
    rewards: { stardust: 150, familyCoin: 8 },
    xiaokeLine: '哇！是史诗级！让我好好瞧瞧！',
    color: '#A855F7',
    ringColor: 'rgba(168,85,247,0.8)',
    particleCount: 32,
    shakeMs: 3_000,
    shakePx: 15,
    shouldShake: true,
    shouldFireworks: false,
  },
  legendary: {
    level: 'legendary',
    name: '传说宝箱',
    weight: 5,
    rewards: { stardust: 500, familyCoin: 20 },
    xiaokeLine: '！！传说宝箱！！指挥官今天运气爆棚啊！！',
    color: '#F59E0B',
    ringColor: 'rgba(245,158,11,0.9)',
    // codex 评审建议从 80 降到 32，并加 reduced-motion 降级
    particleCount: 32,
    shakeMs: 4_000,
    shakePx: 20,
    shouldShake: true,
    shouldFireworks: true,
  },
};

export const ALL_BOX_LEVELS: BoxLevel[] = ['common', 'rare', 'epic', 'legendary'];

/**
 * pickNextBoxLevel —— 保证队列 + 加权随机
 *
 * 首次保证 4 级都演到（codex 评审建议替代 Set 方案）：
 *   - openedSoFar 队列里还没出现的等级，优先抽（保证队列）
 *   - 4 级都演过后，按 weight 加权随机
 *
 * 跳关精准触发不应走这个函数（不计入保证队列）。
 */
export function pickNextBoxLevel(openedSoFar: readonly BoxLevel[]): BoxLevel {
  const unopened = ALL_BOX_LEVELS.filter((l) => !openedSoFar.includes(l));
  if (unopened.length > 0) {
    return unopened[Math.floor(Math.random() * unopened.length)];
  }
  return weightedRandom();
}

function weightedRandom(): BoxLevel {
  const total = ALL_BOX_LEVELS.reduce((sum, l) => sum + BOX_LEVELS[l].weight, 0);
  let r = Math.random() * total;
  for (const level of ALL_BOX_LEVELS) {
    r -= BOX_LEVELS[level].weight;
    if (r <= 0) return level;
  }
  return 'common';
}
