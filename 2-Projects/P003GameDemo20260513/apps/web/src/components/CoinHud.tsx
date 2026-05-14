import { formatNumber } from '../systems/number-format';
import { useAppStore } from '../store/app-store';

export function CoinHud() {
  const stardust = useAppStore((s) => s.stardust);
  const familyCoin = useAppStore((s) => s.familyCoin);

  return (
    <div className="absolute left-3 top-3 z-layer-ui-normal flex items-center gap-2">
      <div className="flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-xs text-white ring-1 ring-white/10 backdrop-blur-sm">
        <span className="font-bold text-family-coin" aria-hidden>
          $
        </span>
        <span className="font-semibold">{formatNumber(familyCoin)}</span>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-xs text-white ring-1 ring-white/10 backdrop-blur-sm">
          <span className="font-bold text-stardust" aria-hidden>
            ☆
          </span>
          <span className="font-semibold">{formatNumber(stardust)}</span>
        </div>
      </div>
    </div>
  );
}
