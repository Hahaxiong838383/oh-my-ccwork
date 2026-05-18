import { useEffect, useRef } from 'react';
import { getExpressionSnapshot } from '../services/expression-snapshot';

export function HiddenCameraVideo() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    getExpressionSnapshot().bindVideoElement(videoRef.current);
    return () => {
      getExpressionSnapshot().bindVideoElement(null);
    };
  }, []);

  return (
    <video
      ref={videoRef}
      playsInline
      muted
      autoPlay
      aria-hidden
      tabIndex={-1}
      style={{
        position: 'absolute',
        opacity: 0,
        pointerEvents: 'none',
        width: '1px',
        height: '1px',
      }}
    />
  );
}

