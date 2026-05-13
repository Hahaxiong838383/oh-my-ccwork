import type { ReactNode } from 'react';
import { LEDIndicator } from './LEDIndicator';
import { PowerButton } from './PowerButton';
import { useSettingsStore } from '../store/settings-store';

/**
 * DeviceFrame —— 读写台设备外壳
 *
 * 设计目标：让用户在手机/电脑浏览器里看到"真实读写台"的形态。
 * 内部嵌一个 800×480 横屏 5:3 画布，按视口可用空间自适应缩放。
 *
 * 排版：横屏时画布最大化；竖屏时旋转 90° 提示横置。
 */
export function DeviceFrame({ children }: { children: ReactNode }) {
  const led = useSettingsStore((s) => s.led);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-shell-bg">
      <div
        className="relative flex items-center gap-4 rounded-[24px] border border-shell-trim bg-shell-frame p-4 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        style={{ touchAction: 'none' }}
      >
        {/* 左侧物理装饰 —— 麦克风孔 + LED */}
        <div className="flex flex-col items-center gap-3 px-1">
          <LEDIndicator on={led.on} brightness={led.brightness} colorTemp={led.colorTemp} />
          <MicrophoneVent />
        </div>

        {/* 中央屏幕区域：固定 5:3 比例，CSS 容器查询自适应 */}
        <div className="relative aspect-screen-canvas h-[min(80vh,calc(85vw*3/5))] w-auto overflow-hidden rounded-lg bg-screen-bg ring-1 ring-shell-trim">
          {children}
        </div>

        {/* 右侧物理按键 */}
        <div className="flex flex-col items-center gap-3 px-1">
          <PowerButton />
          <div className="text-[8px] tracking-widest text-white/30">K1</div>
        </div>
      </div>

      {/* 设备底部小印 */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] tracking-[0.3em] text-white/20">
        FUTURUS · K1 · DEMO V0.2
      </div>
    </div>
  );
}

function MicrophoneVent() {
  return (
    <div className="flex flex-col gap-[3px]">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-[3px] w-3 rounded-full bg-shell-trim" />
      ))}
    </div>
  );
}
