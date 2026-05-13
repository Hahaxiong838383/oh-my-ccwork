import { formatNumber } from '../systems/number-format';
import { useAppStore } from '../store/app-store';

interface CoinHudProps {}

export function CoinHud(_props: CoinHudProps) {
  const stardust = useAppStore((s) => s.stardust);
  const familyCoin = useAppStore((s) => s.familyCoin);

  return (
    <div className="absolute left-3 right-3 top-3 z-layer-ui-normal flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-xs text-white ring-1 ring-white/10 backdrop-blur-sm">
          <span className="h-2.5 w-2.5 rounded-full bg-stardust shadow-[0_0_10px_rgba(197,179,255,0.85)]" />
          <span className="font-semibold">{formatNumber(stardust)}</span>
        </div>

        <div className="flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-xs text-white ring-1 ring-white/10 backdrop-blur-sm">
          <span className="h-2.5 w-2.5 rounded-full bg-family-coin shadow-[0_0_10px_rgba(255,217,102,0.85)]" />
          <span className="font-semibold">{formatNumber(familyCoin)}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-full bg-black/45 px-2.5 py-1 ring-1 ring-white/10 backdrop-blur-sm">
        <span className="inline-flex h-5 w-5 items-center justify-center text-white/90" aria-hidden>
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="2" strokeLinecap="round">
            <path d="M2 8c6-6 14-6 20 0" />
            <path d="M5 11c4-4 10-4 14 0" />
            <path d="M8 14c2-2 6-2 8 0" />
            <circle cx="12" cy="18" r="1.5" fill="currentColor" stroke="none" />
          </svg>
        </span>

        <button
          type="button"
          onClick={() => console.log('[CoinHud] settings click')}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-white/90 transition hover:bg-white/20 active:scale-95"
          aria-label="设置"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="2" strokeLinecap="round">
            <path d="M12 3v3" />
            <path d="M12 18v3" />
            <path d="M3 12h3" />
            <path d="M18 12h3" />
            <path d="m5.7 5.7 2.1 2.1" />
            <path d="m16.2 16.2 2.1 2.1" />
            <path d="m5.7 18.3 2.1-2.1" />
            <path d="m16.2 7.8 2.1-2.1" />
            <circle cx="12" cy="12" r="3.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
