import type { XiaokeAnim, XiaokeEmotion } from '../../systems/voice/response-schema';

/**
 * 小可角色渲染（来自 1.8）
 *
 * V1.0 用 AnimatedSprite（帧动画）
 * V1.5+ 切 Spine 骨骼 + 动画融合（来自 3.3 小可状态机升级）
 *
 * 接口稳定原则（对外永远是 playAnim / setEmotion）：
 *   内部从 AnimatedSprite 换到 Spine 时，调用方零改动。
 *
 * 待机动画规则（参考 1.6 §三）：
 * - 多个待机状态随机轮播
 * - 同一状态不连续重复 2 次
 * - 每个动画播完整 1 个循环再切换
 * - 唤醒/状态切换时打断 → 回来重新随机
 */

export type { XiaokeAnim, XiaokeEmotion };

export interface PlayAnimOptions {
  loop?: boolean;
  onComplete?: () => void;
}

export interface XiaokeHandle {
  /** 播放动作（来自 voice response 的 action 字段） */
  playAnim(anim: XiaokeAnim, options?: PlayAnimOptions): void;
  /** 设置情绪叠加（不打断动作，影响表情/光环色调） */
  setEmotion(emotion: XiaokeEmotion): void;
  /** 进入待机轮播状态机（不连续重复 2 次） */
  startIdleRotation(): void;
  /** 中断当前动画（语音唤醒/状态切换） */
  interrupt(): void;
  /** 销毁 */
  destroy(): void;
}

// TODO M2: mountXiaoke(container, layerManager) 实现 AnimatedSprite + 随机轮播状态机
// TODO V1.5: 用 Spine 重写内部实现，对外接口不变
