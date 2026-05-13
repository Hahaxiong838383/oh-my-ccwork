import { useAppStore } from '../store/app-store';

export function TopBar() {
  const coin = useAppStore((s) => s.familyCoin);
  const boxes = useAppStore((s) => s.treasureBoxCount);

  return (
    <div className="flex items-center justify-between px-5 py-3 backdrop-blur-md">
      <div className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1">
        <span className="text-k1-primary">●</span>
        <span className="text-sm font-medium">{coin}</span>
        <span className="text-xs text-white/40">家族币</span>
      </div>
      <div className="flex items-center gap-1 rounded-full bg-white/5 px-3 py-1">
        <span className="text-xs text-white/40">宝箱</span>
        <span className="text-sm font-medium">{boxes}/3</span>
      </div>
    </div>
  );
}
