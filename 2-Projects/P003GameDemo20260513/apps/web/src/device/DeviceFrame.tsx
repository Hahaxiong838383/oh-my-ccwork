import type { ReactNode } from 'react';
import { LEDIndicator } from './LEDIndicator';
import { PowerButton } from './PowerButton';
import { useAppStore } from '../store/app-store';
import { Tips } from '../components/Tips';
import { VoiceButton } from '../components/VoiceButton';
import { DebugBar } from './DebugBar';
import { WifiHud } from '../components/WifiHud';
import { SettingsButton } from '../components/SettingsButton';
import { SetupGuide } from '../scenes/SetupGuide';
import { Welcome } from '../scenes/Welcome';
import { NightReport } from '../scenes/NightReport';
import { AskMode } from '../scenes/AskMode';

/**
 * DeviceFrame —— 读写台 demo 模拟器外壳（V0.6 竖屏布局）
 *
 * 按川哥草图：手机竖屏整体布局，分 4 段堆叠：
 *   1. 顶部标题：FUTURUS + DEMO
 *   2. 屏幕区：LED + 麦克风 在 800×480 画布左侧
 *   3. 操作按钮区：talk + K1 开关 居中
 *   4. 底部调试区：配网 / WiFi / 跳关
 *
 * 800×480 游戏画布**像素锁定**（aspect 5:3 + max-width 撑满），
 * 内部坐标系永远是 800×480，外层 CSS 按比例缩放。
 *
 * 画内/画外铁律：data-scope="screen-canvas" 标记的 div 子树只放游戏 UI，
 * 模拟器/调试控件（VoiceButton/PowerButton/DebugBar/LED）严禁进入。
 */
export function DeviceFrame({ children }: { children: ReactNode }) {
  const led = useAppStore((s) => s.led);

  return (
    <div className="flex min-h-full w-full flex-col items-stretch bg-shell-bg px-3 py-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-4 rounded-2xl border border-shell-trim bg-shell-frame p-3 shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
        {/* 1. 顶部标题 */}
        <div className="flex items-center justify-between px-1 text-[10px] tracking-[0.35em] text-white/40">
          <span>FUTURUS · K1</span>
          <span>DEMO V0.6</span>
        </div>

        {/* 2. 屏幕区：LED + 麦克风 + 800×480 画布 */}
        <div className="flex items-stretch gap-2">
          <div className="flex flex-col items-center justify-center gap-3 px-1 py-1">
            <LEDIndicator on={led.on} brightness={led.brightness} colorTemp={led.colorTemp} />
            <MicrophoneVent />
          </div>

          <div
            className="relative aspect-screen-canvas flex-1 overflow-hidden rounded-lg bg-screen-bg ring-1 ring-shell-trim"
            data-scope="screen-canvas"
          >
            {children}
            <WifiHud />
            <SettingsButton />
            <SetupGuide />
            <Welcome />
            <NightReport />
            <AskMode />
            <Tips />
          </div>
        </div>

        {/* 3. 操作按钮区：talk + K1 开关 */}
        <div className="flex items-center justify-center gap-10 px-2">
          <VoiceButton />
          <div className="flex flex-col items-center gap-1">
            <PowerButton />
            <span className="text-[9px] tracking-[0.25em] text-white/35">K1 开关</span>
          </div>
        </div>

        {/* 4. 底部调试区 */}
        <DebugBar />
      </div>
    </div>
  );
}

function MicrophoneVent() {
  return (
    <div className="flex flex-col gap-[3px]" aria-label="麦克风孔">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-[3px] w-3 rounded-full bg-shell-trim" />
      ))}
    </div>
  );
}
