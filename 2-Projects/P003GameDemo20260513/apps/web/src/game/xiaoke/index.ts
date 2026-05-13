/**
 * 小可角色渲染（来自 1.8）
 *
 * V1.0 用 AnimatedSprite（帧动画），V1.5 切 Spine
 *
 * 待机动画规则（参考 1.6 §三）：
 * - 多个待机状态随机轮播
 * - 同一状态不连续重复 2 次
 * - 每个动画播完整 1 个循环再切换
 * - 唤醒/状态切换时打断 → 回来重新随机
 */

export type XiaokeAnim = 'idle_wave' | 'idle_spin' | 'idle_nod' | 'happy' | 'cheer' | 'read_book';

export interface XiaokeHandle {
  play(anim: XiaokeAnim): void;
  playIdleLoop(): void; // 随机轮播
  destroy(): void;
}

// TODO M2: mountXiaoke(container, layerManager) 实现 AnimatedSprite + 随机轮播状态机
