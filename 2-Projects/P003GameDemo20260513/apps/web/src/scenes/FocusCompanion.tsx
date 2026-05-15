import { useEffect, useRef } from 'react';
import { FocusToggle } from '../components/FocusToggle';
import { getSharedVoiceClient } from '../services/voice-client';
import { useStageCrossfade } from '../hooks/useStageCrossfade';
import { useAppStore, type FocusStage } from '../store/app-store';

const STAGE_IMAGE_MAP: Record<FocusStage, string> = {
  locked: '/art/focus-companion/01-locked.png',
  active: '/art/focus-companion/02-active.png',
  openable: '/art/focus-companion/03-openable.png',
  full: '/art/focus-companion/04-full.png',
};
const REWARDING_STATIC_SRC = '/art/focus-companion/04-full.png';
const LAUNCH_TTS_LINE = '慢慢来，深呼吸放松一下。';

function getStageMotionClass(stage: FocusStage): string {
  if (stage === 'locked') return 'fc-motion-locked';
  if (stage === 'active') return 'fc-motion-active';
  if (stage === 'openable') return 'fc-motion-openable';
  return 'fc-motion-full';
}

export function FocusCompanion() {
  const focusMachine = useAppStore((s) => s.focusMachine);
  const focusStage = useAppStore((s) => s.focusStage);
  const launchSpokenRef = useRef(false);
  const { currentSrc, previousSrc, isFading, currentOpacity } = useStageCrossfade(
    focusStage,
    STAGE_IMAGE_MAP,
    {
      fadeDurationMs: 300,
    },
  );

  useEffect(() => {
    if (focusMachine !== 'launching') {
      launchSpokenRef.current = false;
      return;
    }
    if (launchSpokenRef.current) return;
    launchSpokenRef.current = true;
    getSharedVoiceClient().sayDirect(LAUNCH_TTS_LINE);
  }, [focusMachine]);

  if (focusMachine === 'launching') {
    return (
      <div className="absolute inset-0 overflow-hidden bg-screen-bg">
        <img
          src={STAGE_IMAGE_MAP.locked}
          alt="静思启动中"
          className="absolute inset-0 h-full w-full object-cover"
          style={{
            opacity: 0,
            animation: 'fc-launch-fade-in 600ms ease-out forwards',
          }}
          draggable={false}
        />
        <div className="absolute bottom-3 left-4 z-layer-ui-normal">
          <FocusToggle />
        </div>
        <style>{`
          @keyframes fc-launch-fade-in {
            from {
              opacity: 0;
            }
            to {
              opacity: 1;
            }
          }
        `}</style>
      </div>
    );
  }

  if (focusMachine === 'rewarding') {
    return (
      <div className="absolute inset-0 overflow-hidden bg-screen-bg">
        <img
          src={REWARDING_STATIC_SRC}
          alt="静思奖励结算中"
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 overflow-hidden bg-screen-bg">
      <div className={`relative h-full w-full ${getStageMotionClass(focusStage)}`}>
        {previousSrc ? (
          <img
            src={previousSrc}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              opacity: isFading ? 0 : 1,
              transition: 'opacity 300ms ease-in-out',
            }}
            draggable={false}
          />
        ) : null}

        <img
          src={currentSrc}
          alt="静思专注"
          className="absolute inset-0 h-full w-full object-cover"
          style={{
            opacity: currentOpacity,
            transition: 'opacity 300ms ease-in-out',
          }}
          draggable={false}
        />
      </div>

      <div className="absolute bottom-3 left-4 z-layer-ui-normal">
        <FocusToggle />
      </div>

      <style>{`
        .fc-motion-locked,
        .fc-motion-active,
        .fc-motion-openable,
        .fc-motion-full {
          transform-origin: center center;
          will-change: transform, filter;
        }

        .fc-motion-locked {
          animation: fc-lock-shake 4s ease-in-out infinite;
        }

        .fc-motion-active {
          animation: fc-active-breathe 2.5s ease-in-out infinite;
        }

        .fc-motion-openable {
          animation: fc-openable-call 1.4s ease-in-out infinite;
        }

        .fc-motion-full {
          animation: fc-full-call 1s ease-in-out infinite;
        }

        @keyframes fc-lock-shake {
          0%, 70%, 100% {
            transform: rotate(0deg);
          }
          73% {
            transform: rotate(-1.5deg);
          }
          76% {
            transform: rotate(1.5deg);
          }
          79% {
            transform: rotate(-1deg);
          }
          82% {
            transform: rotate(0deg);
          }
        }

        @keyframes fc-active-breathe {
          0%, 100% {
            transform: scale(1);
          }
          50% {
            transform: scale(1.005);
          }
        }

        @keyframes fc-openable-call {
          0%, 100% {
            transform: scale(1);
            filter: brightness(1);
          }
          50% {
            transform: scale(1.025);
            filter: brightness(1.08);
          }
        }

        @keyframes fc-full-call {
          0%, 100% {
            transform: scale(1);
            filter: brightness(1);
          }
          50% {
            transform: scale(1.04);
            filter: brightness(1.15);
          }
        }
      `}</style>
    </div>
  );
}
