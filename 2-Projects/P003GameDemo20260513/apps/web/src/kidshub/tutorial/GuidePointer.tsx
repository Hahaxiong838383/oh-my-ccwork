/**
 * GuidePointer — 设置引导指引（真实 PNG 素材，川哥 2026-06-14 提供）
 *   hand.png 3D 小手 / arrow.png 下箭头 / ring.png 光圈
 * 替换原自绘 SVG FingerPointer（设置引导专用；登舰等其它引导仍可用旧的）。
 *
 * gemini 逻辑序列建议：光圈先闪吸引 → 小手指方向 → 手指碰到即消失。
 * - tap: 小手指向控件，轻浮动循环
 * - swipe-down / swipe-up: 箭头滑动（open-panel 下滑 / close-panel 上滑手势）
 * GuideRing: 光圈套在目标控件中央，呼吸闪烁吸引注意。
 */
const BASE = '/kidshub/settings-guide';

export function GuidePointer({ variant }: { variant: 'tap' | 'swipe-down' | 'swipe-up' }): JSX.Element {
  if (variant === 'tap') {
    return (
      <>
        <img
          src={`${BASE}/hand.png`}
          alt=""
          draggable={false}
          className="pointer-events-none select-none drop-shadow-[0_3px_6px_rgba(0,0,0,0.35)]"
          style={{ width: '11cqw', animation: 'guideTap 1100ms infinite ease-in-out' }}
        />
        <style>{`@keyframes guideTap{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.4cqh)}}`}</style>
      </>
    );
  }
  const up = variant === 'swipe-up';
  return (
    <>
      <img
        src={`${BASE}/arrow.png`}
        alt=""
        draggable={false}
        className="pointer-events-none select-none opacity-85 drop-shadow-[0_2px_5px_rgba(0,0,0,0.3)]"
        style={{
          height: '12cqh',
          transform: up ? 'rotate(180deg)' : undefined,
          animation: `guideSwipe${up ? 'Up' : 'Down'} 1350ms infinite ease-in-out`,
        }}
      />
      <style>{`
        @keyframes guideSwipeDown{0%{transform:translateY(-1.8cqh);opacity:.75}50%{transform:translateY(1.4cqh);opacity:1}100%{transform:translateY(-1.8cqh);opacity:.75}}
        @keyframes guideSwipeUp{0%{transform:translateY(1.8cqh) rotate(180deg);opacity:.75}50%{transform:translateY(-1.4cqh) rotate(180deg);opacity:1}100%{transform:translateY(1.8cqh) rotate(180deg);opacity:.75}}
      `}</style>
    </>
  );
}

/** 光圈高亮：绝对定位套在目标控件中央，呼吸闪烁（吸引注意，不挡操作 pointer-events-none） */
export function GuideRing(): JSX.Element {
  return (
    <>
      <img
        src={`${BASE}/ring.png`}
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-1/2 top-1/2 z-[5] -translate-x-1/2 -translate-y-1/2 select-none mix-blend-screen"
        style={{ width: '58%', animation: 'guideRing 1300ms infinite ease-in-out' }}
      />
      <style>{`@keyframes guideRing{0%,100%{opacity:.4;transform:translate(-50%,-50%) scale(.9)}50%{opacity:.8;transform:translate(-50%,-50%) scale(1.05)}}`}</style>
    </>
  );
}
