import type { ReactNode } from 'react';

/**
 * 新手期光环包装（V0.4 简化版：写死金色光环）
 * V1.0+ 接 NewbiePhase 配置驱动 + 阶段切换
 */
export function NewbieHalo({ children, on = true }: { children: ReactNode; on?: boolean }) {
  if (!on) return <>{children}</>;
  return (
    <div className="rounded-full p-1 ring-2 ring-newbie-gold/60 shadow-[0_0_24px_rgba(255,215,0,0.4)]">
      {children}
    </div>
  );
}
