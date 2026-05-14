import type { ReactNode } from 'react';

export function XiaokeBlink({ children }: { children: ReactNode }) {
  return (
    <div className="relative inline-block" style={{ containerType: 'size' }}>
      {children}

      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <span
          className="absolute rounded-full bg-slate-900/90"
          style={{
            left: '39%',
            top: '32%',
            width: 'clamp(1.2cqh, 1.8cqw, 2.3cqh)',
            height: 'clamp(0.5cqh, 0.8cqw, 1.1cqh)',
            transform: 'translate(-50%, -50%)',
            transformOrigin: 'center center',
            animation: 'xiaoke-eye-blink 4s ease-in-out infinite',
          }}
        />
        <span
          className="absolute rounded-full bg-slate-900/90"
          style={{
            left: '61%',
            top: '32%',
            width: 'clamp(1.2cqh, 1.8cqw, 2.3cqh)',
            height: 'clamp(0.5cqh, 0.8cqw, 1.1cqh)',
            transform: 'translate(-50%, -50%)',
            transformOrigin: 'center center',
            animation: 'xiaoke-eye-blink 4s ease-in-out infinite',
          }}
        />
      </div>

      <style>{`
        @keyframes xiaoke-eye-blink {
          0%, 46%, 100% {
            transform: translate(-50%, -50%) scaleY(1);
          }
          48%, 51.75% {
            transform: translate(-50%, -50%) scaleY(0.05);
          }
          54% {
            transform: translate(-50%, -50%) scaleY(1);
          }
        }
      `}</style>
    </div>
  );
}
