import { CoinHud } from './CoinHud';
import { EcoBackground } from './EcoBackground';
import { FocusToggle } from './FocusToggle';
import { NewbieHalo } from './NewbieHalo';
import { StatusBar } from './StatusBar';
import { VoiceButton } from './VoiceButton';
import { WizardOfOz } from './WizardOfOz';
import { Xiaoke } from './Xiaoke';

interface MainScreenProps {
  showHalo?: boolean;
}

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

      <div className="absolute bottom-3 right-4 z-layer-ui-normal">
        <VoiceButton />
      </div>

      <WizardOfOz />
    </div>
  );
}
