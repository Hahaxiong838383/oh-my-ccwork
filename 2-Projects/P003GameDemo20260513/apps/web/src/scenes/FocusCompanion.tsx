import { FocusToggle } from '../components/FocusToggle';
import { useAppStore, type FocusStage } from '../store/app-store';

const STAGE_IMAGE_MAP: Record<FocusStage, string> = {
  locked: '/art/focus-companion/01-locked.png',
  active: '/art/focus-companion/02-active.png',
  openable: '/art/focus-companion/03-openable.png',
  full: '/art/focus-companion/04-full.png',
};

export function FocusCompanion() {
  const focusStage = useAppStore((s) => s.focusStage);

  return (
    <div className="absolute inset-0 overflow-hidden bg-screen-bg">
      <img
        src={STAGE_IMAGE_MAP[focusStage]}
        alt="静思专注"
        className="h-full w-full object-cover"
        draggable={false}
      />

      <div className="absolute bottom-3 left-4 z-layer-ui-normal">
        <FocusToggle />
      </div>
    </div>
  );
}
