import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import { useTransitionRunner } from '../hooks/useTransitionRunner';

const SETUP_BG = '/assets/setup-bg.png';
const SETUP_SUCCESS_VIDEO = '/assets/setup-success.mp4';

export function SetupGuide() {
  const bootState = useAppStore((s) => s.bootState);
  const videoRequested = useAppStore((s) => s.setupVideoRequested);
  const { dispatchBoot } = useTransitionRunner();
  const finishedRef = useRef(false);

  useEffect(() => {
    if (bootState === 'unconfigured') finishedRef.current = false;
  }, [bootState]);

  if (bootState !== 'unconfigured') return null;

  const handleVideoDone = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const store = useAppStore.getState();
    store.setSetupComplete(true);
    store.setSetupVideoRequested(false);
    dispatchBoot({ type: 'SETUP_DONE' });
  };

  if (videoRequested) {
    return (
      <div
        className="absolute inset-0 z-layer-modal overflow-hidden bg-black"
        style={{ containerType: 'size' }}
      >
        <video
          src={SETUP_SUCCESS_VIDEO}
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          playsInline
          preload="auto"
          onEnded={handleVideoDone}
          onError={handleVideoDone}
        />
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 z-layer-modal overflow-hidden"
      style={{ containerType: 'size' }}
    >
      <img
        src={SETUP_BG}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />

      {/* 字幕条暂时不显示（PNG 自带视觉已足够）
      <div
        className="absolute left-1/2 flex items-center justify-center rounded-md border border-white/60 bg-black/55 px-[5cqw] py-[2.4cqh] text-white backdrop-blur-sm"
        style={{
          bottom: '6cqh',
          width: 'min(88cqw, 580px)',
          transform: 'translateX(-50%)',
          fontSize: 'clamp(13px, 3.8cqw, 20px)',
          letterSpacing: '0.04em',
        }}
      >
        请保持手机接近设备
      </div>
      */}
    </div>
  );
}
