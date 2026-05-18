import { useEffect, useRef } from 'react';
import { getExpressionSnapshot } from '../services/expression-snapshot';
import { useAppStore } from '../store/app-store';

export function HiddenCameraVideo() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraPreview = useAppStore((s) => s.cameraPreview);

  useEffect(() => {
    getExpressionSnapshot().bindVideoElement(videoRef.current);
    return () => {
      getExpressionSnapshot().bindVideoElement(null);
    };
  }, []);

  // D6 P1 hotfix：iOS Safari 对 1x1 离屏 video 可能不解码帧，导致 canvas
  // drawImage 全黑 → Gemini 识别 no_face。给一个合规的最小可见尺寸（160×120
  // 角落小预览，DEV 默认开），保证 video 实际渲染帧。
  const visible = cameraPreview;
  return (
    <video
      ref={videoRef}
      playsInline
      muted
      autoPlay
      aria-hidden
      tabIndex={-1}
      style={
        visible
          ? {
              position: 'absolute',
              bottom: '8px',
              left: '8px',
              width: '160px',
              height: '120px',
              objectFit: 'cover',
              border: '1px solid rgba(255,255,255,0.5)',
              borderRadius: '4px',
              zIndex: 9999,
              pointerEvents: 'none',
            }
          : {
              // 仍离屏但**不**用 1×1（iOS Safari 对超小 video 会停帧解码）
              // 改成 160×120 全透明，保证帧持续解码
              position: 'absolute',
              top: '-9999px',
              left: '-9999px',
              opacity: 0,
              pointerEvents: 'none',
              width: '160px',
              height: '120px',
            }
      }
    />
  );
}

