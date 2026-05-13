import { useDeviceStore } from '../store/device-store';
import { useUserStore } from '../store/user-store';
import { OnboardingScene } from '../scenes/Onboarding';
import { MainScene } from '../scenes/Main';
import { ShutdownScene } from '../scenes/Shutdown';

/**
 * Screen —— 800×480 屏幕路由器
 *
 * 根据顶层状态机当前 state 选择渲染哪个 scene。
 * M1 接入 XState 之前，先用简单条件路由占位。
 */
export function Screen() {
  const lidOpen = useDeviceStore((s) => s.lidOpen);
  const onboarded = useUserStore((s) => s.onboarded);

  if (!lidOpen) return <ShutdownScene />;
  if (!onboarded) return <OnboardingScene />;
  return <MainScene />;
}
