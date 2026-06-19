import { useAppStore } from '../store/app-store';

/**
 * 移动端字幕 —— 读 app-store.subtitle（与工作台同源：ASR 转写 / 电影式整句 cue）。
 * 苹果清新：无卡片、纯文字 + 留白，大字号适配孩子，opacity 过渡不重挂（字幕高频更新）。
 */
export function MobileSubtitle() {
  const subtitle = useAppStore((s) => s.subtitle);
  return (
    <div className="flex min-h-[4.5rem] items-center justify-center px-6 pb-1">
      <p
        className="max-w-[32ch] text-center text-[1.4rem] font-medium leading-snug tracking-tight text-slate-700 transition-opacity duration-200"
        style={{ opacity: subtitle ? 1 : 0 }}
      >
        {subtitle || ' '}
      </p>
    </div>
  );
}
