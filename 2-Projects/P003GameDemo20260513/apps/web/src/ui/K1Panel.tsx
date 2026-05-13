export function K1Panel() {
  return (
    <div className="mx-auto mb-4 flex w-fit items-center gap-3 rounded-2xl bg-white/5 px-4 py-3 backdrop-blur-md">
      <div className="h-12 w-12 animate-k1-breathe rounded-full bg-gradient-to-br from-k1-primary to-k1-accent shadow-[0_0_24px_rgba(255,138,101,0.4)]" />
      <div>
        <div className="text-sm font-medium">K1</div>
        <div className="text-xs text-white/50">在和你一起观测</div>
      </div>
    </div>
  );
}
