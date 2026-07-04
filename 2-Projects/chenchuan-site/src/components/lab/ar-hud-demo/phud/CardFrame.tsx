import type { ReactNode } from 'react'

interface CardFrameProps {
  children: ReactNode
  emphasized?: boolean
  className?: string
}

export function CardFrame({ children, emphasized = false, className = '' }: CardFrameProps) {
  const baseStyle = 'border-white/12 bg-black/55 shadow-[0_0_18px_rgba(127,229,255,0.08)]'

  // 固定 min-width 让 6 张 PHUD 卡尺寸接近一致（手机桌面 APP 整齐感）
  // emphasized (EtaCard 中央) 稍宽，其他卡同宽，避免 flex 排布参差不齐
  const widthStyle = emphasized ? 'min-w-[170px]' : 'min-w-[150px]'

  return (
    <div
      className={`pointer-events-auto relative overflow-hidden rounded-[10px] border ${baseStyle} ${widthStyle} h-[100px] px-4 py-2.5 backdrop-blur-md ${className}`}
    >
      <div className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-[#7FE5FF]/90 to-transparent" />
      {children}
    </div>
  )
}
