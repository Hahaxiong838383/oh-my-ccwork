import { useEffect, useState } from 'react';
import { useAppStore } from '../store/app-store';

interface NumberRollProps {
  value: number;
  durationMs: number;
}

function NumberRoll({ value, durationMs }: NumberRollProps) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    let rafId = 0;
    const startedAt = performance.now();

    const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
    const tick = (now: number) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / durationMs);
      setDisplay(Math.round(value * easeOut(progress)));
      if (progress < 1) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [durationMs, value]);

  return <span className="tabular-nums">{display}</span>;
}

function SupplyBlock({
  tone,
  left,
  top,
  size,
  round,
}: {
  tone: string;
  left: string;
  top: string;
  size: string;
  round: string;
}) {
  return (
    <svg
      className="absolute"
      style={{ left, top, width: size, height: size }}
      viewBox="0 0 100 100"
      aria-hidden
    >
      <rect x="8" y="8" width="84" height="84" rx={round} fill={tone} />
      <rect x="26" y="26" width="48" height="14" rx="7" fill="rgba(255,255,255,0.26)" />
      <circle cx="38" cy="63" r="7" fill="rgba(255,255,255,0.35)" />
      <circle cx="62" cy="63" r="7" fill="rgba(255,255,255,0.35)" />
    </svg>
  );
}

export function NightReport() {
  const bootState = useAppStore((s) => s.bootState);
  if (bootState !== 'nightReport') return null;

  return (
    <div
      className="absolute inset-0 z-layer-mask flex flex-col items-center justify-center bg-gradient-to-b from-screen-bg via-eco-deep to-eco-mid text-white"
      style={{ containerType: 'size', gap: 'clamp(1.4cqh, 2.1cqh, 3.1cqh)' }}
    >
      <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-newbie-blue/30 px-2 py-0.5 text-[9px] font-bold text-newbie-blue ring-1 ring-newbie-blue/50">
        NIGHT REPORT · 6s
      </div>
      <h2
        className="font-semibold tracking-[0.14em]"
        style={{
          fontSize: 'clamp(2.3cqh, 4.3cqw, 4.8cqh)',
          animation: 'night-report-fade 0.9s ease-out both',
        }}
      >
        夜航报告
      </h2>

      <p className="text-white/80" style={{ fontSize: 'clamp(1.7cqh, 2.8cqw, 3.2cqh)' }}>
        离线 6 小时
      </p>

      <div
        className="relative"
        style={{
          width: 'clamp(28cqh, 40cqw, 46cqh)',
          height: 'clamp(13cqh, 17cqw, 20cqh)',
        }}
      >
        <SupplyBlock
          tone="#3ca4b3"
          left="clamp(0.6cqh, 1.8cqw, 2.2cqh)"
          top="clamp(5.2cqh, 7.6cqw, 8.4cqh)"
          size="clamp(6.2cqh, 8.2cqw, 9.8cqh)"
          round="40"
        />
        <SupplyBlock
          tone="#6f6fd6"
          left="clamp(5.8cqh, 9.2cqw, 10.2cqh)"
          top="clamp(2.2cqh, 3.6cqw, 4.1cqh)"
          size="clamp(7.2cqh, 9.2cqw, 10.8cqh)"
          round="20"
        />
        <SupplyBlock
          tone="#f9be5f"
          left="clamp(11.6cqh, 16.2cqw, 17.4cqh)"
          top="clamp(5.6cqh, 7.8cqw, 8.8cqh)"
          size="clamp(6.8cqh, 8.8cqw, 10.4cqh)"
          round="28"
        />
        <SupplyBlock
          tone="#22b8cf"
          left="clamp(15.8cqh, 22.8cqw, 24.2cqh)"
          top="clamp(3.2cqh, 4.8cqw, 5.6cqh)"
          size="clamp(5.6cqh, 7.1cqw, 8.6cqh)"
          round="50"
        />
      </div>

      <div
        className="flex items-center justify-center gap-[clamp(1.2cqh,1.8cqw,2.2cqh)]"
        style={{ fontSize: 'clamp(1.9cqh, 3.1cqw, 3.5cqh)' }}
      >
        <span className="text-stardust">星尘奖励</span>
        <span className="font-bold text-stardust">
          +<NumberRoll value={120} durationMs={1500} />
        </span>
      </div>

      <p className="text-white/45" style={{ fontSize: 'clamp(1.5cqh, 2.3cqw, 2.6cqh)' }}>
        家族币 +0
      </p>

      <div
        className="flex items-center justify-center gap-[clamp(0.8cqh,1.2cqw,1.8cqh)] text-newbie-gold"
        style={{
          opacity: 0,
          animation: 'night-bonus-appear 1.2s ease-out 0.5s forwards',
          fontSize: 'clamp(1.5cqh, 2.4cqw, 2.8cqh)',
        }}
      >
        <svg
          viewBox="0 0 100 100"
          className="drop-shadow-[0_0_1.2cqh_rgba(255,215,0,0.55)]"
          style={{
            width: 'clamp(4.1cqh, 5.8cqw, 7.2cqh)',
            height: 'clamp(4.1cqh, 5.8cqw, 7.2cqh)',
            animation: 'night-bonus-bounce 1.2s ease-in-out infinite',
          }}
          aria-hidden
        >
          <rect x="12" y="36" width="76" height="44" rx="12" fill="#d3a53f" />
          <rect x="16" y="30" width="68" height="16" rx="8" fill="#f1cf6f" />
          <rect x="44" y="38" width="12" height="16" rx="6" fill="#8a6b22" />
        </svg>
        <span>额外宝箱已发现</span>
      </div>

      <style>{`
        @keyframes night-report-fade {
          from { opacity: 0; transform: translateY(clamp(1cqh, 1.4cqw, 2.1cqh)); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes night-bonus-appear {
          from { opacity: 0; transform: translateY(clamp(1cqh, 1.2cqw, 1.8cqh)); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes night-bonus-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(clamp(-0.8cqh, -1.2cqw, -1.7cqh)); }
        }
      `}</style>
    </div>
  );
}
