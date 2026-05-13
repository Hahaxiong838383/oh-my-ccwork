import { useAppStore } from '../store/app-store';

export function FocusControl() {
  const focusState = useAppStore((s) => s.focusState);
  const setFocusState = useAppStore((s) => s.setFocusState);

  const focusing = focusState === 'focusing';

  return (
    <button
      onClick={() => setFocusState(focusing ? 'idle' : 'focusing')}
      className={[
        'w-full rounded-full py-4 text-base font-medium transition-transform active:scale-95',
        focusing
          ? 'bg-white/10 text-white/80 border border-porthole-glow/40'
          : 'bg-porthole-glow text-porthole-bg shadow-[0_0_30px_rgba(79,209,255,0.4)]',
      ].join(' ')}
    >
      {focusing ? '退出专注（开箱）' : '开始专注'}
    </button>
  );
}
