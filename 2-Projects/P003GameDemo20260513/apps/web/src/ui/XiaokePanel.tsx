/**
 * 小可面板（DOM 占位，M2 切到 Pixi AnimatedSprite）
 * 设计意图：让 V0.2 demo 跑起来就能看到角色形象，等接 PixiJS 帧动画再替换
 */
export function XiaokePanel() {
  return (
    <div className="pointer-events-auto flex flex-col items-center gap-1">
      <div className="h-14 w-14 animate-xiaoke-breathe rounded-full bg-gradient-to-br from-xiaoke-primary to-xiaoke-accent shadow-[0_0_30px_rgba(255,138,101,0.5)]" />
      <div className="text-[10px] font-medium tracking-widest text-white/70">小可</div>
    </div>
  );
}
