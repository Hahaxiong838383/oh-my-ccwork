import { useAppStore } from '../store/app-store';
import { MainScreen } from '../components/MainScreen';
import { ShutdownScreen } from '../components/ShutdownScreen';

/**
 * Screen —— 800×480 屏幕路由器（V0.4 简化版）
 *
 * V0.4 砍掉 Onboarding（4 天范围太重），demo 默认直接进主界面。
 * 仅保留"开关盖"切换（lidOpen=false 时显示息屏）。
 */
export function Screen() {
  const lidOpen = useAppStore((s) => s.lidOpen);
  if (!lidOpen) return <ShutdownScreen />;
  return <MainScreen />;
}
