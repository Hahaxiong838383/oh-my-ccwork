import { Container } from 'pixi.js';

/**
 * 9 层渲染规范（来自 1.12 美术元素层级规范）
 *
 * 0  背景层      生态缸主视图
 * 10 环境物件层  生态缸 5 部件
 * 20 角色层      小可 + 新手光环
 * 30 弱特效层    脚底光晕、环境粒子
 * 40 普通模式UI  ← React 层，不归 Pixi 管
 * 45 专注模式UI  ← React 层
 * 50 动态反馈层  ← React 层（按事件优先级队列）
 * 60 强特效层    开箱粒子、生态缸解锁特效
 * 70 遮罩层      ← React 层
 * 80 模态层      ← React 层
 *
 * Pixi 内只负责 0/10/20/30/60。React 负责 40/45/50/70/80。
 */
export const PIXI_LAYERS = {
  BG: 0,
  ENV: 10,
  CHAR: 20,
  FX_WEAK: 30,
  FX_STRONG: 60,
} as const;

export type PixiLayer = (typeof PIXI_LAYERS)[keyof typeof PIXI_LAYERS];

export class LayerManager {
  private root: Container;
  private layers = new Map<PixiLayer, Container>();

  constructor(root: Container) {
    this.root = root;
    for (const depth of Object.values(PIXI_LAYERS)) {
      const c = new Container();
      c.zIndex = depth;
      c.label = `layer_${depth}`;
      this.root.addChild(c);
      this.layers.set(depth, c);
    }
    this.root.sortableChildren = true;
  }

  add(node: Container, depth: PixiLayer): void {
    const layer = this.layers.get(depth);
    if (!layer) throw new Error(`unknown pixi layer: ${depth}`);
    layer.addChild(node);
  }

  remove(node: Container, depth: PixiLayer): void {
    const layer = this.layers.get(depth);
    layer?.removeChild(node);
  }

  clear(depth: PixiLayer): void {
    const layer = this.layers.get(depth);
    layer?.removeChildren();
  }

  destroy(): void {
    for (const layer of this.layers.values()) {
      layer.destroy({ children: true });
    }
    this.layers.clear();
  }
}
