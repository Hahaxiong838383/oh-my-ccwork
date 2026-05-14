import { useFeedbackQueue } from '../store/feedback-queue';

export function SettingsButton() {
  // 占位反馈：完整 SettingsPanel 是 D4 下午任务，
  // 当前先 pushTip 让按钮有可见反馈，避免演示时"按了无反应"。
  const handleClick = () => {
    useFeedbackQueue.getState().pushTip('设置面板开发中…');
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="设置"
      className="absolute right-3 top-3 z-layer-ui-normal inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white/90 ring-1 ring-white/10 backdrop-blur-sm transition hover:bg-black/60 active:scale-95"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4 fill-none stroke-current"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 3v2.2" />
        <path d="M12 18.8V21" />
        <path d="M3 12h2.2" />
        <path d="M18.8 12H21" />
        <path d="m5.8 5.8 1.6 1.6" />
        <path d="m16.6 16.6 1.6 1.6" />
        <path d="m5.8 18.2 1.6-1.6" />
        <path d="m16.6 7.4 1.6-1.6" />
        <circle cx="12" cy="12" r="3.4" />
      </svg>
    </button>
  );
}
