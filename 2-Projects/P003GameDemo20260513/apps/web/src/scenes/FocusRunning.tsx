import { FocusToggle } from '../components/FocusToggle';
import { useAppStore, type FocusStage } from '../store/app-store';

const STAGE_IMAGE_MAP: Record<FocusStage, string> = {
  locked: '/art/focus-running/03-locked.png',
  active: '/art/focus-running/04-active.png',
  openable: '/art/focus-running/06-openable.png',
  full: '/art/focus-running/07-full.png',
};

export function FocusRunning() {
  const focusStage = useAppStore((s) => s.focusStage);

  return (
    <div className="absolute inset-0 overflow-hidden bg-screen-bg">
      <img
        src={STAGE_IMAGE_MAP[focusStage]}
        alt="出航专注"
        className="h-full w-full object-cover"
        draggable={false}
      />

      <div className="absolute bottom-3 left-4 z-layer-ui-normal">
        <FocusToggle />
      </div>
    </div>
  );
}
