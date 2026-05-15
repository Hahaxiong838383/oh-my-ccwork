import { useAppStore } from '../store/app-store';
import { MainScreen } from '../components/MainScreen';
import { ShutdownScreen } from '../components/ShutdownScreen';
import { StatusBar } from '../components/StatusBar';
import { FocusRunning } from '../scenes/FocusRunning';
import { FocusCompanion } from '../scenes/FocusCompanion';
import { useFocusProgressTick } from '../hooks/useFocusProgressTick';
import { useFocusArtPreload } from '../hooks/useFocusArtPreload';

/**
 * Screen —— 800×480 屏幕路由器（V0.4 简化版）
 *
 * V0.4 砍掉 Onboarding（4 天范围太重），demo 默认直接进主界面。
 * 仅保留"开关盖"切换（lidOpen=false 时显示息屏）。
 */
export function Screen() {
  useFocusProgressTick();

  const lidOpen = useAppStore((s) => s.lidOpen);
  const focusMachine = useAppStore((s) => s.focusMachine);
  const focusMode = useAppStore((s) => s.focusMode);
  useFocusArtPreload(focusMode);

  if (!lidOpen) return <ShutdownScreen />;

  const scene =
    focusMachine !== 'idle' && focusMode === 'explore'
      ? <FocusRunning />
      : focusMachine !== 'idle' && focusMode === 'companion'
        ? <FocusCompanion />
        : <MainScreen />;

  return (
    <>
      {scene}
      <StatusBar />
    </>
  );
}
