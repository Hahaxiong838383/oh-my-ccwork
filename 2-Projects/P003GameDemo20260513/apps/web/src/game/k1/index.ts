// K1 角色渲染占位
// M1 milestone 实现：AnimatedSprite + idle / 开心 / 鼓励 三套帧动画
// 帧资源先用 PNG 序列，未来换 Spine 时只换 mountK1 内部，对外接口不变

export interface K1Handle {
  playState: (name: 'idle' | 'happy' | 'cheer') => void;
  destroy: () => void;
}

export function mountK1(_container: unknown): K1Handle {
  return {
    playState: () => {
      /* TODO M1 */
    },
    destroy: () => {
      /* TODO M1 */
    },
  };
}
