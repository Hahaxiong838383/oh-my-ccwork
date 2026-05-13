import type { ReactNode } from 'react';
import { useUserStore } from '../store/user-store';

const PHASE_COLOR = {
  1: 'shadow-newbie-gold ring-newbie-gold/60',
  2: 'shadow-newbie-purple ring-newbie-purple/60',
  3: 'shadow-newbie-blue ring-newbie-blue/60',
} as const;

/**
 * 新手期光环包装
 * 配置驱动（M5 接 NewbiePhase.xlsx），demo 阶段写死 phase=1（金色）
 */
export function NewbieHalo({ children }: { children: ReactNode }) {
  const phase = useUserStore((s) => s.newbiePhase);
  if (!phase) return <>{children}</>;
  const halo = PHASE_COLOR[phase];
  return (
    <div className={`rounded-full p-1 ring-2 shadow-[0_0_24px] ${halo}`}>{children}</div>
  );
}
