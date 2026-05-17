import { useEffect } from 'react';
import { DeviceFrame } from '../device/DeviceFrame';
import { Screen } from '../screen/Screen';
import { prewarmVoiceClient } from '../machines';

export function App() {
  // D5 P7：mount 时 prewarm voice WebSocket，避免首次"按住说话"卡顿
  useEffect(() => {
    prewarmVoiceClient();
  }, []);

  return (
    <DeviceFrame>
      <Screen />
    </DeviceFrame>
  );
}
