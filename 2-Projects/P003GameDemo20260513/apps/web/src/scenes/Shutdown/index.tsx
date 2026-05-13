/**
 * 关机/待机界面 —— 屏幕黑屏 + 极简提示
 * 真硬件上对应霍尔开关关闭或实体按键待机
 */
export function Shutdown() {}
export function ShutdownScene() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-black text-white/30">
      <div className="text-xs tracking-[0.4em]">小可去夜航了</div>
      <div className="mt-2 text-[10px] tracking-widest text-white/15">按下电源键开启</div>
    </div>
  );
}
