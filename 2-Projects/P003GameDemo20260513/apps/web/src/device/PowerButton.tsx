import { useDeviceStore } from '../store/device-store';

/**
 * 物理待机按键模拟
 * 单击：进入待机（关屏）/ 唤醒
 * 长按 2s：完全关机（demo 不做）
 */
export function PowerButton() {
  const lidOpen = useDeviceStore((s) => s.lidOpen);
  const toggleLid = useDeviceStore((s) => s.toggleLid);

  return (
    <button
      onClick={toggleLid}
      className="h-7 w-3 rounded-sm bg-shell-trim shadow-inner shadow-black/40 transition-colors active:bg-shell-led-on/40"
      aria-label={lidOpen ? '关盖' : '开盖'}
    />
  );
}
