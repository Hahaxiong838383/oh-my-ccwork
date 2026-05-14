import { useMemo } from 'react';
import { useAppStore } from '../store/app-store';

export function SetupGuide() {
  const bootState = useAppStore((s) => s.bootState);
  const cells = useMemo(
    () =>
      Array.from({ length: 64 }, (_, index) => {
        const row = Math.floor(index / 8);
        const col = index % 8;
        const isFinder =
          (row <= 1 && col <= 1) ||
          (row <= 1 && col >= 6) ||
          (row >= 6 && col <= 1);
        if (isFinder) return true;
        return ((row + 1) * (col + 3) + row + col) % 2 === 0;
      }),
    [],
  );

  if (bootState !== 'unconfigured') return null;

  return (
    <div className="absolute inset-0 z-layer-modal bg-black/85">
      <div className="relative flex h-full w-full flex-col items-center justify-center">
        <div className="rounded-xl bg-white p-2 shadow-[0_0_30px_rgba(0,0,0,0.45)]">
          <div className="grid h-32 w-32 grid-cols-8 gap-0.5 bg-white">
            {cells.map((filled, index) => (
              <div key={`setup-guide-cell-${index}`} className={filled ? 'bg-black' : 'bg-white'} />
            ))}
          </div>
        </div>

        <p className="mt-5 text-lg text-white">使用 K1 App 扫码连接 WiFi</p>
        <p className="mt-1 text-xs text-white/60">首次开机需要配网</p>

        <div className="absolute bottom-4 left-4 flex items-center gap-2 text-white/70">
          <div className="h-6 w-6 rounded-full bg-xiaoke-primary/70 animate-xiaoke-breathe" />
          <span className="text-[10px]">小可待机中...</span>
        </div>
      </div>
    </div>
  );
}
