import type { CSSProperties } from 'react';

interface EcoBackgroundProps {}

interface GlowDot {
  left: string;
  top: string;
  size: number;
  duration: number;
  delay: number;
  drift: number;
}

const GLOW_DOTS: GlowDot[] = [
  { left: '8%', top: '90%', size: 6, duration: 8.2, delay: 0.2, drift: 4 },
  { left: '16%', top: '82%', size: 7, duration: 10.6, delay: 1.1, drift: -5 },
  { left: '24%', top: '94%', size: 5, duration: 9.4, delay: 2.4, drift: 6 },
  { left: '33%', top: '88%', size: 8, duration: 11.8, delay: 0.8, drift: -7 },
  { left: '42%', top: '91%', size: 5, duration: 7.8, delay: 2.1, drift: 5 },
  { left: '51%', top: '86%', size: 7, duration: 10.2, delay: 3.3, drift: -6 },
  { left: '62%', top: '92%', size: 6, duration: 8.7, delay: 1.6, drift: 3 },
  { left: '71%', top: '89%', size: 9, duration: 12.4, delay: 2.9, drift: -4 },
  { left: '79%', top: '93%', size: 6, duration: 9.8, delay: 0.5, drift: 5 },
  { left: '88%', top: '87%', size: 7, duration: 11.2, delay: 2.7, drift: -5 },
];

export function EcoBackground(_props: EcoBackgroundProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-layer-bg overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-screen-bg via-eco-deep to-eco-deep" />

      <div
        className="absolute inset-x-[-8%] top-[28%] h-[52%] rounded-[100%]"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(26,108,112,0.82) 0%, rgba(26,108,112,0.4) 48%, rgba(13,59,62,0) 78%)',
        }}
      />

      <div className="absolute left-1/2 top-[-14%] h-48 w-[125%] -translate-x-1/2 rounded-full bg-porthole-glow/15 blur-3xl" />

      {GLOW_DOTS.map((dot, index) => {
        const style: CSSProperties = {
          left: dot.left,
          top: dot.top,
          width: `${dot.size}px`,
          height: `${dot.size}px`,
          animation: `eco-float-up ${dot.duration}s linear ${dot.delay}s infinite`,
          ['--eco-drift' as string]: `${dot.drift}px`,
        };
        return <span key={`eco-dot-${index}`} className="absolute rounded-full bg-eco-light/70" style={style} />;
      })}

      <style>{`
        @keyframes eco-float-up {
          0% {
            transform: translate3d(0, 0, 0) scale(0.9);
            opacity: 0;
          }
          15% {
            opacity: 0.72;
          }
          70% {
            opacity: 0.5;
          }
          100% {
            transform: translate3d(var(--eco-drift, 0), -160px, 0) scale(1.2);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
}
