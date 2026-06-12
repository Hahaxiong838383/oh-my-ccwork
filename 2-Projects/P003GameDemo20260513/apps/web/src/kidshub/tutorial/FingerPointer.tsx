/**
 * FingerPointer — 黄色卡通小手引路动画（纯内联 SVG + CSS keyframes）
 * - tap：指尖朝上，上下轻点循环（指向控件右下角）
 * - swipe-down：+白色下箭头，从上往下滑动循环（open-panel 提示）
 * - swipe-up：向上滑动变体（close-panel 提示）
 * 黄色 #FFD43B + 白色描边，孩子友好卡通风。
 */
export function FingerPointer({ variant }: { variant: 'tap' | 'swipe-down' | 'swipe-up' }) {
  const isSwipe = variant === 'swipe-down' || variant === 'swipe-up';

  return (
    <div
      className="pointer-events-none select-none"
      style={{
        animation: isSwipe
          ? `fingerSwipe${variant === 'swipe-down' ? 'Down' : 'Up'} 1350ms infinite ease-in-out`
          : 'fingerTap 1100ms infinite ease-in-out',
      }}
    >
      {/* 手掌+食指 SVG */}
      <svg
        width="38"
        height="44"
        viewBox="0 0 38 44"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ transform: variant === 'swipe-up' ? 'rotate(180deg)' : undefined }}
      >
        {/* 手掌圆润底 */}
        <ellipse
          cx="19"
          cy="30"
          rx="10"
          ry="8.5"
          fill="#FFD43B"
          stroke="#fff"
          strokeWidth="2.8"
          strokeLinejoin="round"
        />
        {/* 食指（直指） */}
        <rect
          x="15.5"
          y="4"
          width="7"
          height="22"
          rx="3.2"
          fill="#FFD43B"
          stroke="#fff"
          strokeWidth="2.4"
        />
        {/* 拇指一侧 */}
        <ellipse
          cx="9.5"
          cy="26"
          rx="3.2"
          ry="5.5"
          fill="#FFD43B"
          stroke="#fff"
          strokeWidth="1.8"
          transform="rotate(-28 9.5 26)"
        />
        {/* 其余三指并拢暗示 */}
        <rect x="23.5" y="19" width="4.2" height="8.5" rx="2" fill="#FFD43B" stroke="#fff" strokeWidth="1.6" />
        <rect x="27.8" y="21" width="3.6" height="6.5" rx="1.6" fill="#FFD43B" stroke="#fff" strokeWidth="1.4" />
      </svg>

      {/* swipe 专用白色方向箭头 */}
      {isSwipe && (
        <div
          className="absolute left-1/2 -translate-x-1/2 text-white/90"
          style={{
            top: variant === 'swipe-down' ? '38px' : '-6px',
            transform: variant === 'swipe-up' ? 'rotate(180deg)' : undefined,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M7 2v8.5M3.2 7.8L7 11.6l3.8-3.8"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}

      <style>{`
        @keyframes fingerTap {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-5.5px); }
        }
        @keyframes fingerSwipeDown {
          0% { transform: translateY(-14px); opacity: .85; }
          45% { transform: translateY(11px); opacity: .95; }
          70% { transform: translateY(11px); opacity: .75; }
          100% { transform: translateY(-14px); opacity: .85; }
        }
        @keyframes fingerSwipeUp {
          0% { transform: translateY(11px); opacity: .85; }
          45% { transform: translateY(-14px); opacity: .95; }
          70% { transform: translateY(-14px); opacity: .75; }
          100% { transform: translateY(11px); opacity: .85; }
        }
      `}</style>
    </div>
  );
}
