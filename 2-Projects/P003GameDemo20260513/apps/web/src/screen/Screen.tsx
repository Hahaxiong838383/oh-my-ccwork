import { useAppStore } from '../store/app-store';
import { ShutdownScreen } from '../components/ShutdownScreen';
import { StatusBar } from '../components/StatusBar';
import { SceneNumberBadge } from '../components/SceneNumberBadge';
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

  // D5 P20：删 MainScreen 兜底（川哥要求去掉）；focus 模式时显示出航/静思 scene
  // 其它状态由 DeviceFrame 渲染的 Welcome/AskMode/NightReport/OpenBox/EcoUnlock/Farewell 接管
  const scene =
    focusMachine !== 'idle' && focusMode === 'explore'
      ? <FocusRunning />
      : focusMachine !== 'idle' && focusMode === 'companion'
        ? <FocusCompanion />
        : null;

  return (
    <>
      {scene}
      <StatusBar />
      <SceneNumberBadge />
    </>
  );
}
