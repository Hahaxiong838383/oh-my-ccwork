import type { CSSProperties } from 'react';
import { useAppStore } from '../store/app-store';

interface XiaokeProps {}

const EMOTION_STYLE: Record<string, string> = {
  happy: 'ring-newbie-gold/70 shadow-[0_0_28px_rgba(255,215,0,0.55)]',
  curious: 'ring-newbie-blue/70 shadow-[0_0_28px_rgba(95,179,255,0.5)]',
  warm: 'ring-xiaoke-accent/70 shadow-[0_0_28px_rgba(255,138,101,0.5)]',
  calm: 'ring-cyan-300/70 shadow-[0_0_28px_rgba(103,232,249,0.45)]',
  excited: 'ring-newbie-gold shadow-[0_0_44px_rgba(255,215,0,0.85)]',
};

export function Xiaoke(_props: XiaokeProps) {
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const emotion = useAppStore((s) => s.xiaokeEmotion);

  const animatedStyle: CSSProperties | undefined =
    emotion === 'excited' ? { animationDuration: '1.6s' } : undefined;

  return (
    <div className="relative z-layer-char flex items-center justify-center">
      {voiceStatus === 'speaking' && (
        <>
          <span className="absolute inset-[-10px] rounded-full border border-newbie-gold/45 animate-ping" />
          <span
            className="absolute inset-[-18px] rounded-full border border-newbie-blue/35"
            style={{ animation: 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite' }}
          />
        </>
      )}

      {voiceStatus === 'thinking' && (
        <div className="absolute -top-6 left-1/2 flex -translate-x-1/2 items-end gap-1">
          {[0, 1, 2].map((item) => (
            <span
              key={`think-dot-${item}`}
              className="h-2 w-2 rounded-full bg-white/80"
              style={{ animation: `xiaoke-think-pop 1.05s ease-in-out ${item * 0.18}s infinite` }}
            />
          ))}
        </div>
      )}

      <div
        className={`relative h-20 w-20 rounded-full bg-gradient-to-br from-xiaoke-primary to-xiaoke-accent ring-2 animate-xiaoke-breathe ${
          EMOTION_STYLE[emotion]
        }`}
        style={animatedStyle}
      />

      <style>{`
        @keyframes xiaoke-think-pop {
          0%, 100% {
            transform: translateY(0);
            opacity: 0.35;
          }
          50% {
            transform: translateY(-6px);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}
