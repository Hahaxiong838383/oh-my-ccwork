import { useEffect, useRef, useState } from 'react';
import { FocusToggle } from '../components/FocusToggle';
import { getSharedVoiceClient } from '../services/voice-client';
import { useStageCrossfade } from '../hooks/useStageCrossfade';
import { useAppStore, type FocusMachineState, type FocusStage } from '../store/app-store';

const STAGE_IMAGE_MAP: Record<FocusStage, string> = {
  locked: '/art/focus-running/03-locked.png',
  active: '/art/focus-running/04-active.png',
  openable: '/art/focus-running/06-openable.png',
  full: '/art/focus-running/07-full.png',
};

const ACTIVE_ROTATING_RING_SRC = '/art/focus-running/05-active-rotating.png';
const LAUNCHING_PRIMARY_SRC = '/art/focus-running/01-launching.png';
const LAUNCHING_TRANSITION_SRC = '/art/focus-running/02-transition.png';
const LAUNCH_TTS_LINE = '坐稳啦，我们要出发咯！';

function getStageMotionClass(stage: FocusStage): string {
  if (stage === 'locked') return 'fr-motion-locked';
  if (stage === 'active') return 'fr-motion-active';
  if (stage === 'openable') return 'fr-motion-openable';
  return 'fr-motion-full';
}

function FocusRunningLaunching({ focusMachine }: { focusMachine: FocusMachineState }) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const launchSpokenRef = useRef(false);

  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 16);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (focusMachine !== 'launching') {
      launchSpokenRef.current = false;
      return;
    }
    if (launchSpokenRef.current) return;
    launchSpokenRef.current = true;
    getSharedVoiceClient().sayDirect(LAUNCH_TTS_LINE);
  }, [focusMachine]);

  const showTransition = elapsedMs >= 1_700;
  const transitionOpacity = Math.max(0, Math.min(1, (elapsedMs - 1_700) / 800));

  return (
    <div className="relative h-full w-full overflow-hidden bg-screen-bg">
      <img
        src={LAUNCHING_PRIMARY_SRC}
        alt="出航启动中"
        className="absolute inset-0 h-full w-full object-cover"
        style={{
          opacity: 1 - transitionOpacity,
          animation: showTransition
            ? 'none'
            : 'fr-launch-enter 600ms ease-out both, fr-launch-float 2.2s ease-in-out 600ms infinite',
        }}
        draggable={false}
      />

      <img
        src={LAUNCHING_TRANSITION_SRC}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover"
        style={{
          opacity: transitionOpacity,
          transform: `scale(${1.05 - transitionOpacity * 0.05})`,
          filter: `blur(${4 - transitionOpacity * 4}px)`,
          transition: 'opacity 80ms linear, transform 80ms linear, filter 80ms linear',
        }}
        draggable={false}
      />

      <style>{`
        @keyframes fr-launch-enter {
          from {
            opacity: 0;
            transform: scale(1.05);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }

        @keyframes fr-launch-float {
          0%, 100% {
            transform: translateY(-3px);
            opacity: 0.85;
            filter: brightness(1);
          }
          50% {
            transform: translateY(3px);
            opacity: 1;
            filter: brightness(1.08);
          }
        }
      `}</style>
    </div>
  );
}

export function FocusRunning() {
  const focusMachine = useAppStore((s) => s.focusMachine);
  const focusStage = useAppStore((s) => s.focusStage);
  const { currentSrc, previousSrc, isFading, currentOpacity } = useStageCrossfade(
    focusStage,
    STAGE_IMAGE_MAP,
    {
      alternateEnabled: focusStage === 'active',
      alternateSrc: ACTIVE_ROTATING_RING_SRC,
      alternateIntervalMs: 1_500,
      fadeDurationMs: 300,
    },
  );

  if (focusMachine === 'launching') {
    return (
      <div className="absolute inset-0 overflow-hidden bg-screen-bg">
        <FocusRunningLaunching focusMachine={focusMachine} />
        <div className="absolute bottom-3 left-4 z-layer-ui-normal">
          <FocusToggle />
        </div>
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
          alt="出航专注"
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
        .fr-motion-locked,
        .fr-motion-active,
        .fr-motion-openable,
        .fr-motion-full {
          transform-origin: center center;
          will-change: transform, filter;
        }

        .fr-motion-locked {
          animation: fr-lock-shake 4s ease-in-out infinite;
        }

        .fr-motion-active {
          animation: fr-active-breathe 2.5s ease-in-out infinite;
        }

        .fr-motion-openable {
          animation: fr-openable-call 1.4s ease-in-out infinite;
        }

        .fr-motion-full {
          animation: fr-full-call 1s ease-in-out infinite;
        }

        @keyframes fr-lock-shake {
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

        @keyframes fr-active-breathe {
          0%, 100% {
            transform: scale(1);
          }
          50% {
            transform: scale(1.005);
          }
        }

        @keyframes fr-openable-call {
          0%, 100% {
            transform: scale(1);
            filter: brightness(1);
          }
          50% {
            transform: scale(1.025);
            filter: brightness(1.08);
          }
        }

        @keyframes fr-full-call {
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
