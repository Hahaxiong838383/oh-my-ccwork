import { useAppStore } from '../store/app-store';

export function CameraStatusDot() {
  const cameraUnavailable = useAppStore((s) => s.cameraUnavailable);
  if (cameraUnavailable) return null;

  return (
    <div
      aria-label="摄像头使用中"
      title="摄像头使用中"
      style={{
        position: 'absolute',
        right: '8px',
        bottom: '8px',
        width: '6px',
        height: '6px',
        borderRadius: '9999px',
        background: '#32d74b',
        opacity: 0.6,
        pointerEvents: 'none',
      }}
    />
  );
}

