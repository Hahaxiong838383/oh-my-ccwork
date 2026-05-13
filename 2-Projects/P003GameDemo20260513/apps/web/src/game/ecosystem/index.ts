import { Application, Graphics, Ticker } from 'pixi.js';

let app: Application | null = null;

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

  // 占位：渐变光晕 + 几个浮动粒子，证明 Pixi 跑起来了
  const glow = new Graphics().circle(0, 0, 240).fill({ color: 0x4fd1ff, alpha: 0.08 });
  glow.position.set(host.clientWidth / 2, host.clientHeight / 2);
  app.stage.addChild(glow);

  const particles = Array.from({ length: 12 }, () => {
    const g = new Graphics().circle(0, 0, 2).fill({ color: 0x7fd9c3, alpha: 0.6 });
    g.position.set(Math.random() * host.clientWidth, Math.random() * host.clientHeight);
    app!.stage.addChild(g);
    return { node: g, vy: 0.2 + Math.random() * 0.4 };
  });

  Ticker.shared.add(() => {
    for (const p of particles) {
      p.node.y -= p.vy;
      if (p.node.y < -10) p.node.y = host.clientHeight + 10;
    }
    glow.alpha = 0.08 + 0.02 * Math.sin(Date.now() / 1000);
  });
}

export function unmountEcosystem() {
  if (app) {
    app.destroy(true, { children: true });
    app = null;
  }
}
