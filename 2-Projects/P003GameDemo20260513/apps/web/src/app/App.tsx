import { useEffect } from 'react';
import { DeviceFrame } from '../device/DeviceFrame';
import { Screen } from '../screen/Screen';
import { prewarmVoiceClient } from '../machines';
import { CameraStatusDot } from '../components/CameraStatusDot';
import { HiddenCameraVideo } from '../components/HiddenCameraVideo';
import { disposeCamera, snapIfStale } from '../services/expression-snapshot';

export function App() {
  // D5 P7：mount 时 prewarm voice WebSocket，避免首次"按住说话"卡顿
  useEffect(() => {
    prewarmVoiceClient();

    const timer = window.setInterval(() => {
      void snapIfStale();
    }, 5_000);
    return () => {
      window.clearInterval(timer);
      disposeCamera();
    };
  }, []);

  return (
    <DeviceFrame>
      <Screen />
      <HiddenCameraVideo />
      <CameraStatusDot />
    </DeviceFrame>
  );
}
