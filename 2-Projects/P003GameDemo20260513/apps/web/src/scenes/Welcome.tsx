import { useAppStore } from '../store/app-store';

export function Welcome() {
  const bootState = useAppStore((s) => s.bootState);
  if (bootState !== 'welcome') return null;

  return (
    <div
      className="absolute inset-0 z-layer-mask flex flex-col items-center justify-center bg-gradient-to-b from-screen-bg to-eco-deep"
      style={{ containerType: 'size', gap: 'clamp(1.8cqh, 2.8cqh, 3.8cqh)' }}
    >
      <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-newbie-gold/30 px-2 py-0.5 text-[9px] font-bold text-newbie-gold ring-1 ring-newbie-gold/50">
        WELCOME · 4s
      </div>
      <div
        className="relative flex items-center justify-center"
        style={{
          width: 'clamp(22cqh, 26cqw, 30cqh)',
          height: 'clamp(22cqh, 26cqw, 30cqh)',
          animation: 'welcome-wave 1.2s ease-in-out infinite',
          transformOrigin: '60% 70%',
        }}
      >
        <div
          className="rounded-full bg-gradient-to-br from-xiaoke-primary via-newbie-gold to-xiaoke-accent shadow-[0_0_3.2cqh_rgba(255,217,102,0.5)]"
          style={{
            width: '100%',
            height: '100%',
            border: 'clamp(0.45cqh, 0.7cqw, 0.85cqh) solid rgba(255,255,255,0.48)',
          }}
        />

        <div
          className="absolute rounded-full bg-xiaoke-accent/85"
          style={{
            width: 'clamp(2.4cqh, 3.6cqw, 4.2cqh)',
            height: 'clamp(5.2cqh, 7.2cqw, 8.4cqh)',
            right: 'clamp(0.2cqh, 0.8cqw, 1.2cqh)',
            top: 'clamp(7.4cqh, 8.8cqw, 9.8cqh)',
            transform: 'rotate(24deg)',
          }}
          aria-hidden
        />
      </div>

      <p
        className="font-semibold tracking-[0.08em] text-white/95"
        style={{
          fontSize: 'clamp(2.1cqh, 3.7cqw, 4.2cqh)',
          animation: 'welcome-caption-fade 1.1s ease-out both',
        }}
      >
        你好，指挥官！欢迎回到方舟
      </p>

      <style>{`
        @keyframes welcome-wave {
          0%, 100% { transform: rotate(-15deg); }
          50% { transform: rotate(15deg); }
        }
        @keyframes welcome-caption-fade {
          from { opacity: 0; transform: translateY(clamp(1.2cqh, 1.8cqw, 2.4cqh)); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
