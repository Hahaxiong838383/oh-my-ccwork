import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import { getSharedVoiceClient } from '../services/voice-client';

const WELCOME_BG = '/assets/welcome-bg.png';
const WELCOME_LINE = '你好，指挥官！欢迎回到方舟';

function getVoiceWsUrl(): string {
  const envUrl = import.meta.env.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/voice`;
}

interface StarSpec {
  id: string;
  left: string;
  top: string;
  size: string;
  delay: string;
  duration: string;
  drift: string;
}

const STARS: readonly StarSpec[] = [
  { id: 's1', left: '14cqw', top: '14cqh', size: '1.1cqw', delay: '-1.2s', duration: '3.4s', drift: '4cqw' },
  { id: 's2', left: '22cqw', top: '24cqh', size: '0.8cqw', delay: '-0.3s', duration: '3.8s', drift: '-3.2cqw' },
  { id: 's3', left: '26cqw', top: '9cqh', size: '1cqw', delay: '-2.0s', duration: '3.1s', drift: '3.5cqw' },
  { id: 's4', left: '72cqw', top: '13cqh', size: '1cqw', delay: '-0.7s', duration: '3.3s', drift: '-3.8cqw' },
  { id: 's5', left: '80cqw', top: '23cqh', size: '0.8cqw', delay: '-2.4s', duration: '3.6s', drift: '3cqw' },
  { id: 's6', left: '86cqw', top: '10cqh', size: '1.1cqw', delay: '-1.5s', duration: '3.0s', drift: '-4cqw' },
];

export function Welcome() {
  const bootState = useAppStore((s) => s.bootState);
  const spokenRef = useRef(false);

  useEffect(() => {
    if (bootState !== 'welcome') {
      spokenRef.current = false;
      return;
    }
    if (spokenRef.current) return;
    spokenRef.current = true;

    const client = getSharedVoiceClient();
    void (async () => {
      try {
        await client.connect(getVoiceWsUrl());
      } catch (err) {
        console.warn('[Welcome] voice ws connect failed', err);
        return;
      }
      // 立即触发：TTS TTFB ~500ms + 首段 flush ~600ms ≈ 1.1s 出声，
      // 与字幕 0.8s 进场动画几乎重叠
      client.sayDirect(WELCOME_LINE);
    })();
  }, [bootState]);

  if (bootState !== 'welcome') return null;

  return (
    <div
      className="absolute inset-0 z-layer-mask overflow-hidden"
      style={{ containerType: 'size', isolation: 'isolate' }}
    >
      <img
        src={WELCOME_BG}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />

      <div
        className="pointer-events-none absolute inset-0"
        style={{
          clipPath: 'ellipse(42% 36% at 50% 32%)',
          WebkitClipPath: 'ellipse(42% 36% at 50% 32%)',
        }}
        aria-hidden
      >
        {STARS.map((star) => {
          const styleVars = {
            '--star-drift': star.drift,
          } as React.CSSProperties;
          return (
            <span
              key={star.id}
              className="absolute rounded-full bg-white"
              style={{
                left: star.left,
                top: star.top,
                width: star.size,
                height: star.size,
                ...styleVars,
                animation: `welcome-star-drift ${star.duration} ease-in-out ${star.delay} infinite both`,
                boxShadow: '0 0 5px rgba(255,255,255,0.85)',
              }}
            />
          );
        })}
      </div>

      <div
        className="welcome-eye-glow pointer-events-none absolute rounded-full"
        style={{
          left: '44cqw',
          top: '34cqh',
          width: '18cqw',
          height: '13cqh',
          background:
            'radial-gradient(ellipse at center, rgba(110,255,170,0.85) 0%, rgba(110,255,170,0.3) 40%, transparent 70%)',
          filter: 'blur(2.4cqh)',
          animation: 'welcome-eye-glow 1.8s ease-in-out infinite',
        }}
        aria-hidden
      />

      <div
        className="absolute left-1/2 flex items-center justify-center rounded-full bg-black/40 px-[5cqw] py-[1.6cqh] backdrop-blur-md"
        style={{
          bottom: '6cqh',
          transform: 'translateX(-50%)',
          maxWidth: 'min(86cqw, 560px)',
        }}
      >
        <p
          className="welcome-caption font-light text-white"
          style={{
            fontSize: 'clamp(12px, 3.4cqw, 18px)',
            letterSpacing: '0.08em',
            whiteSpace: 'nowrap',
          }}
        >
          你好，指挥官！欢迎回到方舟
        </p>
      </div>

      <style>{`
        @keyframes welcome-star-drift {
          0%, 100% { transform: translateX(0) scale(0.65); opacity: 0.25; }
          50% { transform: translateX(var(--star-drift)) scale(1.25); opacity: 1; }
        }
        .welcome-eye-glow {
          mix-blend-mode: screen;
        }
        @supports not (mix-blend-mode: screen) {
          .welcome-eye-glow {
            mix-blend-mode: normal;
            opacity: 0.5;
          }
        }
        @keyframes welcome-eye-glow {
          0%, 100% { opacity: 0.25; transform: scale(0.9); }
          50% { opacity: 0.85; transform: scale(1.12); }
        }
        @keyframes welcome-caption-pulse {
          0%, 100% {
            opacity: 0.82;
            text-shadow: 0 0 6px rgba(255,255,255,0.28), 0 0 14px rgba(255,255,255,0.16);
          }
          50% {
            opacity: 1;
            text-shadow: 0 0 10px rgba(255,255,255,0.55), 0 0 22px rgba(255,240,210,0.32);
          }
        }
        @keyframes welcome-caption-enter {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .welcome-caption {
          animation:
            welcome-caption-enter 0.8s ease-out 0s 1 both,
            welcome-caption-pulse 2.6s ease-in-out 0.8s infinite;
        }
      `}</style>
    </div>
  );
}
