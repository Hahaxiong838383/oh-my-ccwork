import { useAppStore } from '../store/app-store';

/**
 * 物理待机按键模拟（V0.6 草图风格：圆形大按钮 + K1 字标）
 * 单击：进入待机（关屏）/ 唤醒
 * 长按 2s：完全关机（demo 不做）
 */
export function PowerButton() {
  const lidOpen = useAppStore((s) => s.lidOpen);
  const toggleLid = useAppStore((s) => s.toggleLid);

  return (
    <button
      onClick={toggleLid}
      aria-label={lidOpen ? '关盖（待机）' : '开盖（唤醒）'}
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full text-[10px] font-bold tracking-wider transition-all ${
        lidOpen
          ? 'bg-shell-trim text-white/70 shadow-inner shadow-black/40 ring-1 ring-white/5 active:bg-shell-led-on/40'
          : 'bg-shell-led-on/80 text-shell-frame shadow-[0_0_12px_rgba(127,217,195,0.5)] ring-2 ring-shell-led-on/40'
      }`}
    >
      K1
    </button>
  );
}
