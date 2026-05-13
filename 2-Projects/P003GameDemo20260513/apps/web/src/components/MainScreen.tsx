import { CoinHud } from './CoinHud';
import { EcoBackground } from './EcoBackground';
import { FocusToggle } from './FocusToggle';
import { NewbieHalo } from './NewbieHalo';
import { StatusBar } from './StatusBar';
import { WizardOfOz } from './WizardOfOz';
import { Xiaoke } from './Xiaoke';

interface MainScreenProps {
  showHalo?: boolean;
}

/**
 * 800×480 屏幕内的游戏主界面
 *
 * 注意：VoiceButton（按住说话）不在这里 —— 它是 demo 模拟工具，挂在 DeviceFrame
 * 设备外壳上（像真机的实体按键），不污染游戏画面。真机里用户用"小可小可"语音唤醒。
 */
export function MainScreen({ showHalo = true }: MainScreenProps) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-screen-bg">
      <EcoBackground />
      <CoinHud />

      <div className="absolute left-1/2 top-[57%] z-layer-char -translate-x-1/2 -translate-y-1/2">
        <NewbieHalo on={showHalo}>
          <Xiaoke />
        </NewbieHalo>
      </div>

      <StatusBar />

      <div className="absolute bottom-3 left-4 z-layer-ui-normal">
        <FocusToggle />
      </div>

      <WizardOfOz />
    </div>
  );
}
