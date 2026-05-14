import { useMemo } from 'react';
import { useAppStore } from '../store/app-store';

/**
 * SetupGuide —— 配网引导（V0.6 占位）
 *
 * 川哥后续会发美术图，当前用 cqw/cqh（container query units）做响应式占位，
 * 确保在任何手机宽度下二维码都不溢出 800×480 画布。
 *
 * 布局策略：竖向 flex + gap，二维码用 min(38cqh, 32cqw) 限死短边，
 * 字号用 cqw 比例，整体占画布高度 < 80%。
 */
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
    <div
      className="absolute inset-0 z-layer-modal flex flex-col items-center justify-center gap-[2cqh] bg-black/90 px-[6cqw] py-[4cqh]"
      style={{ containerType: 'size' }}
    >
      <div
        className="rounded-md bg-white shadow-[0_0_18px_rgba(255,255,255,0.18)]"
        style={{
          padding: 'min(1.6cqh, 1.2cqw)',
          width: 'min(38cqh, 32cqw)',
          height: 'min(38cqh, 32cqw)',
        }}
      >
        <div className="grid h-full w-full grid-cols-8 gap-[1px] bg-white">
          {cells.map((filled, index) => (
            <div
              key={`setup-guide-cell-${index}`}
              className={filled ? 'bg-black' : 'bg-white'}
            />
          ))}
        </div>
      </div>

      <p
        className="font-medium text-white"
        style={{ fontSize: 'clamp(11px, 3.5cqw, 18px)' }}
      >
        使用 K1 App 扫码连接 WiFi
      </p>
      <p
        className="text-white/55"
        style={{ fontSize: 'clamp(9px, 2.6cqw, 12px)' }}
      >
        首次开机需要配网
      </p>

      <div
        className="absolute left-[3cqw] bottom-[3cqh] flex items-center gap-[1cqw] text-white/60"
        style={{ fontSize: 'clamp(8px, 2cqw, 10px)' }}
      >
        <div
          className="rounded-full bg-xiaoke-primary/70 animate-xiaoke-breathe"
          style={{
            width: 'clamp(8px, 2.4cqw, 14px)',
            height: 'clamp(8px, 2.4cqw, 14px)',
          }}
        />
        <span>小可待机中...</span>
      </div>
    </div>
  );
}
