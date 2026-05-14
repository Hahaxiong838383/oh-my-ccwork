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

/**
 * DeviceFrame —— 读写台设备外壳
 *
 * 800×480 横屏 5:3 画布只显示游戏主界面。
 * VoiceButton（按住说话）属于 demo 模拟工具，挂在外壳"下沿条"上，
 * 模拟真机的实体按键，不污染屏幕画面。真机里用户用"小可小可"唤醒。
 */
export function DeviceFrame({ children }: { children: ReactNode }) {
  const led = useAppStore((s) => s.led);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-shell-bg">
      <div
        className="relative flex flex-col gap-3 rounded-[24px] border border-shell-trim bg-shell-frame p-4 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        style={{ touchAction: 'none' }}
      >
        {/* 主行：屏幕 + 两侧外壳元素 */}
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-center gap-3 px-1">
            <LEDIndicator on={led.on} brightness={led.brightness} colorTemp={led.colorTemp} />
            <MicrophoneVent />
          </div>

          <div
            className="relative aspect-screen-canvas h-[min(78vh,calc(82vw*3/5))] w-auto overflow-hidden rounded-lg bg-screen-bg ring-1 ring-shell-trim"
            data-scope="screen-canvas"
          >
            {children}
            <WifiHud />
            <SettingsButton />
            <SetupGuide />
            <Tips />
          </div>

          <div className="flex flex-col items-center gap-3 px-1">
            <PowerButton />
            <div className="text-[8px] tracking-widest text-white/30">K1</div>
          </div>
        </div>

        {/* 下沿条：实体按键 + 品牌印 */}
        <div className="flex items-center justify-between px-2">
          <div className="text-[9px] tracking-[0.3em] text-white/25">FUTURUS · K1</div>
          <VoiceButton />
          <div className="text-[9px] tracking-[0.3em] text-white/25">DEMO V0.6</div>
        </div>

        <DebugBar />
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
