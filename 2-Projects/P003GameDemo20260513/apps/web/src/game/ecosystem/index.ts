import { Application, Graphics, Ticker } from 'pixi.js';
import { LayerManager, PIXI_LAYERS } from '../layer-manager';

let app: Application | null = null;
let layers: LayerManager | null = null;
let tickerFn: ((ticker: Ticker) => void) | null = null;

/**
 * 生态缸初始渲染
 *
 * V0.2 占位实现：在 0/30 层放光晕和粒子，证明 LayerManager 工作。
 * M2 改造：
 *   - 0 层加生态缸背景图（按性别+解锁状态）
 *   - 10 层加 5 个生态缸部件（按 Y 轴排序，部件按等级渲染）
 *   - 20 层接小可 AnimatedSprite
 *   - 30 层加部件粒子（光点、星尘）
 */
export async function mountEcosystem(host: HTMLElement) {
  app = new Application();
  await app.init({
    resizeTo: host,
    background: '#0a1929',
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  host.appendChild(app.canvas);

  layers = new LayerManager(app.stage);

  // BG: 中央光晕
  const glow = new Graphics().circle(0, 0, 200).fill({ color: 0x4fd1ff, alpha: 0.08 });
  glow.position.set(host.clientWidth / 2, host.clientHeight / 2);
  layers.add(glow, PIXI_LAYERS.BG);

  // FX_WEAK: 浮动粒子
  const particles = Array.from({ length: 12 }, () => {
    const g = new Graphics().circle(0, 0, 1.5).fill({ color: 0x7fd9c3, alpha: 0.6 });
    g.position.set(Math.random() * host.clientWidth, Math.random() * host.clientHeight);
    layers!.add(g, PIXI_LAYERS.FX_WEAK);
    return { node: g, vy: 0.15 + Math.random() * 0.3 };
  });

  tickerFn = () => {
    const h = host.clientHeight;
    for (const p of particles) {
      p.node.y -= p.vy;
      if (p.node.y < -10) p.node.y = h + 10;
    }
    glow.alpha = 0.08 + 0.02 * Math.sin(Date.now() / 1000);
  };
  Ticker.shared.add(tickerFn);
}

export function unmountEcosystem() {
  if (tickerFn) {
    Ticker.shared.remove(tickerFn);
    tickerFn = null;
  }
  layers?.destroy();
  layers = null;
  if (app) {
    app.destroy(true, { children: true });
    app = null;
  }
}
